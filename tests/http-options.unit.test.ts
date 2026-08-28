// R2 高级 HTTP 选项应用单元测试（PRD R2.2/R2.4）：强制覆盖（override）语义 —
// httpOptions 配置值总是覆盖适配器默认值与请求值（厂商适配 + 附加认证）。
import { describe, expect, it } from "vitest";
import type { HttpOptions, ProviderConfig } from "../src/providers/types";
import { applyHttpBody, buildUpstreamHeaders } from "../src/providers/http-options";

const DEFAULTS: Record<string, string> = {
  "Content-Type": "application/json",
  Authorization: "Bearer sk-orig",
};

function cfg(partial?: Partial<HttpOptions>): ProviderConfig {
  return {
    type: "openai",
    baseUrl: "http://upstream/v1",
    apiKey: "sk-orig",
    models: {},
    ...(partial !== undefined ? { httpOptions: partial } : {}),
  };
}

describe("buildUpstreamHeaders（强制覆盖）", () => {
  it("未配置 httpOptions：默认头原样返回", () => {
    expect(buildUpstreamHeaders(DEFAULTS, cfg())).toEqual(DEFAULTS);
  });

  it("headers 同名覆盖默认头（含认证头）+ 新增头", () => {
    const headers = buildUpstreamHeaders(DEFAULTS, cfg({
      headers: { Authorization: "Bearer sk-custom", "X-Provider": "acme" },
    }));
    expect(headers["Authorization"]).toBe("Bearer sk-custom");
    expect(headers["X-Provider"]).toBe("acme");
    expect(headers["Content-Type"]).toBe("application/json"); // 未覆盖的保持
  });

  it("userAgent 覆盖 User-Agent", () => {
    const headers = buildUpstreamHeaders(DEFAULTS, cfg({ userAgent: "E2E-Agent/1.0" }));
    expect(headers["User-Agent"]).toBe("E2E-Agent/1.0");
  });

  it("配置不污染默认值对象（防御性）", () => {
    buildUpstreamHeaders(DEFAULTS, cfg({ headers: { Authorization: "x" }, userAgent: "y" }));
    expect(DEFAULTS["Authorization"]).toBe("Bearer sk-orig");
    expect(DEFAULTS["User-Agent"]).toBeUndefined();
  });
});

describe("applyHttpBody（body 字段强制覆盖）", () => {
  it("未配置：body 原样", () => {
    const body = { model: "m", temperature: 0.9 };
    expect(applyHttpBody(body, cfg())).toEqual({ model: "m", temperature: 0.9 });
  });

  it("同名字段覆盖（temperature），未配置字段保留", () => {
    const body = applyHttpBody({ model: "m", temperature: 0.9, top_p: 0.1 }, cfg({
      body: { temperature: 0 },
    }));
    expect(body["temperature"]).toBe(0);
    expect(body["top_p"]).toBe(0.1);
    expect(body["model"]).toBe("m");
  });

  it("新增字段", () => {
    const body = applyHttpBody<Record<string, unknown>>({ model: "m" }, cfg({ body: { max_tokens: 64 } }));
    expect(body["max_tokens"]).toBe(64);
  });
});
