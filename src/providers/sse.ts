// SSE 解析工具（供 Anthropic 流式转换使用）。
// 输入：上游 text/event-stream 字节流；输出：逐事件 yield { event, data(已 JSON.parse) }。

export interface SseEvent {
  event: string;
  data: unknown;
}

/** 解析一个事件块（多个 data: 行按 SSE 规范用 \n 连接）。 */
function parseEventBlock(block: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // 注释行（: ...）与空行忽略
  }
  return { event, data: dataLines.join("\n") };
}

/**
 * 将 SSE 字节流解析为事件流。
 * data 非 JSON 时抛出（上游格式异常）；调用方决定是否中断。
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
      // 归一化 CRLF（部分上游/代理以 \r\n 结尾），保证跨 chunk 的事件切分一致
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      // SSE 事件以空行分隔；可能跨 chunk，循环切分
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const trimmed = block.trim();
        if (trimmed.length > 0) {
          yield toSseEvent(parseEventBlock(trimmed));
        }
        index = buffer.indexOf("\n\n");
      }
    }
    const remaining = buffer.trim();
    if (remaining.length > 0) {
      yield toSseEvent(parseEventBlock(remaining));
    }
  } finally {
    reader.releaseLock();
  }
}

function toSseEvent(parsed: { event: string; data: string }): SseEvent {
  if (parsed.data.length === 0 || parsed.data === "[DONE]") {
    // 空 data 事件与 OpenAI 风格 `data: [DONE]` 终止符统一为 null data（非 JSON，不可 parse）
    return { event: parsed.event, data: null };
  }
  return { event: parsed.event, data: JSON.parse(parsed.data) };
}
