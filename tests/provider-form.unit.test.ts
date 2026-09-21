// providers 表单纯逻辑单测（批次 N，2026-09-21）。纯函数、无 DOM、无 Worker —— 与
// menu-position.unit.test.ts / model-mask.unit.test.ts 同一类。
//
// 这里钉的是**拆分本身的契约**（PRD N1/N2），三条判别力最强的：
//   ① 两个编辑弹窗各提交各的字段 —— 断言的是**精确键集**，不是「不包含某某」。
//      精确键集同时挡住两个方向：漏带自己的字段、多带对方的字段。
//   ② 故意多喂：表单 state 里明明有 weight=999，basics 的载荷里也不能出现 weight。
//      （若哪天有人把 parseBasicsUpdate 改成 `{...form}` 再删几个键，这条会红。）
//   ③ providerToForm 的 apiKey 恒为空 —— N2「密钥不预填」在数据层的保证。
import { describe, expect, it } from "vitest";
import {
  emptyProviderForm,
  hasHttpOptions,
  httpOptionsToText,
  modelsToText,
  parseAdvancedUpdate,
  parseBasicsUpdate,
  parseCreateForm,
  parseHttpOptionsText,
  providerToForm,
} from "../app/modules/providers/form";
import type { ProviderFormState } from "../app/modules/providers/form";
import type { ProviderResponse } from "../app/modules/providers/types";

const PROVIDER: ProviderResponse = {
  id: 7,
  name: "openai-prod",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyMasked: "sk-****abcd",
  models: { "gpt-4o": "gpt-4o-2024-11-20", "gpt-4o-mini": "gpt-4o-mini" },
  weight: 3,
  enabled: true,
  thinkingMode: "budget",
  reasoningRoundtrip: true,
  upstreamTimeoutMs: 120_000,
  httpOptions: {
    userAgent: "MyAgent/1.0",
    headers: { "X-Provider": "****acme" },
    body: { temperature: 0 },
  },
  createdAt: "2026-09-21T00:00:00.000Z",
};

/** 建一个所有字段都被填满的表单态（用来催出最完整的载荷键集）。 */
function fullForm(overrides: Partial<ProviderFormState> = {}): ProviderFormState {
  return { ...emptyProviderForm(), ...providerToForm(PROVIDER), ...overrides };
}

describe("providerToForm / emptyProviderForm", () => {
  it("编辑回填：apiKey 恒为空串，掩码不进表单（N2 的数据层保证）", () => {
    const form = providerToForm(PROVIDER);
    expect(form.apiKey).toBe("");
    // **前提守卫**（不是「夹具等于夹具」的复述）：下面那条 not.toContain 要有判别力，
    // 前提是掩码非空 —— 空串是任何字符串的子串，届时 not.toContain("") 会以一句
    // 与真实原因毫无关系的失败收场。
    expect(PROVIDER.apiKeyMasked.length).toBeGreaterThan(0);
    expect(JSON.stringify(form)).not.toContain(PROVIDER.apiKeyMasked);
  });

  it("编辑回填：全部字段逐一对应，models 转成行文本", () => {
    const form = providerToForm(PROVIDER);
    expect(form.name).toBe("openai-prod");
    expect(form.type).toBe("openai");
    expect(form.baseUrl).toBe("https://api.openai.com/v1");
    expect(form.modelsText).toBe("gpt-4o=gpt-4o-2024-11-20\ngpt-4o-mini=gpt-4o-mini");
    expect(form.weight).toBe(3);
    expect(form.thinkingMode).toBe("budget");
    expect(form.reasoningRoundtrip).toBe(true);
    expect(form.upstreamTimeoutMs).toBe("120000");
  });

  it("编辑回填：httpOptions 的掩码值原样进文本（掩码哨兵靠它回传）", () => {
    const form = providerToForm(PROVIDER);
    const parsed = JSON.parse(form.httpOptionsText) as { headers: Record<string, string> };
    expect(parsed.headers["X-Provider"]).toBe("****acme");
  });

  it("编辑回填：未配置的可选项不产生噪声（空串 / null / false）", () => {
    const bare: ProviderResponse = {
      ...PROVIDER,
      weight: 1,
      thinkingMode: null,
      reasoningRoundtrip: false,
      upstreamTimeoutMs: null,
      httpOptions: { headers: {}, body: {} },
    };
    const form = providerToForm(bare);
    expect(form.httpOptionsText).toBe("");
    expect(form.upstreamTimeoutMs).toBe("");
    expect(form.thinkingMode).toBeNull();
    expect(form.reasoningRoundtrip).toBe(false);
    expect(hasHttpOptions(bare.httpOptions)).toBe(false);
  });

  it("modelsToText ↔ modelsMapTextSchema 往返一致", () => {
    const form = providerToForm(PROVIDER);
    expect(form.modelsText).toBe(modelsToText(PROVIDER.models));
    const back = parseBasicsUpdate(form);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.data.models).toEqual(PROVIDER.models);
    }
  });

  it("上游名里带 `=` 也能往返（按第一个 = 切分，右边的 = 归值）", () => {
    const tricky = { "gpt-4o": "openai/gpt-4o=2024-11-20" };
    const text = modelsToText(tricky);
    const back = parseBasicsUpdate(fullForm({ modelsText: text }));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.data.models).toEqual(tricky);
    }
  });
});

