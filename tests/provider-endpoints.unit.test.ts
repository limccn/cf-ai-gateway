// 解析后端点单测（09-28-upstream-custom-type-passthrough 批次 1）。纯函数、无 Worker、无 DOM。
//
// 本文件钉的是批次 1 的**核心断言面**：
//   ① 遗留等价规则逐行（零回归红线）——protocols=NULL 时按 type 复现今天的隐式面表，
//      URL 与适配器现规则**逐字节一致**（断言用字面量，不引用 openaiEndpointUrl/anthropicMessagesUrl
//      生成期望值——否则改坏两个 helper 与解析器一起漂移时这里照样绿）；
//   ② P2a 恒等复现——遗留 anthropic 的 messages 面是「convert + streamPassthrough=true」，
//      这是双属性设计的存在理由，合并成单开关会表达不了它；
//   ③ 声明面规则——面表取代隐式表（不做并集）、baseUrl 继承、policy 面默认、verbatim ⇒ 直通；
//   ④ fail-fast——custom ∧ protocols 缺失/空/损坏必须报错（解析真源是 DB 直改的唯一防线）；
//   ⑤ zod 写入门禁——type=custom ⇒ protocols 非空且至少一面（.refine），面键/面内键双 strict。
//
// 夹具纪律（候选值两两不等）：每个场景用**不同** base_url，且各行期望的
// (face, dialect, policy, streamPassthrough, URL, authStyle) 六元组互不相同——
// 期望值退化为相同值时，「解析对不对」就无从判别（夹具退化 = 恒真假绿）。
import { describe, expect, it } from "vitest";
import {
  FACE_DEFAULT_POLICY,
  EndpointResolutionError,
  PROVIDER_FACES,
  dialectForFace,
  parseResolvedEndpoints,
  selectEndpoint,
  supportsProtocol,
  type ProviderEndpointRow,
} from "../src/providers/endpoints";
import {
  createProviderInputSchema,
  providerProtocolsSchema,
  updateProviderInputSchema,
} from "../src/routes/providers/types";

// 六个互不相等的 base_url（含 /v1 与非 /v1、含尾斜杠——形态差异本身就是断言的一部分）
const OPENAI_BASE = "https://openai-upstream.test/v1";
const ANTHROPIC_BASE = "https://anthropic-upstream.test";
const ANTHROPIC_V1_BASE = "https://anthropic-v1-upstream.test/v1";
const CUSTOM_BASE = "https://custom-upstream.test/v1";
const MSG_BASE = "https://messages-endpoint.test/anthropic";
const RESP_BASE = "https://responses-endpoint.test/v1/";

function row(overrides: Partial<ProviderEndpointRow> = {}): ProviderEndpointRow {
  return { type: "openai", baseUrl: OPENAI_BASE, protocols: null, ...overrides };
}

