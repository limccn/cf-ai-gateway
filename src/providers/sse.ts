// SSE 解析工具（供 Anthropic 流式转换使用）。
// 输入：上游 text/event-stream 字节流；输出：逐事件 yield { event, data(已 JSON.parse) }。
// 帧切分复用 sse-pipe 的公共 splitNextFrame（LF/CRLF 双分隔，语义一致）；
// data 非 JSON 时抛出（严格模式，与重构前一致）；调用方决定是否中断。

import { parseFrameBlock, splitNextFrame, type SseEvent } from "./sse-pipe";

export type { SseEvent } from "./sse-pipe";

/**
 * 将 SSE 字节流解析为事件流。
 * data 非 JSON 时抛出（上游格式异常，严格模式）；调用方决定是否中断。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔；可能跨 chunk，循环切分
      for (;;) {
        const frame = splitNextFrame(buffer);
        if (frame === null) {
          break;
        }
        buffer = frame.rest;
        const trimmed = frame.block.trim();
        if (trimmed.length > 0) {
          yield parseFrameBlock(trimmed, { strict: true });
        }
      }
    }
    const remaining = buffer.trim();
    if (remaining.length > 0) {
      yield parseFrameBlock(remaining, { strict: true });
    }
  } finally {
    reader.releaseLock();
  }
}
