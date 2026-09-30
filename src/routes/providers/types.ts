// Provider 管理模块（M3 3.2，admin）：Zod schema + 类型定义。
import { z } from "zod";
import type { ProviderFace } from "../../providers/endpoints";
import { providerPresetArchiveSchema } from "../../providers/presets";

// 09-28-upstream-custom-type-passthrough D1：type 增第三值 custom（闭集）——
// 「OpenAI/Anthropic 兼容的其余上游」。custom 行**必须**带 protocols 声明（.refine 拦），
// 运行时行为由解析真源 src/providers/endpoints.ts 决定，type/preset 不参与运行时分支（AC2）。
export const providerTypeSchema = z.enum(["openai", "anthropic", "custom"]);

/** models 路由映射：内部模型名 -> 上游模型名（JSON 落库）。 */
export const modelsMapSchema = z
  .record(z.string(), z.string())
  .refine((m) => Object.keys(m).length > 0, {
    message: "At least one model mapping is required",
  });

/** 负载均衡权重：多 provider 供同一模型时按比例分配（1-1000，默认 1 均分）。 */
export const providerWeightSchema = z.number().int().min(1).max(1000);

/** 思考模式（R2 + H3/H6）：NULL ≡ 不映射（零变更契约，未配置不注入 thinking）；枚举校验拦非法值。 */
export const thinkingModeSchema = z
  .enum(["adaptive", "budget", "off"])
  .nullable();

/** reasoning 回传（Workstream B）：true → 保留 assistant.reasoning_content 给上游
 * （deepseek 思考模式要求回传）；false/省略 → 剥离（默认，上游零变化）。 */
export const reasoningRoundtripSchema = z.boolean();

/** 上游超时（毫秒，09-01-stg-glm-ccswitch-fix）：NULL ≡ 默认 60s。
 * 慢模型长生成（如 b.ai glm-5.3-flash）按 provider 调大，防 60s 默认超时切断。 */
export const upstreamTimeoutMsSchema = z
  .number()
  .int()
  .min(1_000)
  .max(600_000)
  .nullable();

/** Header 名：RFC 7230 token 字符集（防注入）。 */
const httpHeaderNameSchema = z
  .string()
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, {
    message: "Invalid HTTP header name",
  });

/** Header 值：禁 CR/LF（响应头注入防护），长度上限。 */
const httpHeaderValueSchema = z
  .string()
  .max(2000)
  .refine((v) => !v.includes("\r") && !v.includes("\n"), {
    message: "Header value must not contain CR/LF",
  });

// ============= 协议面声明（09-28-upstream-custom-type-passthrough）=============

/** 单个面的声明（design §2.2）：baseUrl 省略 ⇒ 继承主端点 base_url（**不复制 URL**，
 * 避免两份漂移）；policy 省略 ⇒ 取该面默认（FACE_DEFAULT_POLICY：messages/chat = verbatim，
 * 其余 = convert）。strict：面内未知键暂不放行——接受了不消费的字段等于静默撒谎
 * （enabled/timeoutMs 等演进口子出现时在这里显式加）。 */
const providerProtocolFaceSchema = z
  .object({
    baseUrl: z.string().url().max(500).optional(),
    policy: z.enum(["verbatim", "convert"]).optional(),
  })
  .strict();

// 键集与解析真源的 ProviderFace **编译期锁死**（satisfies）：新增面必须两处同步，
// 否则这里 typecheck 红——与 PROBE_FACES 同一漂移防线，只是方向相反
// （那里是本模块为真源、probe 取类型；这里解析真源在 providers/endpoints.ts）。
const protocolFaceEntries = {
  chat: providerProtocolFaceSchema.optional(),
  completions: providerProtocolFaceSchema.optional(),
  embeddings: providerProtocolFaceSchema.optional(),
  messages: providerProtocolFaceSchema.optional(),
  responses: providerProtocolFaceSchema.optional(),
} satisfies Record<ProviderFace, unknown>;

/** 协议面声明：出现某面 = 声明该上游支持该面（不出现 ⇒ 路由不命中该面）。
 * 声明面**完全取代** type 的隐式面表（不做并集，design §2.2 规则 1）；strict 拒绝
 * 白名单外的面键。JSON 落库（providers.protocols，与 models 列同惯例）。 */
export const providerProtocolsSchema = z.object(protocolFaceEntries).strict();

/** 厂商身份标签（D1）：独立列、数据非代码。可空 = 未标记；仅作建档预填来源，
 * **运行时零感知**——档案本体是代码 const（src/providers/presets.ts，批次 5）。 */