describe("parseResolvedEndpoints — 遗留等价规则（protocols=NULL，零回归红线）", () => {
  it("openai 行 ⇒ 恰 3 端点、白名单序、全部 convert + 非直通 + bearer，URL 逐字节等于今天的规则", () => {
    expect(
      parseResolvedEndpoints(row({ type: "openai", baseUrl: OPENAI_BASE })),
    ).toEqual([
      {
        face: "chat",
        dialect: "openai",
        endpointUrl: "https://openai-upstream.test/v1/chat/completions",
        authStyle: "bearer",
        policy: "convert",
        streamPassthrough: false,
      },
      {
        face: "completions",
        dialect: "openai",
        endpointUrl: "https://openai-upstream.test/v1/completions",
        authStyle: "bearer",
        policy: "convert",
        streamPassthrough: false,
      },
      {
        face: "embeddings",
        dialect: "openai",
        endpointUrl: "https://openai-upstream.test/v1/embeddings",
        authStyle: "bearer",
        policy: "convert",
        streamPassthrough: false,
      },
    ]);
  });

  it("anthropic 行（base_url 无 /v1）⇒ 恰 2 端点同 URL，chat 非直通而 messages 直通（P2a 恒等复现）", () => {
    const endpoints = parseResolvedEndpoints(
      row({ type: "anthropic", baseUrl: ANTHROPIC_BASE }),
    );
    expect(endpoints).toEqual([
      {
        face: "chat",
        dialect: "anthropic",
        endpointUrl: "https://anthropic-upstream.test/v1/messages",
        authStyle: "x-api-key",
        policy: "convert",
        streamPassthrough: false,
      },
      {
        face: "messages",
        dialect: "anthropic",
        endpointUrl: "https://anthropic-upstream.test/v1/messages",
        authStyle: "x-api-key",
        policy: "convert",
        streamPassthrough: true,
      },
    ]);
    // 双属性的存在理由单独钉死：messages 面 = convert **且** 直通（今天的 P2a），不是新行为
    expect(endpoints[1]).toMatchObject({ policy: "convert", streamPassthrough: true });
    // chat 面是反面：同为 anthropic 方言却**不**直通 —— 逐面断言而非数组级「有一个 true」
    expect(endpoints[0]).toMatchObject({ streamPassthrough: false });
  });

  it("anthropic 行（base_url 已带 /v1）⇒ URL 走容忍形态第二支 {base}/messages", () => {
    const endpoints = parseResolvedEndpoints(
      row({ type: "anthropic", baseUrl: ANTHROPIC_V1_BASE }),
    );
    expect(endpoints.map((e) => e.endpointUrl)).toEqual([
      "https://anthropic-v1-upstream.test/v1/messages",
      "https://anthropic-v1-upstream.test/v1/messages",
    ]);
  });
});

describe("parseResolvedEndpoints — 声明面（protocols 非 NULL）", () => {
  it("面表完全取代隐式面表：仅声明 messages 的行恰 1 端点（不做并集）", () => {
    const endpoints = parseResolvedEndpoints(
      row({ type: "custom", baseUrl: CUSTOM_BASE, protocols: JSON.stringify({ messages: {} }) }),
    );
    expect(endpoints.map((e) => e.face)).toEqual(["messages"]);
    expect(endpoints).toHaveLength(1);
  });

  it("显式 baseUrl + 显式 policy 各就各位；convert 打主端点（面内 baseUrl 不生效）、verbatim 打面端点", () => {
    const protocols = JSON.stringify({
      chat: { policy: "convert" },
      messages: { baseUrl: MSG_BASE, policy: "verbatim" },
    });
    expect(
      parseResolvedEndpoints(
        row({ type: "custom", baseUrl: CUSTOM_BASE, protocols }),
      ),
    ).toEqual([
      {
        face: "chat",
        dialect: "openai",
        endpointUrl: "https://custom-upstream.test/v1/chat/completions",
        authStyle: "bearer",
        policy: "convert",
        streamPassthrough: false,
      },
      {
        face: "messages",
        dialect: "anthropic",
        endpointUrl: "https://messages-endpoint.test/anthropic/v1/messages",
        authStyle: "x-api-key",
        policy: "verbatim",
        streamPassthrough: true,
      },
    ]);
  });

  it("policy 省略 ⇒ 面默认；baseUrl 省略 ⇒ 继承主端点（与显式独立 baseUrl 的产出可判别）", () => {
    const inherited = parseResolvedEndpoints(
      row({ type: "custom", baseUrl: CUSTOM_BASE, protocols: JSON.stringify({ messages: {} }) }),
    )[0];
    expect(inherited).toMatchObject({
      policy: "verbatim", // messages 面默认
      streamPassthrough: true, // verbatim ⇒ 直通
      // 继承 CUSTOM_BASE（以 /v1 结尾 ⇒ anthropicMessagesUrl 走 {base}/messages 分支）
      endpointUrl: "https://custom-upstream.test/v1/messages",
      authStyle: "x-api-key",
    });
    // 继承规则的判别面：同一个 face，显式独立 baseUrl（上一用例）与继承（本用例）产出**不同**
    expect(inherited?.endpointUrl).not.toBe("https://messages-endpoint.test/anthropic/v1/messages");

    const chat = parseResolvedEndpoints(
      row({ type: "custom", baseUrl: CUSTOM_BASE, protocols: JSON.stringify({ chat: {} }) }),
    )[0];
    expect(chat).toMatchObject({
      policy: "verbatim", // chat 面默认也是 verbatim
      streamPassthrough: true,
      endpointUrl: "https://custom-upstream.test/v1/chat/completions",
      authStyle: "bearer",
    });
  });

  it("responses 面默认 convert，URL 与探测同款 {base}/responses 且尾斜杠归一", () => {
    const endpoints = parseResolvedEndpoints(
      row({ type: "custom", baseUrl: RESP_BASE, protocols: JSON.stringify({ responses: {} }) }),
    );
    expect(endpoints).toEqual([
      {
        face: "responses",
        dialect: "openai",
        endpointUrl: "https://responses-endpoint.test/v1/responses",
        authStyle: "bearer",
        policy: "convert", // responses 默认转换（D3：Codex Lite 适配不被绕过）
        streamPassthrough: false,
      },
    ]);
  });

  it("completions/embeddings 默认 convert，输出按白名单序", () => {
    const endpoints = parseResolvedEndpoints(
      row({
        type: "custom",
        baseUrl: CUSTOM_BASE,
        protocols: JSON.stringify({ embeddings: {}, completions: {} }),
      }),
    );
    // 声明顺序 embeddings 在前，输出仍是白名单序（确定性：路由扫描可依赖）
    expect(endpoints.map((e) => [e.face, e.policy, e.streamPassthrough])).toEqual([
      ["completions", "convert", false],
      ["embeddings", "convert", false],
    ]);
    expect(endpoints.map((e) => e.endpointUrl)).toEqual([
      "https://custom-upstream.test/v1/completions",
      "https://custom-upstream.test/v1/embeddings",
    ]);
  });

  it("openai 遗留行也能带声明面（面表取代隐式表与 type 无关）", () => {
    const endpoints = parseResolvedEndpoints(
      row({ type: "openai", baseUrl: OPENAI_BASE, protocols: JSON.stringify({ chat: {} }) }),
    );
    expect(endpoints.map((e) => e.face)).toEqual(["chat"]);
    expect(endpoints[0]).toMatchObject({ policy: "verbatim", streamPassthrough: true });
  });
});

