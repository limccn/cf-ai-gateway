// 流式结算（M4 4.2 + 08-31-1102 R1/R2.4）：事件级 usage 检测——挂统一 SsePipe 的
// onEvent 旁路，每帧恰好一次（O(1)/帧、零字节累积，替代旧的全量重扫 O(n²)）；
// 流正常结束 / 异常中断 / 客户端取消后 settle 恰好一次（幂等）。
// 适配器转换层（openai 透传 / anthropic 合成）都会在末尾产出携带 usage 的事件，
// 因此从事件流中解析即可；Anthropic 原生路径（P2a 短路）由
// message_start 的 input_tokens + message_delta 的 output_tokens 合成。
import type { Logger } from "./logger";
import type { TokenUsage } from "../providers/types";
import { parseOpenAiUsage } from "../providers/openai";
import {
  pipeSseStream,
  type SseEvent,
  type SseFrameTransform,
} from "../providers/sse-pipe";

export interface StreamUsageDetector {
  /** 逐事件喂入；返回非 null 即检测到完整用量（持续取最新——多块流 output_tokens 为累计值）。 */
  feed(event: SseEvent): TokenUsage | null;
  /**
   * 取消路径快照（U2）：流未完成（无完整 usage 事件）时按**已观测部分**返回——
   * anthropic 路径 message_start 已知 input_tokens → 至少收 prompt 成本。
   * 无任何观测返回 null。
   */
  snapshot?(): TokenUsage | null;
}

/** OpenAI 形态：事件 data 携带顶层 `usage`（透传路径尾包 / anthropic 合成 chunk；含 cached_tokens）。 */
export function createOpenAiUsageDetector(): StreamUsageDetector {
  return { feed: (event) => parseOpenAiUsage(event.data) };
}

/**
 * Anthropic 原生形态：message_start 的 `message.usage.input_tokens`（+ cache_read_input_tokens）
 * 与 message_delta 的 `usage.output_tokens` 合成；两部分齐备后才返回非 null。
 */
export function createAnthropicUsageDetector(): StreamUsageDetector {
  let promptTokens: number | null = null;
  let cachedTokens = 0;
  let completionTokens: number | null = null;
  return {
    feed(event: SseEvent): TokenUsage | null {
      if (typeof event.data !== "object" || event.data === null) {
        return null;
      }
      const body = event.data as Record<string, unknown>;
      if (body["type"] === "message_start") {
        const message = body["message"];
        if (message !== null && typeof message === "object") {
          const usage = (message as Record<string, unknown>)["usage"];
          if (usage !== null && typeof usage === "object") {
            const u = usage as Record<string, unknown>;
            if (typeof u["input_tokens"] === "number") {
              promptTokens = u["input_tokens"];
            }
            // H8：cache_read 与 cache_creation 都按缓存价计（上游同价），求和
            if (typeof u["cache_read_input_tokens"] === "number") {
              cachedTokens = u["cache_read_input_tokens"];
            }
            if (typeof u["cache_creation_input_tokens"] === "number") {
              cachedTokens += u["cache_creation_input_tokens"];
            }
          }
        }
      } else if (body["type"] === "message_delta") {
        // U1：output_tokens 是**累计值**（多块流——thinking+text/工具调用——每块停止都发一个
        // delta）；只取第一个会把计费定在首个块（如仅 thinking 部分）→ 持续取最新。
        const usage = body["usage"];
        if (usage !== null && typeof usage === "object") {
          const output = (usage as Record<string, unknown>)["output_tokens"];
          if (typeof output === "number") {
            completionTokens = output;
          }
        }
      }
      if (promptTokens !== null && completionTokens !== null) {
        return {
          promptTokens,
          completionTokens,
          ...(cachedTokens > 0 ? { cachedTokens } : {}),
        };
      }
      return null;
    },
    // U2：cancel 时按已观测部分结算（message_start 已知 input_tokens → 至少收 prompt 成本）
    snapshot(): TokenUsage | null {
      if (promptTokens === null) {
        return null;
      }
      return {
        promptTokens,
        completionTokens: completionTokens ?? 0,
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
      };
    },
  };
}

export interface SettlementOptions {
  /** usage 检测器（缺省 = OpenAI 形态）。 */
  detector?: StreamUsageDetector;
  /** 事件消费转换（协议转换路径；缺省 = 原始字节透传）。 */
  transform?: SseFrameTransform;
  /** 流空闲超时（ms，U7）：透传 SsePipe（每 chunk 重置；缺省 = 无超时）。 */
  idleTimeoutMs?: number;
}

/**
 * 包装输入流（统一 SsePipe）：onEvent 旁路逐帧检测 usage（首次非 null 生效），
 * 流正常结束 / 异常中断 / 客户端取消后均调用 settle 一次（幂等）。
 * 结算失败只记录日志，不影响已转发的 SSE 内容。
 */
export function wrapStreamWithSettlement(
  input: ReadableStream<Uint8Array>,
  settle: (usage: TokenUsage | null) => Promise<void>,
  logger: Logger,
  options: SettlementOptions = {},
): ReadableStream<Uint8Array> {
  const detector = options.detector ?? createOpenAiUsageDetector();
  let detected: TokenUsage | null = null;
  let settled = false;

  async function runSettle(): Promise<void> {
    if (settled) {
      return;
    }
    settled = true;
    try {
      // U2：无完整 usage 事件（cancel/中断）→ 检测器快照（已观测部分）兜底；
      // 仍无观测 → null（免计，消费者按价格判定）
      await settle(detected ?? detector.snapshot?.() ?? null);
    } catch (error) {
      if (error instanceof Error) {
        logger.error("stream_settle_failed", { error: error.message });
      } else {
        logger.error("stream_settle_failed", {});
      }
    }
  }

  return pipeSseStream(input, {
    onEvent: (event) => {
      // U1：持续取最新检测结果（多块流 output_tokens 为累计值，首个 delta 是部分块）
      detected = detector.feed(event) ?? detected;
    },
    transform: options.transform,
    idleTimeoutMs: options.idleTimeoutMs,
    onTerminate: async (kind, detail) => {
      await runSettle();
      if (kind === "cancel") {
        logger.warn("stream_cancelled", { reason: String(detail) });
      }
    },
  });
}