export const providerPresetSchema = z.string().min(1).max(100).nullable();

/** T1 数据不变式（fail-fast，两处输入 schema 共用）：type=custom ⇒ protocols 非 NULL
 * 且至少声明一个面。没有可解析端点的 custom 行进不了库（解析真源对这种组合直接报错），
 * 与其让坏行落库后由运行时炸，不如在读写两侧同时拒绝。 */
function requireProtocolsForCustom(v: {
  type?: string;
  protocols?: object | null;
}): boolean {
  if (v.type !== "custom") return true;
  if (v.protocols === null || v.protocols === undefined) return false;
  return Object.keys(v.protocols).length > 0;
}

/**
 * 高级 HTTP 选项（PRD R2）：覆盖 User-Agent、强制覆盖/新增 Header 与 body 字段。
 * headers 值可能含上游认证信息 → DB 中 AES-GCM 加密存储；API 响应值一律掩码。
 */
export const httpOptionsSchema = z
  .object({
    userAgent: z.string().max(500).optional(),
    headers: z.record(httpHeaderNameSchema, httpHeaderValueSchema).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const createProviderInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    type: providerTypeSchema,
    baseUrl: z.string().url().max(500),
    apiKey: z.string().min(1).max(1000),
    models: modelsMapSchema,
    // 厂商标签：省略 = 未标记（D1 数据非代码）
    preset: providerPresetSchema.optional(),
    // 协议面声明：省略 = NULL（遗留等价面表按 type 生效）
    protocols: providerProtocolsSchema.optional(),
    enabled: z.boolean().default(true),
    weight: providerWeightSchema.default(1),
    httpOptions: httpOptionsSchema.optional(),
    thinkingMode: thinkingModeSchema.optional(),
    reasoningRoundtrip: reasoningRoundtripSchema.optional(),
    upstreamTimeoutMs: upstreamTimeoutMsSchema.optional(),
  })
  .refine(requireProtocolsForCustom, {
    message: "type=custom requires a protocols declaration with at least one face",
  });


export const updateProviderInputSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    type: providerTypeSchema.optional(),
    baseUrl: z.string().url().max(500).optional(),
    // 更新时若提供则重新加密；省略则保持原密文
    apiKey: z.string().min(1).max(1000).optional(),
    models: modelsMapSchema.optional(),
    // 厂商标签：显式传 null = 清除（省略 = 不改动）
    preset: providerPresetSchema.optional(),
    // 协议面声明：显式传 null = 清除（回落 type 的遗留等价面表）；整体替换（省略 = 不改动）
    protocols: providerProtocolsSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    weight: providerWeightSchema.optional(),
    // 更新时整体替换（省略保持原密文，与 apiKey 语义一致）
    httpOptions: httpOptionsSchema.optional(),
    // 显式传 null = 重置为不映射（H3；省略 = 不改动）
    thinkingMode: thinkingModeSchema.optional(),
    // 显式传 false = 关闭回传（省略 = 不改动）
    reasoningRoundtrip: reasoningRoundtripSchema.optional(),
    // 显式传 null = 重置为默认 60s（省略 = 不改动）
    upstreamTimeoutMs: upstreamTimeoutMsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  })
  .refine(requireProtocolsForCustom, {
    message: "type=custom requires a protocols declaration with at least one face",
  });

export const providerIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ============= 输出 Schemas =============

/** 响应形态：headers 值为掩码（`****abcd`），body 与 userAgent 明文。 */
export const httpOptionsResponseSchema = z.object({
  userAgent: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  body: z.record(z.string(), z.unknown()),
});

export const providerResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  // 09-28 custom：与输入枚举同步（响应侧仅类型层面；实际响应由 toProviderResponse 构造，本批次未动）
  type: z.enum(["openai", "anthropic", "custom"]),
  baseUrl: z.string(),
  // 如 `sk-mock-ope****`；明文永不下发。**空串 = 该行未配置上游密钥**（不是 `"****"`）——
  // 前端据此渲染「未配置」标记而不是看起来像掩码的星号（R-A15/A16）
  apiKeyMasked: z.string(),
  models: z.record(z.string(), z.string()),
  weight: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
  // 思考模式（R2）：null ≡ auto（adaptive 线优先）
  thinkingMode: z.enum(["adaptive", "budget", "off"]).nullable(),
  // reasoning 回传（Workstream B）：openai 面上游是否接收 assistant.reasoning_content
  reasoningRoundtrip: z.boolean(),
  // 上游超时（毫秒；null ≡ 默认 60s）
  upstreamTimeoutMs: z.number().int().min(1_000).max(600_000).nullable(),
  // 高级 HTTP 选项（headers 值掩码；未配置为空对象）
  httpOptions: httpOptionsResponseSchema,
  // 09-28 批次 5（AC1 后半）：preset 标签与协议面声明。**null ⇒ 整键省略**（不是输出
  // null）——存量行（两列全 NULL）的响应逐字节不变，旧客户端零感知；输出 schema 用
  // optional 表达「键可缺席」，写入侧的省略逻辑在 toProviderResponse（lib/convert.ts）。
  preset: z.string().optional(),
  protocols: providerProtocolsSchema.optional(),
  // 断路器状态（仅 list 返回）：provider 当前是否处于断路窗口（TTL 内跳过分配）
  circuitBroken: z.boolean().optional(),
  circuitReason: z.string().optional(),
  createdAt: z.string(),
});

