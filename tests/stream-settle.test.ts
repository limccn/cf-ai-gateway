// 统一帧层（splitNextFrame / parseFrameBlock）+ 事件级 settle 单测（08-31-1102 R1/R2.4）：
// - 帧切分（LF/CRLF 双分隔、跨 chunk、空块不产生事件）
// - 提取器（OpenAI 尾包 / Anthropic 合成）
// - settle 4 条结束路径（正常 / 异常 / cancel / 无 usage）恰好一次、幂等
// - 透传字节原样（零重编码）；feed 按帧计（无全量重扫）
import { describe, expect, it, vi } from "vitest";
import {
  createAnthropicUsageDetector,
  createOpenAiUsageDetector,
  wrapStreamWithSettlement,
} from "../src/lib/stream-settle";
import { parseFrameBlock, splitNextFrame } from "../src/providers/sse-pipe";
import type { Logger } from "../src/lib/logger";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

/** 把文本按 n 字节拆成多个 chunk 喂出（考验缓冲跨 chunk 切分）。 */
function splitChunks(s: string, n: number): ReadableStream<Uint8Array> {
  const source = bytes(s);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = decoder.decode(value);
        for (let i = 0; i < text.length; i += n) {
          controller.enqueue(encoder.encode(text.slice(i, i + n)));
        }
      }
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
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

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const CHUNK_A = `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"a"},"finish_reason":null}]}`;
const USAGE_FRAME = `data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}`;
const DONE = "data: [DONE]";

describe("splitNextFrame", () => {
  it("LF 分隔：块 + 分隔符原字节 + 余下缓冲", () => {
    expect(splitNextFrame("data: a\n\n data: b")).toEqual({
      block: "data: a",
      sep: "\n\n",
      rest: " data: b",
    });
  });
  it("CRLF 分隔", () => {
    expect(splitNextFrame("data: a\r\n\r\ndata: b")).toEqual({
      block: "data: a",
      sep: "\r\n\r\n",
      rest: "data: b",
    });
  });
  it("混合分隔取最早边界", () => {
    expect(splitNextFrame("a\n\nb\r\n\r\nc")).toEqual({
      block: "a",
      sep: "\n\n",
      rest: "b\r\n\r\nc",
    });
    expect(splitNextFrame("a\r\n\r\nb\n\nc")).toEqual({
      block: "a",
      sep: "\r\n\r\n",
      rest: "b\n\nc",
    });
  });
  it("缓冲不足（无完整帧）→ null", () => {
    expect(splitNextFrame("data: half")).toBeNull();
    expect(splitNextFrame("data: half\n")).toBeNull();
    expect(splitNextFrame("data: half\n\n")).not.toBeNull();
  });
});

describe("parseFrameBlock", () => {
  it("event:/data: 行解析；多 data 行按 \\n 连接", () => {
    expect(parseFrameBlock("event: x\ndata: a\ndata: b")).toEqual({
      event: "x",
      data: "a\nb",
    });
  });
  it("\\r 行尾剥离（CRLF 帧块）", () => {
    expect(parseFrameBlock("data: {\"a\":1}\r\ndata: {\"b\":2}\r")).toEqual({
      event: "message",
      data: '{"a":1}\n{"b":2}',
    });
  });
  it("注释行与空行忽略", () => {
    expect(parseFrameBlock(": keep-alive\ndata: {\"a\":1}")).toEqual({
      event: "message",
      data: { a: 1 },
    });
  });
  it("空 data / [DONE] → data:null（非 JSON，不可 parse）", () => {
    expect(parseFrameBlock("data:")).toEqual({ event: "message", data: null });
    expect(parseFrameBlock("data: [DONE]")).toEqual({
      event: "message",
      data: null,
    });
  });
  it("JSON 帧解析为对象", () => {
    expect(parseFrameBlock('data: {"a":1}')).toEqual({
      event: "message",
      data: { a: 1 },
    });
  });
  it("非 JSON → data 保留原字符串（容错，不打断流）", () => {
    expect(parseFrameBlock("data: {not-json")).toEqual({
      event: "message",
      data: "{not-json",
    });
  });
  it("strict 模式非 JSON 抛出（parseSseStream 语义）", () => {
    expect(() => parseFrameBlock("data: {not-json", { strict: true })).toThrow();
  });
});

describe("createOpenAiUsageDetector", () => {
  const detector = createOpenAiUsageDetector();
  it("usage 尾包 → TokenUsage（含 cached_tokens）", () => {
    expect(
      detector.feed({
        event: "message",
        data: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
      }),
    ).toEqual({ promptTokens: 100, completionTokens: 50, cachedTokens: 60 });
  });
  it("无 cached_tokens → 不携带该字段", () => {
    expect(
      detector.feed({
        event: "message",
        data: { usage: { prompt_tokens: 1, completion_tokens: 2 } },
      }),
    ).toEqual({ promptTokens: 1, completionTokens: 2 });
  });
  it("非对象 data（null / 原字符串）→ null", () => {
    expect(detector.feed({ event: "message", data: null })).toBeNull();
    expect(detector.feed({ event: "message", data: "{raw" })).toBeNull();
  });
  it("无 usage / 字段非数字 → null", () => {
    expect(detector.feed({ event: "message", data: { choices: [] } })).toBeNull();
    expect(
      detector.feed({ event: "message", data: { usage: { prompt_tokens: "x" } } }),
    ).toBeNull();
  });
});

