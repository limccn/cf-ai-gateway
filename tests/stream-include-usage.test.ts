// F1（安全评审）：ensureStreamIncludeUsage 纯函数 —— 流式计费兜底。
// 规范 OpenAI 上游仅显式请求才返回 usage 尾包，不注入则流式请求无 usage 帧 → 计费落空（免单）。
// 语义：stream:true 强制 include_usage（计费优先，客户端无权关闭）；用户已有字段保留；零污染。
import { describe, expect, it } from "vitest";
import { ensureStreamIncludeUsage } from "../src/providers/openai";

describe("ensureStreamIncludeUsage（F1 流式计费兜底）", () => {
  it("stream:true 且无 stream_options → 注入 include_usage:true", () => {
    const body = { model: "gpt-4o-mini", stream: true, messages: [] };
    const result = ensureStreamIncludeUsage(body);
    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      model: "gpt-4o-mini",
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    });
  });

  it("用户已有 stream_options 其他字段 → 保留（浅拷贝合并，不覆盖）", () => {
    const body = { stream: true, stream_options: { foo: "bar", max_tokens: 5 } };
    const result = ensureStreamIncludeUsage(body);
    expect(result.changed).toBe(true);
    expect(result.body["stream_options"]).toEqual({
      foo: "bar",
      max_tokens: 5,
      include_usage: true,
    });
  });

  it("客户端显式 include_usage:false → 强制覆盖为 true（计费优先，客户端无权关闭）", () => {
    const body = { stream: true, stream_options: { include_usage: false } };
    const result = ensureStreamIncludeUsage(body);
    expect(result.changed).toBe(true);
    expect(result.body["stream_options"]).toEqual({ include_usage: true });
  });

  it("已含 include_usage:true → 零变化（返回原引用）", () => {
    const body = { stream: true, stream_options: { include_usage: true } };
    const result = ensureStreamIncludeUsage(body);
    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
  });

  it("非流式（stream 缺失/false）→ 零变化（返回原引用）", () => {
    const absent = { model: "gpt-4o-mini", messages: [] };
    expect(ensureStreamIncludeUsage(absent)).toEqual({ body: absent, changed: false });
    const nonStream = { model: "gpt-4o-mini", stream: false, messages: [] };
    expect(ensureStreamIncludeUsage(nonStream)).toEqual({ body: nonStream, changed: false });
  });

  it("零污染：注入不修改原始 body 对象（浅拷贝语义）", () => {
    const body = { model: "gpt-4o-mini", stream: true, stream_options: { foo: "bar" } };
    const original = structuredClone(body);
    const result = ensureStreamIncludeUsage(body);
    expect(result.changed).toBe(true);
    expect(body).toEqual(original);
    expect(body["stream_options"]).toEqual({ foo: "bar" });
  });
});
