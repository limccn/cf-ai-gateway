// 流式结算（M4 4.2）：包装 SSE 输出流，尾包 usage 到达后结算；流结束仍未获得 usage 时
// 按策略处理（默认免计，由 settle 回调实现方决定）。
// 适配器转换层（openai 透传 / anthropic 合成）都会在末尾产出 OpenAI 形态 usage 尾包，
// 因此从转发字节中解析 `data: {...usage...}` 即可。
import type { Logger } from "./logger";
import type { TokenUsage } from "../providers/types";

/** 从累积的 SSE 文本中提取首个完整 usage 尾包（OpenAI 形态 `usage:{prompt_tokens,completion_tokens}`）。 */
export function extractStreamUsage(buffer: string): TokenUsage | null {
  const blocks = buffer.split("\n\n");
  for (const block of blocks) {
    let data: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        data = line.slice(5).trim();
        break;
      }
    }
    if (data === null || data === "" || data === "[DONE]") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      continue; // 半截 JSON，等后续 chunk 拼全
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const usage = (parsed as Record<string, unknown>)["usage"];
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const u = usage as Record<string, unknown>;
    const prompt = u["prompt_tokens"];
    const completion = u["completion_tokens"];
    if (typeof prompt === "number" && typeof completion === "number") {
      return { promptTokens: prompt, completionTokens: completion };
    }
  }
  return null;
}

/**
 * 包装输入流：逐 chunk 转发，同时累积文本解析 usage 尾包；
 * 流正常结束 / 异常中断 / 客户端取消后均调用 settle 一次（幂等）。
 * 结算失败只记录日志，不影响已转发的 SSE 内容。
 */
export function wrapStreamWithSettlement(
  input: ReadableStream<Uint8Array>,
  settle: (usage: TokenUsage | null) => Promise<void>,
  logger: Logger,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let detected: TokenUsage | null = null;
  let settled = false;

  async function runSettle(): Promise<void> {
    if (settled) {
      return;
    }
    settled = true;
    try {
      await settle(detected);
    } catch (error) {
      if (error instanceof Error) {
        logger.error("stream_settle_failed", { error: error.message });
      } else {
        logger.error("stream_settle_failed", {});
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = input.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          if (detected === null) {
            buffer += decoder.decode(result.value, { stream: true });
            detected = extractStreamUsage(buffer);
          }
          controller.enqueue(result.value);
        }
        await runSettle();
        controller.close();
      } catch (error) {
        // 客户端断开/上游流中途错误：按已产生 usage 结算
        await runSettle();
        try {
          controller.error(error);
        } catch {
          // 流已取消，忽略
        }
      }
    },
    async cancel(reason) {
      await runSettle();
      logger.warn("stream_cancelled", { reason: String(reason) });
    },
  });
}