describe("拆分契约：两个编辑弹窗各提交各的字段（N1）", () => {
  it("basics 载荷的键集恰好是 name/type/baseUrl/apiKey/models —— 多带一个都不行", () => {
    // apiKey 要显式给：providerToForm 的 apiKey 恒为空串（N2），空即省略，
    // 不补这一笔这条用例会把「省略」误算成「键集不对」。
    const parsed = parseBasicsUpdate(fullForm({ apiKey: "sk-typed-by-user" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(Object.keys(parsed.data).sort()).toEqual([
      "apiKey",
      "baseUrl",
      "models",
      "name",
      "type",
    ]);
  });

  it("advanced 载荷的键集恰好是那五个 —— name/baseUrl/apiKey/models 一个都不许出现", () => {
    const parsed = parseAdvancedUpdate(fullForm());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(Object.keys(parsed.data).sort()).toEqual([
      "httpOptions",
      "reasoningRoundtrip",
      "thinkingMode",
      "upstreamTimeoutMs",
      "weight",
    ]);
  });

  it("故意多喂：表单里带着 weight / thinkingMode，basics 的载荷也不会把它们写回去", () => {
    const form = fullForm({ weight: 999, thinkingMode: "off", upstreamTimeoutMs: "5000" });
    const parsed = parseBasicsUpdate(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.data).not.toHaveProperty("weight");
    expect(parsed.data).not.toHaveProperty("thinkingMode");
    expect(parsed.data).not.toHaveProperty("upstreamTimeoutMs");
    expect(parsed.data).not.toHaveProperty("httpOptions");
    // 反向确认喂进去的值确实还在表单里（否则上面几条会被「字段根本没填」平凡满足）
    expect(form.weight).toBe(999);
  });

  it("故意多喂：表单里带着 name / baseUrl，advanced 的载荷也不会把它们写回去", () => {
    const form = fullForm({ name: "renamed-elsewhere", baseUrl: "https://evil.example/v1" });
    const parsed = parseAdvancedUpdate(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.data).not.toHaveProperty("name");
    expect(parsed.data).not.toHaveProperty("baseUrl");
    expect(parsed.data).not.toHaveProperty("apiKey");
    expect(parsed.data).not.toHaveProperty("models");
    expect(form.name).toBe("renamed-elsewhere");
  });
});

describe("留空 = 保持原值（两条省略语义）", () => {
  it("apiKey 留空 → 字段整个省略（后端据「省略」判定不重新加密）", () => {
    const parsed = parseBasicsUpdate(fullForm({ apiKey: "" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data).not.toHaveProperty("apiKey");
    }
  });

  it("apiKey 非空 → 原样带上", () => {
    const parsed = parseBasicsUpdate(fullForm({ apiKey: "sk-typed-by-user" }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.apiKey).toBe("sk-typed-by-user");
    }
  });

  it("models 留空 / 纯空白 → 省略；非空 → 解析成映射对象", () => {
    for (const blank of ["", "   ", "\n  \n"]) {
      const parsed = parseBasicsUpdate(fullForm({ modelsText: blank }));
      expect(parsed.ok, `modelsText=${JSON.stringify(blank)}`).toBe(true);
      if (parsed.ok) {
        expect(parsed.data).not.toHaveProperty("models");
      }
    }
    const parsed = parseBasicsUpdate(fullForm({ modelsText: " a = b \n\nc=d " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.models).toEqual({ a: "b", c: "d" });
    }
  });

  it("httpOptions 留空 → 省略（保持原密文）；有值 → 结构进载荷", () => {
    const blank = parseAdvancedUpdate(fullForm({ httpOptionsText: "" }));
    expect(blank.ok).toBe(true);
    if (blank.ok) {
      expect(blank.data).not.toHaveProperty("httpOptions");
    }

    const filled = parseAdvancedUpdate(
      fullForm({ httpOptionsText: '{"userAgent":"A/1.0","body":{"temperature":0}}' }),
    );
    expect(filled.ok).toBe(true);
    if (filled.ok) {
      expect(filled.data.httpOptions).toEqual({ userAgent: "A/1.0", body: { temperature: 0 } });
    }
  });

  it("httpOptions 掩码值能原样回传（用户不改就提交回去，后端保持旧密文）", () => {
    const parsed = parseAdvancedUpdate(fullForm());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.httpOptions?.headers?.["X-Provider"]).toBe("****acme");
    }
  });
});

describe("校验失败落点", () => {
  it("httpOptions 非 JSON → 错误落在 httpOptions 字段位，且不产生载荷", () => {
    for (const bad of ["{oops", "[1,2]", '"a string"', "null"]) {
      const parsed = parseAdvancedUpdate(fullForm({ httpOptionsText: bad }));
      expect(parsed.ok, `httpOptionsText=${bad}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.httpOptions).toBeTruthy();
      }
    }
    const create = parseCreateForm(fullForm({ httpOptionsText: "{oops" }));
    expect(create.ok).toBe(false);
    if (!create.ok) {
      expect(create.errors.httpOptions).toBeTruthy();
    }
  });

  it("header 值含 CR/LF → 被拒（响应头注入防护，与后端同一规则）", () => {
    const parsed = parseAdvancedUpdate(
      fullForm({ httpOptionsText: '{"headers":{"X-Bad":"a\\r\\nInjected: 1"}}' }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.httpOptions).toContain("CR/LF");
    }
  });

  it("weight 越界 / 非整数 → 错误落在 weight 位", () => {
    for (const bad of [0, 1001, 1.5]) {
      const parsed = parseAdvancedUpdate(fullForm({ weight: bad }));
      expect(parsed.ok, `weight=${bad}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.weight).toBeTruthy();
      }
    }
  });

  it("upstreamTimeoutMs：空串 → null（重置默认）；越界 → 错误", () => {
    const blank = parseAdvancedUpdate(fullForm({ upstreamTimeoutMs: "" }));
    expect(blank.ok).toBe(true);
    if (blank.ok) {
      expect(blank.data.upstreamTimeoutMs).toBeNull();
    }
    const low = parseAdvancedUpdate(fullForm({ upstreamTimeoutMs: "999" }));
    expect(low.ok).toBe(false);
    if (!low.ok) {
      expect(low.errors.upstreamTimeoutMs).toBeTruthy();
    }
  });

  it("models 行校验：缺 `=` 与「有 `=` 但半边为空」都算错（两条 refine 各走一条）", () => {
    // 只喂第一种时，schema 里**最后那道** refine（「内部名与上游名都要非空」）**从未被执行**，
    // 而用例名却在声称它 —— 判错分支的用例必须把每条分支都走到。
    const cases: Array<[string, string]> = [
      ["gpt-4o", "整行没有 =（第二道 refine 拦下）"],
      ["a=", "有 = 但上游名为空（过了第二道，由最后一道拦下）"],
      ["=b", "有 = 但内部名为空（同上）"],
    ];
    for (const [modelsText, why] of cases) {
      const parsed = parseBasicsUpdate(fullForm({ modelsText }));
      expect(parsed.ok, why).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.models, why).toBeTruthy();
      }
    }
    // 对照：两半都非空时确实通过 —— 否则上面三条可能只是「什么都判错」的恒假锁
    const good = parseBasicsUpdate(fullForm({ modelsText: "a=b" }));
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.data.models).toEqual({ a: "b" });
    }
  });

  it("Add：apiKey 必填（编辑可留空，新建不行）", () => {
    const parsed = parseCreateForm(fullForm({ apiKey: "" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.apiKey).toBeTruthy();
    }
  });

  it("baseUrl 非 URL → 错误落在 baseUrl 位（两个编辑弹窗都要校验）", () => {
    for (const parse of [parseBasicsUpdate, parseAdvancedUpdate]) {
      // advanced 不提交 baseUrl，故它**不该**报这个错 —— 这条同时验证「不串」
      const parsed = parse(fullForm({ baseUrl: "not-a-url" }));
      if (parse === parseBasicsUpdate) {
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.errors.baseUrl).toBeTruthy();
        }
      } else {
        expect(parsed.ok).toBe(true);
      }
    }
  });
});

describe("parseHttpOptionsText / httpOptionsToText", () => {
  it("空文本 → ok 且无值（不是错误）", () => {
    expect(parseHttpOptionsText("  \n ")).toEqual({ ok: true, value: undefined });
  });

  it("往返：toText → parse 得回同一结构（已配置项逐字段保住）", () => {
    const text = httpOptionsToText({
      userAgent: "A/1.0",
      headers: { X: "****masked" },
      body: { temperature: 0, top_p: 0.5 },
    });
    const parsed = parseHttpOptionsText(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        userAgent: "A/1.0",
        headers: { X: "****masked" },
        body: { temperature: 0, top_p: 0.5 },
      });
    }
  });

  it("toText：全空 → 空串；只有 userAgent 时不带空 headers/body", () => {
    expect(httpOptionsToText({ headers: {}, body: {} })).toBe("");
    expect(httpOptionsToText({ userAgent: "A/1.0", headers: {}, body: {} })).toBe(
      JSON.stringify({ userAgent: "A/1.0" }, null, 2),
    );
  });
});