describe("parseResolvedEndpoints — fail-fast（数据不变式被绕过写入时的兜底）", () => {
  it("custom ∧ protocols=NULL ⇒ 报错", () => {
    expect(() => parseResolvedEndpoints(row({ type: "custom", protocols: null }))).toThrow(
      EndpointResolutionError,
    );
  });

  it("custom ∧ protocols={} ⇒ 报错（T1 完整不变式：非 NULL 且至少一面）", () => {
    expect(() =>
      parseResolvedEndpoints(row({ type: "custom", protocols: "{}" })),
    ).toThrow(EndpointResolutionError);
  });

  it("protocols 损坏 JSON / 非对象体 ⇒ 报错", () => {
    expect(() =>
      parseResolvedEndpoints(row({ type: "custom", protocols: "{not-json" })),
    ).toThrow(EndpointResolutionError);
    expect(() =>
      parseResolvedEndpoints(row({ type: "custom", protocols: "[1,2]" })),
    ).toThrow(EndpointResolutionError);
  });

  it("白名单外的面键 / 非法 policy ⇒ 报错（DB 直读路径的双层校验）", () => {
    expect(() =>
      parseResolvedEndpoints(
        row({ type: "custom", baseUrl: CUSTOM_BASE, protocols: JSON.stringify({ completions_v2: {} }) }),
      ),
    ).toThrow(EndpointResolutionError);
    expect(() =>
      parseResolvedEndpoints(
        row({ type: "custom", baseUrl: CUSTOM_BASE, protocols: JSON.stringify({ chat: { policy: "passthrough" } }) }),
      ),
    ).toThrow(EndpointResolutionError);
  });

  it("未知 type ∧ protocols=NULL ⇒ 报错（不静默返回空表）", () => {
    expect(() => parseResolvedEndpoints(row({ type: "foo" }))).toThrow(
      EndpointResolutionError,
    );
  });
});

