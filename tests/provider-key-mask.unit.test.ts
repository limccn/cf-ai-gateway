// 「未配置上游密钥」标识的数据层锁定（09-21-seed-migration-tooling R-A15/R-A17 / AC-A7）。
//
// 被测的是 `toProviderResponse` 的**响应契约**（不是 maskSecret 的规则）：
//   api_key_prefix 为空 ⇒ apiKeyMasked === ""（空串 = 未配置，前端据此渲染标记）
//   api_key_prefix 非空 ⇒ 仍是 `${prefix}****`
//
// **两条必须成对**（quality spec「断言须有判别力」）：只写空串那一半是典型的
// 「必要条件当充分条件」——把实现改成 `apiKeyMasked: ""`（恒空串）也全绿。非空那一半才把
// 「空前缀 ⇒ 空串」与「恒回空串 / 恒回 ****」区分开；两条一起看，任何一种退化都被夹住。
import { describe, expect, it } from "vitest";
import { toProviderResponse } from "../src/routes/providers/lib/convert";
import type { Provider } from "../src/db/schema";

/** 迁移后的目标态行：`api_key_enc=''`、`api_key_prefix=''`、`enabled=0`（R-A8/A10 目标态）。 */
function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: "openai-prod",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnc: "",
    apiKeyPrefix: "",
    models: JSON.stringify({ "gpt-4o": "gpt-4o-2024-11-20" }),
    httpOptionsEnc: null,
    weight: 1,
    thinkingMode: null,
    reasoningRoundtrip: false,
    upstreamTimeoutMs: null,
    enabled: false,
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toProviderResponse · apiKeyMasked", () => {
  it("前缀为空（迁移目标态）⇒ 空串，绝不是 `****`", () => {
    const res = toProviderResponse(provider({ apiKeyPrefix: "" }));
    // `****` 仍是本用例要挡的退化形态（R-A15：它与真实密钥的掩码逐字相同）——
    // 但判据由**这一行**独立承担。原先跟着的 `not.toBe("****")` 已删除：它只在本行通过后
    // 才执行，而那时 `"" !== "****"` 恒真，是一条**永远不会失败**的断言（本仓库点名的假绿形态）。
    expect(res.apiKeyMasked).toBe("");
  });

  it("前缀非空 ⇒ 保留前缀 + `****`（成对的那一半，含极短前缀）", () => {
    const res = toProviderResponse(provider({ apiKeyPrefix: "sk-mock-ope" }));
    expect(res.apiKeyMasked).toBe("sk-mock-ope****");

    // 极短前缀也必须走掩码路径：一个「前缀太短就当未配置」的兜底会让**已配置**的 provider
    // 在管理台显示成「未配置」——正是本文件要防的那类谎报。
    // **变异验证（已实跑，2026-09-23）**：把 convert.ts 改成
    //   `provider.apiKeyPrefix.length > 2 ? maskSecret(provider.apiKeyPrefix) : ""`
    // ⇒ 只有本行红（`AssertionError: expected '' to be 'sk****'`，同文件另一条仍绿）；
    //   改回原样后 2 passed；`git diff src/routes/providers/lib/convert.ts` 与变异前逐字相同。
    // 取值理由：`"sk"` 长度为 2，落在变异条件的否支，故该形态必被这条抓住。
    expect(toProviderResponse(provider({ apiKeyPrefix: "sk" })).apiKeyMasked).toBe("sk****");
  });
});
