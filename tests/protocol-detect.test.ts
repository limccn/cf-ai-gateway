// 入站协议自动感知检测器单元测试（08-31-protocol-auto-detect，design §3/§10）：
// 信号矩阵——每类 anthropic 硬信号、每类 openai 硬信号、双向冲突、tool_choice 各形态、
// 无信号模型名兜底（gpt-/claude-/[1m]/大小写/其他/非字符串）、内容块防御、非对象 body。
import { describe, expect, it } from "vitest";
import {
  detectProtocol,
  fallbackByModel,
  ProtocolDetectionError,
} from "../src/lib/protocol-detect";

function headers(...entries: [string, string][]): Headers {
  return new Headers(entries);
}

describe("anthropic 硬信号", () => {
  it("请求头 anthropic-version（大小写不敏感）→ anthropic", () => {
    expect(detectProtocol({ model: "gpt-4o", messages: [] }, headers(["ANTHROPIC-VERSION", "2023-06-01"])))
      .toBe("anthropic");
  });

  it("顶层 system → anthropic（即使模型名 gpt-*）", () => {
    expect(detectProtocol({ model: "gpt-4o", system: "sys", messages: [] })).toBe("anthropic");
  });

  it("顶层 stop_sequences / metadata / thinking → anthropic", () => {
    expect(detectProtocol({ model: "m", stop_sequences: ["</s>"], messages: [] })).toBe("anthropic");
    expect(detectProtocol({ model: "m", metadata: { user_id: "u" }, messages: [] })).toBe("anthropic");
    expect(detectProtocol({ model: "m", thinking: { type: "enabled", budget_tokens: 100 }, messages: [] }))
      .toBe("anthropic");
  });

  it("content block type: image / tool_use / tool_result → anthropic", () => {
    const base = { model: "m", messages: [{ role: "user", content: [{ type: "image", source: {} }] }] };
    expect(detectProtocol(base)).toBe("anthropic");
    expect(detectProtocol({
      model: "m",
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] }],
    })).toBe("anthropic");
    expect(detectProtocol({
      model: "m",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }],
    })).toBe("anthropic");
  });

  it("tool 含 input_schema 且无 function 键 → anthropic", () => {
    expect(detectProtocol({
      model: "m",
      tools: [{ name: "f", input_schema: { type: "object" } }],
    })).toBe("anthropic");
  });

  it("tool_choice 对象 type: any / tool → anthropic", () => {
    expect(detectProtocol({ model: "m", tool_choice: { type: "any" } })).toBe("anthropic");
    expect(detectProtocol({ model: "m", tool_choice: { type: "tool", name: "f" } })).toBe("anthropic");
  });
});

describe("openai 硬信号", () => {
  it("顶层 max_completion_tokens / n / stream_options / response_format → openai", () => {
    expect(detectProtocol({ model: "m", max_completion_tokens: 100, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", n: 2, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", stream_options: { include_usage: true }, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", response_format: { type: "json_object" }, messages: [] })).toBe("openai");
  });

  it("顶层 presence_penalty / frequency_penalty / logprobs / seed / stop / parallel_tool_calls → openai", () => {
    expect(detectProtocol({ model: "m", presence_penalty: 0.5, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", frequency_penalty: 0.5, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", logprobs: true, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", seed: 42, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", stop: ["END"], messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "m", parallel_tool_calls: false, messages: [] })).toBe("openai");
  });

  it("content block type: image_url / input_audio → openai", () => {
    expect(detectProtocol({
      model: "m",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }],
    })).toBe("openai");
    expect(detectProtocol({
      model: "m",
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "a", format: "wav" } }] }],
    })).toBe("openai");
  });

  it("tool type: function → openai", () => {
    expect(detectProtocol({
      model: "m",
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    })).toBe("openai");
  });

  it("tool_choice 字符串 → openai", () => {
    expect(detectProtocol({ model: "m", tool_choice: "auto", messages: [] })).toBe("openai");
  });

  it("tool_choice 对象 type: function / 含 function 键 → openai", () => {
    expect(detectProtocol({ model: "m", tool_choice: { type: "function", function: { name: "f" } } })).toBe("openai");
    expect(detectProtocol({ model: "m", tool_choice: { function: { name: "f" } } })).toBe("openai");
  });
});