describe("FACE_DEFAULT_POLICY — 面默认表（design §2.2 规则 3 的常数）", () => {
  it("五个面的默认值逐项锁定", () => {
    expect(FACE_DEFAULT_POLICY).toEqual({
      chat: "verbatim",
      completions: "convert",
      embeddings: "convert",
      messages: "verbatim",
      responses: "convert",
    });
  });

  it("两档默认值互异（全表写成同一值时这里变红——直接抄自可判别纪律）", () => {
    expect(FACE_DEFAULT_POLICY.messages).not.toBe(FACE_DEFAULT_POLICY.responses);
    expect(FACE_DEFAULT_POLICY.chat).not.toBe(FACE_DEFAULT_POLICY.completions);
  });
});

describe("PROVIDER_FACES 与 zod 面键同源", () => {
  it("providerProtocolsSchema 的键集与白名单一致（编译期 satisfies 的运行时回声）", () => {
    expect(Object.keys(providerProtocolsSchema.shape).sort()).toEqual(
      [...PROVIDER_FACES].sort(),
    );
  });
});

// ============= zod 写入门禁（create / update 的 .refine 与 strict 面）=============

const createBase = {
  name: "p",
  type: "custom",
  baseUrl: "https://x.test/v1",
  apiKey: "sk-test",
  models: { g: "u" },
} as const;

describe("createProviderInputSchema — T1 fail-fast（批次 P 教训：新字段必须 .refine 放行）", () => {
  it("type=custom 且带非空 protocols ⇒ 通过；缺 protocols / 空 protocols ⇒ 拒绝", () => {
    expect(
      createProviderInputSchema.safeParse({
        ...createBase,
        protocols: { chat: {} },
      }).success,
    ).toBe(true);
    expect(createProviderInputSchema.safeParse({ ...createBase }).success).toBe(false);
    expect(
      createProviderInputSchema.safeParse({ ...createBase, protocols: {} }).success,
    ).toBe(false);
    expect(
      createProviderInputSchema.safeParse({ ...createBase, protocols: null }).success,
    ).toBe(false);
  });

  it("type=openai/anthropic 不带 protocols ⇒ 照常通过（遗留行为零变化）", () => {
    expect(
      createProviderInputSchema.safeParse({
        ...createBase,
        type: "openai",
        protocols: undefined,
      }).success,
    ).toBe(true);
    expect(
      createProviderInputSchema.safeParse({ ...createBase, type: "anthropic" }).success,
    ).toBe(true);
  });

  it("面键白名单 + 面内 strict：未知面键 / 面内未知键 / 非法 policy / 非法 baseUrl ⇒ 拒绝", () => {
    expect(
      createProviderInputSchema.safeParse({
        ...createBase,
        protocols: { chat: {}, completions_v2: {} },
      }).success,
    ).toBe(false);
    expect(
      createProviderInputSchema.safeParse({
        ...createBase,
        protocols: { chat: { spam: 1 } },
      }).success,
    ).toBe(false);
    expect(
      createProviderInputSchema.safeParse({
        ...createBase,
        protocols: { chat: { policy: "passthrough" } },
      }).success,
    ).toBe(false);
    expect(
      createProviderInputSchema.safeParse({
        ...createBase,
        protocols: { chat: { baseUrl: "not-a-url" } },
      }).success,
    ).toBe(false);
  });

  it("preset 通过 create 落字段（省略 = 未标记；用 openai 行避免 T1 refine 误伤本用例）", () => {
    const withPreset = createProviderInputSchema.safeParse({
      ...createBase,
      type: "openai",
      preset: "b.ai",
    });
    expect(withPreset.success).toBe(true);
    if (withPreset.success) {
      expect(withPreset.data.preset).toBe("b.ai");
    }
  });
});