export const createProviderOutputSchema = z.object({
  success: z.literal(true),
  provider: providerResponseSchema,
});

export const listProvidersOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(providerResponseSchema),
});

/** GET /api/providers/presets 的输出契约（批次 5）：档案本体是代码 const
 *（src/providers/presets.ts 的 providerPresetArchiveSchema），这里只包一层信封——
 * 前端类型从本文件推导（不做前后端共享 import，design §2.4）。 */
export const listProviderPresetsOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(providerPresetArchiveSchema),
});

export const updateProviderOutputSchema = z.object({
  success: z.literal(true),
  provider: providerResponseSchema,
});

export const deleteProviderOutputSchema = z.object({
  success: z.literal(true),
});

// ============= 协议面探测（批次 N 建；批次 6 改逐面探测，2026-09-29）=============

/**
 * 探测行身份 = **协议面**（face）+ 原生协议方言（dialect）。批次 6 起探测按解析层的
 * resolved 端点集**逐面出**（`parseResolvedEndpoints`：legacy 记录按遗留等价面表展开
 * —— openai 三行 chat/completions/embeddings、anthropic 两行 chat/messages；custom 记录
 * 按声明面逐面一行），不再有跨协议侦察的固定三行。每一行都是解析层判定该面可达的 URL
 * ⇒「探测绿 = 生产同 URL」在行级成立（唯一例外=声明 responses×convert：该行打原生
 * /responses，convert 生产走 chat 出站——批次 6 边界 K）；旧版「/responses 行无生产
 * 对应物」的 D11 口径随逐面探测消失（未声明 responses 面的记录不再有该行）。
 *
 * 面值闭集与服务端解析真源 `PROVIDER_FACES`（src/providers/endpoints.ts）**同值两处**：
 * 契约层不做运行时 import（会把 openai/anthropic 适配器拖进前端 bundle）。两边一致性由
 * `tests/provider-declare-endpoint.test.ts` 的交叉校验单测守（解析真源改面集这里立刻红）；
 * `protocolFaceEntries` 的 `satisfies Record<ProviderFace, unknown>` 提供编译期反方向锁。
 */
export const PROBE_FACES = [
  "chat",
  "completions",
  "embeddings",
  "messages",
  "responses",
] as const satisfies readonly ProviderFace[];

export const probeFaceSchema = z.enum(PROBE_FACES);

export const probeDialectSchema = z.enum(["openai", "anthropic"]);

export const providerProbeResultSchema = z.object({
  /** 探测的面（解析层 resolved 端点的 face；一行一面，行序 = 面白名单序）。 */
  face: probeFaceSchema,
  /** 该面端点的原生协议方言（决定 URL 规则与鉴权头风格）。 */
  dialect: probeDialectSchema,
  label: z.string(),
  /** 实际请求的 URL（密钥只在 header 里，故回显安全）。 */
  url: z.string(),
  ok: z.boolean(),
  /** 网络层失败（DNS/连接/超时）时为 null —— 此时没有 HTTP 状态可言。 */
  status: z.number().int().nullable(),
  statusText: z.string().nullable(),
  ttfbMs: z.number().int(),
  totalMs: z.number().int(),
  error: z.string().nullable(),
});

export const testProviderOutputSchema = z.object({
  success: z.literal(true),
  /** 探测所用的上游模型名（provider 映射表的第一个值）。 */
  model: z.string(),
  /** 本次探测实际使用的超时（= min(provider 配置值 ?? 60s, 30s 上限)，随响应回传以免成为隐藏的谎）。 */
  timeoutMs: z.number().int(),
  probes: z.array(providerProbeResultSchema),
});

