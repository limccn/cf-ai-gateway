// 网关 API Key 前缀单测（08-26-api-key-prefix）：
// - 默认前缀 sk-；API_KEY_PREFIX 空白/未设置回退默认；自定义值生效（trim）。
// - 生成 key = 前缀 + 32 位随机串；存储前缀取明文前 10 字符（纯单元测试，无 DB）。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEY_PREFIX,
  extractKeyPrefix,
  generateGatewayKey,
  resolveKeyPrefix,
} from "../src/lib/api-keys";

describe("resolveKeyPrefix", () => {
  it("未设置（undefined）→ 默认 sk-", () => {
    expect(resolveKeyPrefix(undefined)).toBe(DEFAULT_KEY_PREFIX);
  });

  it("空字符串 → 默认 sk-", () => {
    expect(resolveKeyPrefix("")).toBe(DEFAULT_KEY_PREFIX);
  });

  it("纯空白 → 默认 sk-", () => {
    expect(resolveKeyPrefix("   \t\n")).toBe(DEFAULT_KEY_PREFIX);
  });

  it("自定义前缀生效（前后空白被 trim）", () => {
    expect(resolveKeyPrefix("  acme-  ")).toBe("acme-");
  });
});

describe("generateGatewayKey", () => {
  it("key = 前缀 + 32 位 Base62 随机串", () => {
    for (const prefix of [DEFAULT_KEY_PREFIX, "acme-"]) {
      const key = generateGatewayKey(prefix);
      expect(key.startsWith(prefix)).toBe(true);
      expect(key.length).toBe(prefix.length + 32);
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("两次生成互不相同", () => {
    expect(generateGatewayKey(DEFAULT_KEY_PREFIX)).not.toBe(
      generateGatewayKey(DEFAULT_KEY_PREFIX),
    );
  });
});

describe("extractKeyPrefix", () => {
  it("返回明文前 10 字符（展示用，不敏感）", () => {
    const key = generateGatewayKey(DEFAULT_KEY_PREFIX);
    expect(extractKeyPrefix(key)).toBe(key.slice(0, 10));
  });
});