describe("createAnthropicUsageDetector", () => {
  it("message_start + message_delta 合成；cache_read_input_tokens 计入", () => {
    const detector = createAnthropicUsageDetector();
    expect(
      detector.feed({
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            usage: { input_tokens: 200, cache_read_input_tokens: 150 },
          },
        },
      }),
    ).toBeNull(); // 单边不足
    expect(
      detector.feed({
        event: "message_delta",
        data: { type: "message_delta", usage: { output_tokens: 30 } },
      }),
    ).toEqual({ promptTokens: 200, completionTokens: 30, cachedTokens: 150 });
  });
  it("cache_read 为 0 → 不携带该字段", () => {
    const detector = createAnthropicUsageDetector();
    detector.feed({
      event: "message_start",
      data: { type: "message_start", message: { usage: { input_tokens: 5 } } },
    });
    expect(
      detector.feed({
        event: "message_delta",
        data: { type: "message_delta", usage: { output_tokens: 1 } },
      }),
    ).toEqual({ promptTokens: 5, completionTokens: 1 });
  });
  it("只来一个事件 → 始终 null", () => {
    const detector = createAnthropicUsageDetector();
    expect(
      detector.feed({
        event: "message_start",
        data: { type: "message_start", message: { usage: { input_tokens: 5 } } },
      }),
    ).toBeNull();
  });
  it("非对象 / 缺字段 → null 不抛", () => {
    const detector = createAnthropicUsageDetector();
    expect(detector.feed({ event: "x", data: null })).toBeNull();
    expect(
      detector.feed({ event: "x", data: { type: "ping" } }),
    ).toBeNull();
    expect(
      detector.feed({ event: "x", data: { type: "message_start" } }),
    ).toBeNull();
  });
  it("delta 先到、start 后到：齐备后返回", () => {
    const detector = createAnthropicUsageDetector();
    detector.feed({
      event: "message_delta",
      data: { type: "message_delta", usage: { output_tokens: 7 } },
    });
    expect(
      detector.feed({
        event: "message_start",
        data: { type: "message_start", message: { usage: { input_tokens: 3 } } },
      }),
    ).toEqual({ promptTokens: 3, completionTokens: 7 });
  });
  it("多块流（U1）：多次 message_delta 取最终累计 output_tokens", () => {
    const detector = createAnthropicUsageDetector();
    detector.feed({
      event: "message_start",
      data: { type: "message_start", message: { usage: { input_tokens: 200 } } },
    });
    // thinking 块停止 → delta 1（部分累计）
    expect(
      detector.feed({
        event: "message_delta",
        data: { type: "message_delta", usage: { output_tokens: 30 } },
      }),
    ).toEqual({ promptTokens: 200, completionTokens: 30 });
    // 正文块停止 → delta 2（最终累计：只取第一个会少收 470 tokens）
    expect(
      detector.feed({
        event: "message_delta",
        data: { type: "message_delta", usage: { output_tokens: 500 } },
      }),
    ).toEqual({ promptTokens: 200, completionTokens: 500 });
  });
  it("cache_creation（H8）：cache_creation_input_tokens 与 cache_read 求和按缓存价", () => {
    const detector = createAnthropicUsageDetector();
    detector.feed({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 200,
          },
        },
      },
    });
    expect(
      detector.feed({
        event: "message_delta",
        data: { type: "message_delta", usage: { output_tokens: 10 } },
      }),
    ).toEqual({ promptTokens: 1000, completionTokens: 10, cachedTokens: 500 });
  });
  it("snapshot（U2）：message_start 后即可快照（completionTokens 缺失 → 0，至少收 prompt 成本）", () => {
    const detector = createAnthropicUsageDetector();
    expect(detector.snapshot?.()).toBeNull();
    detector.feed({
      event: "message_start",
      data: {
        type: "message_start",
        message: { usage: { input_tokens: 200, cache_read_input_tokens: 150 } },
      },
    });
    expect(detector.snapshot?.()).toEqual({
      promptTokens: 200,
      completionTokens: 0,
      cachedTokens: 150,
    });
  });
});