/**
 * 联通性 ping 的结果（批次 O）—— **与 `providerProbeResultSchema` 是两个东西**：
 * 字段名高度重合（status/statusText/ttfbMs/totalMs/error）纯属巧合，
 * **`reachable` 与 `ok` 的谓词不同**（前者＝收到任何 HTTP 回应，后者＝2xx）。
 * 故这里**刻意不带** `face` / `label` / `ok`：结构性挡住「把 ping 结果并进 probes 数组」
 * 或「抽一个共用 result 类型」的重构 —— 那会让「上游拒绝了这次调用」被读成「网络不通」，
 * 而这正是本功能要消除的混淆。
 *
 * 无鉴权、无 body ⇒ 不回显任何可泄漏字段；`url` 只回 origin 根（连 baseUrl 的
 * path/query/userinfo 都不带出去）。
 */
export const providerPingResultSchema = z.object({
  /** 实际请求的 URL（origin 根）。baseUrl 非法时为 null —— 「输入非法」与「网络失败」唯一的可判别字段。 */
  url: z.string().nullable(),
  /** 收到**任何** HTTP 回应（含 401/403/404）⇒ true。不表示上游接受了调用，更不表示凭据有效。 */
  reachable: z.boolean(),
  /** 网络层失败（DNS/连接/TLS/超时）时为 null —— 此时没有 HTTP 状态可言。 */
  status: z.number().int().nullable(),
  statusText: z.string().nullable(),
  ttfbMs: z.number().int(),
  totalMs: z.number().int(),
  error: z.string().nullable(),
});

export const pingProviderOutputSchema = z.object({
  success: z.literal(true),
  /** 本次 ping 实际使用的超时（扁平 10s 上限，**不从 provider 的 upstreamTimeoutMs 派生**），
   *  随响应回传以免成为隐藏的谎。 */
  timeoutMs: z.number().int(),
  ping: providerPingResultSchema,
});

// ============= 「声明此端点」（批次 6 G2，design §6.2）=============

/**
 * POST /api/providers/:id/declare-endpoint 的输入。探测只回显（无副作用），声明是
 * **显式人工动作**才写库；本 schema 的窄面 + 路由实现共同保证**只可能写 protocols 子对象**
 * ——models / quirk / type 没有任何进入写入的通道（AC11 由输入窄面结构性保证，不靠调用方自觉）。
 *
 * 合并语义（merge，不是该面的整体替换）：baseUrl / policy 省略 ⇒ 保留该面已有声明的
 * 对应字段（重新声明幂等，不会把已声明的自定义 baseUrl 抹掉）；新面两者皆省略 ⇒ 空声明
 * `{}`（baseUrl 继承主端点、policy 取面默认 FACE_DEFAULT_POLICY——与「不复制 URL」规则一致）。
 *
 * ⚠ 解析语义（UI 必须转述给用户）：声明面**完全取代**隐式面表（design §2.2 规则 1，
 * 批次 5 边界 J）——对 legacy 记录声明一个面会把隐式面表的其余面挤出路由偏好。
 */
export const declareEndpointInputSchema = z
  .object({
    face: probeFaceSchema,
    baseUrl: z.string().url().max(500).optional(),
    policy: z.enum(["verbatim", "convert"]).optional(),
  })
  .strict();

export const declareEndpointOutputSchema = z.object({
  success: z.literal(true),
  provider: providerResponseSchema,
});

// ============= 类型导出 =============

export type ProviderType = z.infer<typeof providerTypeSchema>;
export type ProviderProtocols = z.infer<typeof providerProtocolsSchema>;
export type ProviderPresetArchive = z.infer<typeof providerPresetArchiveSchema>;
export type ThinkingMode = z.infer<typeof thinkingModeSchema>;
export type CreateProviderInput = z.infer<typeof createProviderInputSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderInputSchema>;
export type ProviderResponse = z.infer<typeof providerResponseSchema>;
export type ListProviderPresetsOutput = z.infer<typeof listProviderPresetsOutputSchema>;
export type ProbeFace = z.infer<typeof probeFaceSchema>;
export type ProbeDialect = z.infer<typeof probeDialectSchema>;
export type ProviderProbeResult = z.infer<typeof providerProbeResultSchema>;
export type TestProviderOutput = z.infer<typeof testProviderOutputSchema>;
export type DeclareEndpointInput = z.infer<typeof declareEndpointInputSchema>;
export type DeclareEndpointOutput = z.infer<typeof declareEndpointOutputSchema>;
export type ProviderPingResult = z.infer<typeof providerPingResultSchema>;
export type PingProviderOutput = z.infer<typeof pingProviderOutputSchema>;