describe("双向冲突（R2.3）", () => {
  it("顶层 system + n → ProtocolDetectionError", () => {
    expect(() => detectProtocol({ model: "m", system: "s", n: 2, messages: [] })).toThrow(ProtocolDetectionError);
  });

  it("anthropic-version 头 + content image_url → ProtocolDetectionError", () => {
    expect(() => detectProtocol(
      { model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: {} }] }] },
      headers(["anthropic-version", "2023-06-01"]),
    )).toThrow(/mixes OpenAI and Anthropic/);
  });

  it("tool input_schema + tool_choice 字符串 → ProtocolDetectionError", () => {
    expect(() => detectProtocol({
      model: "m",
      tools: [{ name: "f", input_schema: { type: "object" } }],
      tool_choice: "auto",
    })).toThrow(ProtocolDetectionError);
  });
});

describe("tool_choice type: auto 不算信号（防误判）", () => {
  it("auto + 无其他信号 + 模型缺省 → openai（兜底）", () => {
    expect(detectProtocol({ model: "unknown-model", tool_choice: { type: "auto" } })).toBe("openai");
  });

  it("auto + claude-* 模型 → anthropic（兜底优先）", () => {
    expect(detectProtocol({ model: "claude-sonnet-4", tool_choice: { type: "auto" } })).toBe("anthropic");
  });
});

describe("无信号模型名兜底（fallbackByModel）", () => {
  it("gpt-* → openai", () => {
    expect(detectProtocol({ model: "gpt-4o", max_tokens: 10, messages: [] })).toBe("openai");
  });

  it("claude-* → anthropic", () => {
    expect(detectProtocol({ model: "claude-sonnet-4-20250514", max_tokens: 10, messages: [] })).toBe("anthropic");
  });

  it("[1m] 后缀剥离后 claude-* → anthropic", () => {
    expect(detectProtocol({ model: "claude-sonnet-4-20250514-1m", messages: [] })).toBe("anthropic");
  });

  it("大小写不敏感（CLAUDE-3-5-SONNET）→ anthropic", () => {
    expect(detectProtocol({ model: "CLAUDE-3-5-SONNET", messages: [] })).toBe("anthropic");
  });

  it("其他模型名 → openai（默认）", () => {
    expect(detectProtocol({ model: "deepseek-v4-flash", max_tokens: 10, messages: [] })).toBe("openai");
    expect(detectProtocol({ model: "qwen3.8-flash", messages: [] })).toBe("openai");
  });

  it("model 非字符串 / 缺失 → openai（防御）", () => {
    expect(fallbackByModel(123)).toBe("openai");
    expect(fallbackByModel(undefined)).toBe("openai");
    expect(fallbackByModel("")).toBe("openai");
    expect(detectProtocol({ max_tokens: 10, messages: [] })).toBe("openai");
  });

  it("排除项（max_tokens/temperature/top_p/stream/messages/model）不产生信号", () => {
    expect(detectProtocol({
      model: "claude-haiku-4.5",
      max_tokens: 10,
      temperature: 0.7,
      top_p: 1,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })).toBe("anthropic");
    expect(detectProtocol({
      model: "gpt-4o-mini",
      max_tokens: 10,
      temperature: 0.7,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })).toBe("openai");
  });
});

describe("防御性遍历与异常输入", () => {
  it("content 为字符串（非数组）→ 不产生信号，交兜底", () => {
    expect(detectProtocol({ model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] }))
      .toBe("anthropic");
  });

  it("messages / content 数组含非对象元素 → 跳过不炸", () => {
    expect(detectProtocol({
      model: "m",
      messages: [null, "str", { role: "user", content: [null, 42, { type: "tool_use" }] }],
    })).toBe("anthropic");
  });

  it("tools 含非对象元素 / type 非字符串 → 跳过", () => {
    expect(detectProtocol({
      model: "m",
      tools: [null, "str", { input_schema: {} }],
    })).toBe("anthropic");
  });

  it("非对象 body（null/数组/字符串）→ 无信号走默认 openai", () => {
    expect(detectProtocol(null)).toBe("openai");
    expect(detectProtocol([1, 2])).toBe("openai");
    expect(detectProtocol("hello")).toBe("openai");
  });

  it("非对象 body + anthropic-version 头 → anthropic（头仍生效）", () => {
    expect(detectProtocol(null, headers(["anthropic-version", "2023-06-01"]))).toBe("anthropic");
  });
});