describe("updateProviderInputSchema — null 清除语义与 T1 门禁", () => {
  it("仅 {type:'custom'}（protocols 省略）⇒ 拒绝；带上非空 protocols ⇒ 通过", () => {
    expect(updateProviderInputSchema.safeParse({ type: "custom" }).success).toBe(false);
    expect(
      updateProviderInputSchema.safeParse({
        type: "custom",
        protocols: { messages: { policy: "verbatim" } },
      }).success,
    ).toBe(true);
  });

  it("protocols 显式 null = 清除（回落 type 的遗留面表）；省略 = 不改动 ⇒ 都通过", () => {
    expect(
      updateProviderInputSchema.safeParse({ protocols: null }).success,
    ).toBe(true);
    expect(
      updateProviderInputSchema.safeParse({ type: "openai", protocols: null }).success,
    ).toBe(true);
  });

  it("preset：字符串通过、空串拒绝、显式 null = 清除通过", () => {
    expect(updateProviderInputSchema.safeParse({ preset: "b.ai" }).success).toBe(true);
    expect(updateProviderInputSchema.safeParse({ preset: "" }).success).toBe(false);
    expect(updateProviderInputSchema.safeParse({ preset: null }).success).toBe(true);
  });
});

// ============= 骨架函数（批次 2 消费点）：dialectForFace / supportsProtocol / selectEndpoint =============
//
// 这三个函数是批次 2 五承重点的路由/分支真源。判别纪律：
//   - selectEndpoint 的期望锚定在可辨识字段（face / dialect / endpointUrl / streamPassthrough）——
//     遗留 anthropic 两端点**同 URL**，必须用 face + streamPassthrough 区分，不能只断言「返回了某端点」；
//   - supportsProtocol 的反面用例（遗留 anthropic 的 chat 面**不进** chat 偏好趟）单独成断言——
//     它是「存量多候选池构成不变」零回归红线的直接锁。

describe("dialectForFace — 面 → 原生方言全表（直通门的入站方言真源）", () => {
  it("五个面逐项锁定：仅 messages 是 anthropic 方言，其余全 openai", () => {
    expect(dialectForFace("messages")).toBe("anthropic");
    expect(dialectForFace("chat")).toBe("openai");
    expect(dialectForFace("completions")).toBe("openai");
    expect(dialectForFace("embeddings")).toBe("openai");
    expect(dialectForFace("responses")).toBe("openai");
  });
});

describe("supportsProtocol — 偏好趟门（design §2.2 规则 1 + §4.2）", () => {
  const openaiResolved = parseResolvedEndpoints(row({ type: "openai", baseUrl: OPENAI_BASE }));
  const anthropicResolved = parseResolvedEndpoints(
    row({ type: "anthropic", baseUrl: ANTHROPIC_BASE }),
  );

  it("遗留 openai 行：三 openai 面命中 + responses 经 openai 方言 chat 面等价命中；messages 不命中", () => {
    expect(supportsProtocol(openaiResolved, "chat")).toBe(true);
    expect(supportsProtocol(openaiResolved, "completions")).toBe(true);
    expect(supportsProtocol(openaiResolved, "embeddings")).toBe(true);
    expect(supportsProtocol(openaiResolved, "responses")).toBe(true);
    expect(supportsProtocol(openaiResolved, "messages")).toBe(false);
  });

  it("遗留 anthropic 行：仅 messages 命中——anthropic 方言 chat 面**不得**进 chat 偏好趟（零回归红线：存量候选池构成不变）", () => {
    expect(supportsProtocol(anthropicResolved, "messages")).toBe(true);
    expect(supportsProtocol(anthropicResolved, "chat")).toBe(false);
    expect(supportsProtocol(anthropicResolved, "completions")).toBe(false);
    expect(supportsProtocol(anthropicResolved, "embeddings")).toBe(false);
    expect(supportsProtocol(anthropicResolved, "responses")).toBe(false);
  });

  it("声明面：仅声明 chat 的 custom 行命中 chat 与 responses（等价支），不命中 messages/completions", () => {
    const chatOnly = parseResolvedEndpoints(
      row({ type: "custom", baseUrl: CUSTOM_BASE, protocols: JSON.stringify({ chat: {} }) }),
    );
    expect(supportsProtocol(chatOnly, "chat")).toBe(true);
    expect(supportsProtocol(chatOnly, "responses")).toBe(true);
    expect(supportsProtocol(chatOnly, "messages")).toBe(false);
    expect(supportsProtocol(chatOnly, "completions")).toBe(false);
  });
});

