// maskModelInStream 纯函数定位测试（disguise OOM 排查）：
// 不经过 worker 管线，直接喂 SSE 字节流断言输出，定位死循环/OOM 是否在重写器内。
import { describe, expect, it } from "vitest";
import {
  maskModelInData,
  maskModelInErrorMessage,
  maskModelInStream,
} from "../src/lib/model-mask";

const REQUEST = "claude-sonnet-5";
const UPSTREAM = "deepseek-v4-pro";

function bytes(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(s));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

describe("maskModelInErrorMessage", () => {
  it("替换上游模型名", () => {
    expect(maskModelInErrorMessage(`Model '${UPSTREAM}' missing`, REQUEST, UPSTREAM)).toBe(
      `Model '${REQUEST}' missing`,
    );
  });
  it("恒等短路原样", () => {
    expect(maskModelInErrorMessage("boom", "x", "x")).toBe("boom");
  });
});

describe("maskModelInData", () => {
  it("顶层 model 回写", () => {
    const out = maskModelInData({ model: "deepseek-chat", choices: [] }, REQUEST, UPSTREAM);
    expect((out as { model: string }).model).toBe(REQUEST);
  });
  it("无 model 不伪造", () => {
    const src = { choices: [] };
    expect(maskModelInData(src, REQUEST, UPSTREAM)).toBe(src);
  });
  it("message_start.message.model 回写", () => {
    const out = maskModelInData(
      { type: "message_start", message: { model: "deepseek-chat" } },
      REQUEST,
      UPSTREAM,
    );
    expect((out as { message: { model: string } }).message.model).toBe(REQUEST);
  });
  it("error.message 文本替换", () => {
    const out = maskModelInData(
      { error: { message: `up ${UPSTREAM} down` } },
      REQUEST,
      UPSTREAM,
    );
    expect((out as { error: { message: string } }).error.message).toBe(
      `up ${REQUEST} down`,
    );
  });
});

describe("maskModelInStream", () => {
  it("OpenAI SSE：model 回写 + [DONE] 保留", async () => {
    const sse = [
      `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}`,
      `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const out = await readAll(maskModelInStream(bytes(sse), REQUEST, UPSTREAM));
    expect(out).toContain(`"model":"${REQUEST}"`);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain("data: [DONE]");
  });

  it("Anthropic 出站 SSE：message_start 回写，其余事件原样", async () => {
    const sse = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"deepseek-chat","stop_reason":null,"usage":{"input_tokens":1}}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n") + "\n\n";
    const out = await readAll(maskModelInStream(bytes(sse), REQUEST, UPSTREAM));
    expect(out).toContain(`"model":"${REQUEST}"`);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain("event: content_block_delta");
    expect(out).toContain("event: message_stop");
  });

  it("跨 chunk 分帧：帧切分在数据边界", async () => {
    const sse =
      `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\n\n` +
      `data: [DONE]\n\n`;
    // 逐字节喂（每 3 字节一个 chunk），考验缓冲切分
    const source = bytes(sse);
    const split: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = source.getReader();
        const encoder = new TextEncoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const text = new TextDecoder().decode(value);
          for (let i = 0; i < text.length; i += 3) {
            controller.enqueue(encoder.encode(text.slice(i, i + 3)));
          }
        }
        controller.close();
      },
    });
    const out = await readAll(maskModelInStream(split, REQUEST, UPSTREAM));
    expect(out).toContain(`"model":"${REQUEST}"`);
    expect(out).toContain("data: [DONE]");
  });

  it("CRLF 分隔符帧：切分正确、model 回写、分隔符字节保留、流式即时发出", async () => {
    const sse =
      `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    const out = await readAll(maskModelInStream(bytes(sse), REQUEST, UPSTREAM));
    expect(out).toContain(`"model":"${REQUEST}"`);
    expect(out).not.toContain("deepseek-chat");
    expect(out).toContain("data: [DONE]\r\n\r\n"); // 分隔符原字节保留（不归一化换行）
  });

  it("恒等映射短路（R2.3）：直接返回输入流对象（零 decode/encode/parse）", () => {
    const source = bytes(`data: {"model":"claude-sonnet-5","choices":[]}\n\ndata: [DONE]\n\n`);
    // 同一模型名 → 返回原流引用（不创建新流、不消费）
    expect(maskModelInStream(source, "claude-sonnet-5", "claude-sonnet-5")).toBe(source);
  });

  it("恒等映射：字节与输入完全一致（含 CRLF 分隔符）", async () => {
    const sse =
      `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    const out = await readAll(maskModelInStream(bytes(sse), "m", "m"));
    expect(out).toBe(sse);
  });

  it("空 upstream 模型名不短路（回写语义保留）", async () => {
    const sse =
      `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[]}\n\n` +
      `data: [DONE]\n\n`;
    const out = await readAll(maskModelInStream(bytes(sse), REQUEST, ""));
    expect(out).toContain(`"model":"${REQUEST}"`);
    expect(out).not.toContain("deepseek-chat");
  });

  it("CRLF 分隔符跨 chunk 切分：分帧边界识别不依赖缓冲边界", async () => {
    const sse =
      `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"deepseek-chat","choices":[]}\r\n\r\n` +
      `data: [DONE]\r\n\r\n`;
    // 把第一个分隔符 \r\n\r\n 拆到两个 chunk 里（前 chunk 止于 \r\n）
    const head = sse.indexOf("\r\n\r\n") + 2;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(sse.slice(0, head)));
        controller.enqueue(encoder.encode(sse.slice(head)));
        controller.close();
      },
    });
    const out = await readAll(maskModelInStream(source, REQUEST, UPSTREAM));
    expect(out).toContain(`"model":"${REQUEST}"`);
    expect(out).toContain("data: [DONE]");
  });
});
