// 模型伪装工具（08-27-disguised-mapping）：出站响应统一伪装层。
// 客户请求内部模型名（如 claude-sonnet-5）→ 网关转发上游模型名（如 deepseek-v4-pro，
// 请求侧别名见 providers.models）→ 响应侧所有输出位置的模型名回写为请求内部名：
//   - 非流式 JSON 响应顶层 model 字段（OpenAI chat.completion / Anthropic message 两种形态）
//   - 流式 SSE 帧的 model 字段（OpenAI chunk 顶层 + Anthropic message_start.message.model）
//   - 错误消息文本中的上游模型名（精确字符串替换）
// 恒等映射（models[model] === model）时所有函数为无副作用恒等变换（零回归）；
// maskModelInStream 恒等时字节级透传（R2.3，零 decode/encode/parse）。
import { splitNextFrame } from "../providers/sse-pipe";

/** 错误消息文本替换：上游模型名 → 请求内部名（split/join 避免正则特殊字符问题；
 * 恒等映射短路返回原串）。 */
export function maskModelInErrorMessage(
  message: string,
  requestModel: string,
  upstreamModel: string,
): string {
  if (upstreamModel === requestModel || upstreamModel.length === 0) {
    return message;
  }
  return message.split(upstreamModel).join(requestModel);
}

/**
 * 非流式 JSON 对象层伪装（就地浅拷贝，纯函数）：
 *   1. 顶层 `model` 字符串 → 回写请求内部名（OpenAI 与 Anthropic 两种出站形态都在顶层）。
 *   2. Anthropic 出站流式事件 `message_start.message.model` → 回写（流式帧复用本函数）。
 *   3. Responses SSE 帧 `response.model`（model 嵌套在 response 对象下，H4：response.created/
 *      response.completed 等所有 `response.*` 事件都携带；此前只改顶层 → 流式泄漏上游真实 id，
 *      客户端回传导致 404）。
 *   4. 顶层 `error.message` 字符串 → 上游模型名文本替换。
 * 无变化时返回原引用（调用方据此跳过字节重写）；非对象/无 model 字段不伪造。
 */
export function maskModelInData(
  data: unknown,
  requestModel: string,
  upstreamModel: string,
): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }
  const obj = data as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = { ...obj };

  if (typeof out["model"] === "string" && out["model"] !== requestModel) {
    out["model"] = requestModel;
    changed = true;
  }

  const inner = out["message"];
  if (
    out["type"] === "message_start" &&
    inner !== null &&
    typeof inner === "object" &&
    !Array.isArray(inner)
  ) {
    const msg = inner as Record<string, unknown>;
    if (typeof msg["model"] === "string" && msg["model"] !== requestModel) {
      out["message"] = { ...msg, model: requestModel };
      changed = true;
    }
  }

  // H4：Responses SSE 帧 —— model 在 `response` 对象内（response.created/completed 等
  // 所有 `response.*` 事件）；内层对象不可变拷贝（恒等判断走 changed 标志）
  const resp = out["response"];
  if (
    typeof out["type"] === "string" &&
    out["type"].startsWith("response.") &&
    resp !== null &&
    typeof resp === "object" &&
    !Array.isArray(resp)
  ) {
    const r = resp as Record<string, unknown>;
    if (typeof r["model"] === "string" && r["model"] !== requestModel) {
      out["response"] = { ...r, model: requestModel };
      changed = true;
    }
  }

  const err = out["error"];
  if (err !== null && typeof err === "object" && !Array.isArray(err)) {
    const e = err as Record<string, unknown>;
    if (typeof e["message"] === "string") {
      const masked = maskModelInErrorMessage(e["message"], requestModel, upstreamModel);
      if (masked !== e["message"]) {
        out["error"] = { ...e, message: masked };
        changed = true;
      }
    }
  }

  return changed ? out : data;
}

/** 单帧重写：仅处理 `data:` 行的 JSON payload（其余行字节不变）；非 JSON data 原样。 */
function rewriteFrame(
  frame: string,
  requestModel: string,
  upstreamModel: string,
): string {
  if (!frame.includes("data:")) {
    return frame;
  }
  return frame
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      // 保留原行 `data:` 后分隔风格（可选单空格）与行尾 \r，仅替换 JSON 值
      const raw = line.slice(5);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      const trimmed = value.replace(/\r$/, "");
      // [DONE] 与空 data 非 JSON：原样透传
      if (trimmed.length === 0 || trimmed === "[DONE]") {
        return line;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return line; // ping 等非 JSON data：不破坏
      }
      const masked = maskModelInData(parsed, requestModel, upstreamModel);
      if (masked === parsed) {
        return line; // 无变化：字节级原样
      }
      return `data:${raw.replace(trimmed, JSON.stringify(masked))}`;
    })
    .join("\n");
}

/**
 * 流式 SSE 帧重写：按空行分帧（LF `\n\n` 与 CRLF `\r\n\r\n` 分隔符都识别，复用公共
 * splitNextFrame 最早边界语义 —— OpenAI 透传路径是上游原始字节，部分上游/代理以
 * \r\n 结尾），逐帧调用 maskModelInData。帧结构/顺序/终止语义不变（[DONE]、
 * message_stop 由内层转换器负责，本层只替换字段值；分隔符原字节保留，不归一化换行）。
 * 恒等映射（upstreamModel === requestModel）→ 直接返回输入流（字节级透传，R2.3）。
 * 注意：空 upstreamModel 不短路（回写语义保留，见 maskModelInErrorMessage 的空串特例）。
 */
export function maskModelInStream(
  body: ReadableStream<Uint8Array>,
  requestModel: string,
  upstreamModel: string,
): ReadableStream<Uint8Array> {
  if (upstreamModel === requestModel) {
    return body;
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  // H12：reader 提升到构造作用域（cancel 钩子需访问；输入流为新构造流，无已锁定竞态）
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let errored = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          // 取最早的分帧边界（LF/CRLF 分隔符互不包含，取 min 即确定；缓冲不足时留在 buffer）
          for (;;) {
            const frame = splitNextFrame(buffer);
            if (frame === null) {
              break;
            }
            buffer = frame.rest;
            controller.enqueue(
              encoder.encode(
                `${rewriteFrame(frame.block, requestModel, upstreamModel)}${frame.sep}`,
              ),
            );
          }
        }
        if (buffer.length > 0) {
          controller.enqueue(
            encoder.encode(rewriteFrame(buffer, requestModel, upstreamModel)),
          );
        }
      } catch (error) {
        errored = true;
        controller.error(error);
      } finally {
        reader.releaseLock();
        if (!errored) {
          controller.close();
        }
      }
    },
    // H12：cancel 传播 —— 客户端断开后释放输入流 reader（通常是 wrapStreamWithSettlement
    // 的输出），沿链上溯直至 sse-pipe 释放上游 HTTP body；断开后不再拉流缓冲剩余响应。
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}