describe("wrapStreamWithSettlement", () => {
  it("尾帧 usage：settle(usage) 恰好一次；输出字节与输入一致（透传零重编码）", async () => {
    const settle = vi.fn(async () => {});
    const logger = mockLogger();
    const sse = `${CHUNK_A}\n\n${USAGE_FRAME}\n\n${DONE}\n\n`;
    const out = await readAll(wrapStreamWithSettlement(bytes(sse), settle, logger));
    expect(out).toBe(sse); // 字节原样（含分隔符）
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it("usage 帧跨多个 chunk：检测正确；feed 按帧计（每帧一次，无全量重扫）", async () => {
    const settle = vi.fn(async () => {});
    const logger = mockLogger();
    // 每 7 字节一个 chunk：多帧必然跨 chunk 边界
    const sse = `${CHUNK_A}\n\n${USAGE_FRAME}\n\n${DONE}\n\n`;
    const feeds: unknown[] = [];
    const counted = wrapStreamWithSettlement(splitChunks(sse, 7), settle, logger, {
      detector: {
        feed(event) {
          feeds.push(event.data);
          return createOpenAiUsageDetector().feed(event);
        },
      },
    });
    await readAll(counted);
    // U1：usage 检测后仍持续 feed（多块流 output_tokens 为累计值，持续取最新）→ 3 帧全喂
    expect(feeds).toHaveLength(3);
    expect(feeds[0]).toMatchObject({
      choices: [{ delta: { content: "a" } }],
    });
    expect(feeds[1]).toMatchObject({ usage: { prompt_tokens: 100 } });
    expect(feeds[2]).toBeNull(); // [DONE] 帧 data:null 也投喂（检测器跳过）
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it("无 usage 流：settle(null)", async () => {
    const settle = vi.fn(async () => {});
    const sse = `data: {"choices":[{"delta":{"content":"x"}}]}\n\n${DONE}\n\n`;
    await readAll(wrapStreamWithSettlement(bytes(sse), settle, mockLogger()));
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(null);
  });

  it("空流：settle(null)，输出空", async () => {
    const settle = vi.fn(async () => {});
    const empty = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const out = await readAll(wrapStreamWithSettlement(empty, settle, mockLogger()));
    expect(out).toBe("");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(null);
  });

  it("上游流中途 error：按已产生 usage 结算一次；error 传播到输出", async () => {
    const settle = vi.fn(async () => {});
    // pull 驱动：先给 usage chunk（管道已读到），下次拉取再 error
    let pulledOnce = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulledOnce) {
          pulledOnce = true;
          controller.enqueue(encoder.encode(`${USAGE_FRAME}\n\n`));
          return;
        }
        controller.error(new Error("upstream boom"));
      },
    });
    const stream = wrapStreamWithSettlement(failing, settle, mockLogger());
    const reader = stream.getReader();
    await reader.read(); // 首 chunk 正常
    await expect(reader.read()).rejects.toThrow("upstream boom");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it("输出 cancel：settle 一次（已检测 usage）+ stream_cancelled 日志", async () => {
    const settle = vi.fn(async () => {});
    const logger = mockLogger();
    // 永不结束的上游（cancel 时结算已检测到的 usage）
    const neverEnding = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${USAGE_FRAME}\n\n`));
      },
    });
    const stream = wrapStreamWithSettlement(neverEnding, settle, logger);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(logger.warn).toHaveBeenCalledWith("stream_cancelled", {
      reason: "client gone",
    });
  });

  it("cancel 部分计费（U2）：anthropic 流无 message_delta 时按 snapshot 结算（至少收 prompt 成本）", async () => {
    const settle = vi.fn(async () => {});
    const logger = mockLogger();
    // 永不结束的上游：只有 message_start（无 message_delta → 无完整 usage 事件）
    const neverEnding = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":150}}}\n\n`,
          ),
        );
      },
    });
    const stream = wrapStreamWithSettlement(neverEnding, settle, logger, {
      detector: createAnthropicUsageDetector(),
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(settle).toHaveBeenCalledTimes(1);
    // U2：detected=null（缺 output_tokens）→ snapshot 兜底：prompt 成本必收
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 200,
      completionTokens: 0,
      cachedTokens: 150,
    });
  });

  it("idle timeout（U7）：流中途停顿超时 → 报错结束，settle 仍按已观测 usage 结算", async () => {
    const settle = vi.fn(async () => {});
    const logger = mockLogger();
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${USAGE_FRAME}\n\n`));
        await new Promise((r) => setTimeout(r, 150));
        controller.enqueue(encoder.encode(`${DONE}\n\n`));
        controller.close();
      },
    });
    const stream = wrapStreamWithSettlement(slow, settle, logger, {
      idleTimeoutMs: 40,
    });
    const reader = stream.getReader();
    await reader.read(); // 首 chunk 正常
    await expect(reader.read()).rejects.toThrow(/idle timeout/);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 100,
      completionTokens: 50,
    });
  });

  it("settle 抛错：记录 stream_settle_failed，输出不受影响", async () => {
    const settle = vi.fn(async () => {
      throw new Error("billing down");
    });
    const logger = mockLogger();
    const sse = `${USAGE_FRAME}\n\n${DONE}\n\n`;
    const out = await readAll(wrapStreamWithSettlement(bytes(sse), settle, logger));
    expect(out).toBe(sse);
    expect(logger.error).toHaveBeenCalledWith("stream_settle_failed", {
      error: "billing down",
    });
  });

  it("Anthropic 提取器挂载：原生事件流结算", async () => {
    const settle = vi.fn(async () => {});
    const sse =
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":150}}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    await readAll(
      wrapStreamWithSettlement(bytes(sse), settle, mockLogger(), {
        detector: createAnthropicUsageDetector(),
      }),
    );
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({
      promptTokens: 200,
      completionTokens: 30,
      cachedTokens: 150,
    });
  });
});