describe("selectEndpoint — 单候选活跃端点（design §3 行 2 / §4.2 选择规则）", () => {
  const openaiResolved = parseResolvedEndpoints(row({ type: "openai", baseUrl: OPENAI_BASE }));
  const anthropicResolved = parseResolvedEndpoints(
    row({ type: "anthropic", baseUrl: ANTHROPIC_BASE }),
  );
  const messagesOnly = parseResolvedEndpoints(
    row({ type: "custom", baseUrl: MSG_BASE, protocols: JSON.stringify({ messages: {} }) }),
  );
  const chatAndMessages = parseResolvedEndpoints(
    row({
      type: "custom",
      baseUrl: CUSTOM_BASE,
      protocols: JSON.stringify({ chat: {}, messages: {} }),
    }),
  );

  it("规则 1 原生面：遗留 anthropic × messages 入站 → messages 面（convert + 直通，今天 P2a 的恒等复现）", () => {
    expect(selectEndpoint(anthropicResolved, "messages", "chat")).toMatchObject({
      face: "messages",
      dialect: "anthropic",
      policy: "convert",
      streamPassthrough: true,
    });
  });

  it("入站面与面方言不配时不走原生支：anthropic 行 × chat 入站 → byKind 落 anthropic 方言 chat 面（非直通）", () => {
    expect(selectEndpoint(anthropicResolved, "chat", "chat")).toMatchObject({
      face: "chat",
      dialect: "anthropic",
      streamPassthrough: false,
    });
  });

  it("规则 2 responses 等价：遗留 openai × responses 入站 → openai 方言 chat 面承载（/v1/responses 既有路径）", () => {
    expect(selectEndpoint(openaiResolved, "responses", "chat")).toMatchObject({
      face: "chat",
      dialect: "openai",
      endpointUrl: "https://openai-upstream.test/v1/chat/completions",
    });
  });

  it("responses 原生面优先于等价支：同时声明 chat+responses 的行 × responses 入站 → responses 面", () => {
    const both = parseResolvedEndpoints(
      row({
        type: "custom",
        baseUrl: RESP_BASE,
        protocols: JSON.stringify({ chat: {}, responses: {} }),
      }),
    );
    expect(selectEndpoint(both, "responses", "chat")).toMatchObject({ face: "responses" });
  });

  it("规则 3 跨方言兜底：仅 messages 面的行 × chat 入站（或缺省）→ messages 面承载（回退趟转换）", () => {
    expect(selectEndpoint(messagesOnly, "chat", "chat")).toMatchObject({
      face: "messages",
      dialect: "anthropic",
    });
    expect(selectEndpoint(messagesOnly, undefined, "chat")).toMatchObject({
      face: "messages",
    });
  });

  it("规则 3 同名面：遗留 openai × 缺省入站 → 各 internal kind 落同名面（URL 互异可判别）", () => {
    expect(selectEndpoint(openaiResolved, undefined, "chat")?.endpointUrl).toBe(
      "https://openai-upstream.test/v1/chat/completions",
    );
    expect(selectEndpoint(openaiResolved, undefined, "completions")?.endpointUrl).toBe(
      "https://openai-upstream.test/v1/completions",
    );
    expect(selectEndpoint(openaiResolved, undefined, "embeddings")?.endpointUrl).toBe(
      "https://openai-upstream.test/v1/embeddings",
    );
  });

  it("原生支优先于 byKind：chat+messages 双面行 × messages 入站 → messages 面（非 chat 面）", () => {
    expect(selectEndpoint(chatAndMessages, "messages", "chat")).toMatchObject({
      face: "messages",
      streamPassthrough: true,
    });
  });

  it("不支持 ⇒ null：遗留 anthropic 对 completions/embeddings 仍拒（:615 的 400 语义）", () => {
    expect(selectEndpoint(anthropicResolved, "completions", "completions")).toBeNull();
    expect(selectEndpoint(anthropicResolved, undefined, "embeddings")).toBeNull();
    expect(selectEndpoint(messagesOnly, "completions", "completions")).toBeNull();
  });
});
