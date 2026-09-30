// preset 档案常量表（09-28-upstream-custom-type-passthrough 批次 5，design §2.4）。
//
// **代码 const，不是 DB 表、不做管理台 CRUD、不走 render 生成**（用户裁决 2026-09-28）：
// 厂商 URL 形态 / 认证风格是**人工核定的事实**，没有可解析的上游数据源——权威就是这份
// 档案本身。modelcaps（src/generated/modelcaps.ts）之所以是生成物，是因为它有 seed.sql
// 权威源需要派生；preset 没有，生成一步只会多出第二个要维护的地方。
// fail-fast 精神的等价物：**整表 schema 校验单测**（tests/provider-presets.unit.test.ts）——
// 面键白名单 / URL 形态 / 枚举值 / 档案两两不等，坏一条档案测试即红。
//
// **quirk 类字段不进 preset**（quirk-adjudication.md §9）：reasoning_roundtrip /
// max_tokens clamp / httpOptions 覆盖 / models 映射是 per-provider（甚至 per-model）事实，
// 不是 per-vendor 恒真（b.ai 聚合下 glm clamp 3000 而 gpt 系拒绝 reasoning_content）。
// preset 只承载无争议项：协议矩阵、逐面 baseUrl 模板（**一律写完整路径**，含 /v1 等
// 版本段——09-17 research/baseurl-shape-finding.md §2.2）、逐面 policy 默认、认证风格、
// 建议超时起点。
//
// **运行时零分支**（AC2）：本表只被管理台常量端点（GET /api/providers/presets）与建档
// 预填消费；proxy.ts / 适配器层不得出现任何厂商名分支——出现即 AC2 红线被破。
import { z } from "zod";
import type { ProviderFace } from "./endpoints";

// ============= 档案形态（schema 即契约）=============

/** 单面档案。policy 必填（预填进 protocols JSON 的显式值，不依赖解析层默认的隐式知识）。 */
const presetFaceSchema = z
  .object({
    /** 该面端点 base（**完整路径**，含 /v1 或厂商自有路径段）。省略 = 继承主端点 baseUrl
     * （β 形态同 base 上游的写法；解析层对 verbatim 面用它拼 URL）。 */
    baseUrl: z.string().url().max(500).optional(),
    /** 逐面 policy 默认（chat/messages = verbatim，responses = convert，D3）。
     * 注意：convert 面运行时一律打主端点——面内 baseUrl 仅在 verbatim 下生效，
     * convert 面写 baseUrl 是「描述该面原生端点」的文档性声明。 */
    policy: z.enum(["verbatim", "convert"]),
    /** 该面官方文档的认证风格（advisory，数据完整性用）：网关侧 openai 方言默认 bearer、
     * anthropic 方言默认 x-api-key；与文档不符的厂商（如 z.ai 用 Bearer）经
     * httpOptions.headers 显式覆盖。未提取到官方证据的面不带本字段。 */
    authStyle: z.enum(["bearer", "x-api-key"]).optional(),
  })
  .strict();

// 面键闭集（与解析真源 ProviderFace 编译期锁死——同 routes/providers/types.ts 的 satisfies 惯例）
const presetFaceEntries = {
  chat: presetFaceSchema.optional(),
  completions: presetFaceSchema.optional(),
  embeddings: presetFaceSchema.optional(),
  messages: presetFaceSchema.optional(),
  responses: presetFaceSchema.optional(),
} satisfies Record<ProviderFace, unknown>;

const presetFacesSchema = z.object(presetFaceEntries).strict();

export const providerPresetArchiveSchema = z
  .object({
    /** preset 标签值：写进 providers.preset 列（数据非代码，D1）。 */
    id: z.string().min(1).max(100),
    /** UI 展示名。 */
    label: z.string().min(1).max(100),
    /** 建档主端点（baseUrl 输入框的预填值）。 */
    baseUrl: z.string().url().max(500),
    /** 协议矩阵：出现某面 = 预填该面声明。completions/embeddings 面在七条档案中均缺席
     * ——两轮调研矩阵只实证了 chat/messages/responses，缺证据的面不预填（宁缺毋假）。 */
    faces: presetFacesSchema,
    /** 建议超时起点（ms）。**建议值不是约束**——quirk 类微调仍 per-provider 手配。 */
    suggestedTimeoutMs: z.number().int().min(1000).max(600_000),
    /** 证据来源（仓内研究文档路径 + 章节）。 */
    source: z.string().min(1),
    /** 人工核定日期（ISO date，YYYY-MM-DD）。 */
    reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** 实测缺口 / 注意事项（管理台展示）。 */
    notes: z.string().min(1).optional(),
  })
  .strict();

export type ProviderPresetArchive = z.infer<typeof providerPresetArchiveSchema>;
export type ProviderPresetFace = z.infer<typeof presetFaceSchema>;

// ============= 档案本体（七条：deepseek / moonshot / openrouter / b.ai / kimi / z.ai / minimax）=============
// 值的纪律：**只写有出处的值**。两轮调研（industry-survey.md 09-07 / industry-survey-2.md
// 09-15）+ baseurl-shape-finding.md（09-17 事故实证）+ proxy-protocols.md §19（b.ai 超时实测）；
// 证据缺口不编造（kimi 的 messages/responses URL、minimax messages 认证、b.ai messages 认证
// 待探针 P1'/P1''）——缺的字段留空 + notes 写明，等实测后补。
export const PROVIDER_PRESETS: readonly ProviderPresetArchive[] = [
  {
    // α 三角全满（09-15 复核后从 γ 升 α 全满）。responses 面挂根 base（官方形态，/responses
    // 由解析层 openaiFaceUrl 拼接）且**无状态**——design §3.3 无状态 400 拒绝红线天然同构。
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    faces: {
      chat: { policy: "verbatim" },
      messages: {
        baseUrl: "https://api.deepseek.com/anthropic",
        policy: "verbatim",
        authStyle: "x-api-key",
      },
      responses: { baseUrl: "https://api.deepseek.com", policy: "convert" },
    },
    suggestedTimeoutMs: 60_000,
    source:
      ".trellis/tasks/09-07-upstream-adapter-optimization/research/industry-survey-2.md §3 矩阵行 DeepSeek（α 三角全满）+ §1#4（Responses 无状态红线）+ §2.6#1（messages 面认证 x-api-key + anthropic-version）；baseUrl 形态另见 baseurl-shape-finding.md §2.2",
    reviewedAt: "2026-09-15",
    notes:
      "Responses face is stateless (store forced false; previous_response_id/conversation rejected 400; no data:[DONE] sentinel; deepseek-flash only). Messages face documents x-api-key + anthropic-version. The responses face is prefilled with policy=convert, which always hits the record's base URL — flip it to verbatim (after probing) for the root-base /responses endpoint to take effect. Thinking models need reasoningRoundtrip=true — set per record (quirk fields are intentionally not in presets).",
  },
  {
    // α：messages 面路径分叉。官方 Claude Code 指南给出 ANTHROPIC_BASE_URL=…/anthropic
    //（SDK 向 base 拼 /v1/messages ⇒ 解析层 anthropicMessagesUrl 语义一致）。
    id: "moonshot",
    label: "Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    faces: {
      chat: { policy: "verbatim" },
      messages: {
        baseUrl: "https://api.moonshot.ai/anthropic",
        policy: "verbatim",
        authStyle: "bearer",
      },
    },
    suggestedTimeoutMs: 60_000,
    source:
      ".trellis/tasks/09-07-upstream-adapter-optimization/research/industry-survey.md §1（官方 Claude Code 指南 platform.moonshot.ai/docs/guide/anthropic-support）；认证风格：industry-survey-2.md §2.6#3（平台示例 Authorization: Bearer）",
    reviewedAt: "2026-09-15",
    notes:
      "Platform examples use Authorization: Bearer $MOONSHOT_API_KEY. A Responses face is documented on the new platform (see the kimi archive) but this archive predates the platform migration — declare extra faces only after probing.",
  },
  {
    // β 同 base 自动路由（聚合商）。/api/v1 双段——09-17 stg 事故正是漏了 /v1（配成 /api
    // ⇒ 全部 9 个模型名 404）。messages 面认证待探针 P1'。
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    faces: {
      chat: { policy: "verbatim" },
      messages: { policy: "verbatim" },
      responses: { policy: "convert" },
    },
    suggestedTimeoutMs: 60_000,
    source:
      "baseUrl：.trellis/tasks/09-07-upstream-adapter-optimization/research/baseurl-shape-finding.md §2.2（09-17 stg 事故实证，/api/v1 双段）；协议矩阵：industry-survey-2.md §2#3 + §3（β 同 base，官方 Responses 章节）",
    reviewedAt: "2026-09-17",
    notes:
      "Aggregator (same base, request-shape routing). Messages-face auth is pending probe P1' (whether an explicit Authorization header override is needed); chat face unaffected either way.",
  },
  {
    // β 同 base（仓内实证：anthropic 端点由网关 stg 在用）。遮蔽代号上游，无公开文档
    // ⇒ responses 面不可查、messages 认证待 P1'。120s 超时是 §19 实测起点（~37 t/s）。
    id: "b.ai",
    label: "b.ai (aggregator)",
    baseUrl: "https://api.b.ai/v1",
    faces: {
      chat: { policy: "verbatim" },
      messages: { policy: "verbatim" },
    },
    suggestedTimeoutMs: 120_000,
    source:
      "baseUrl：.trellis/tasks/09-07-upstream-adapter-optimization/research/baseurl-shape-finding.md §2.2（仓内实证）；同 base 矩阵：industry-survey.md §1 + industry-survey-2.md §3；超时 120s：.trellis/spec/backend/proxy-protocols.md §19（b.ai ×5 实测）",
    reviewedAt: "2026-09-17",
    notes:
      "Masked-codename aggregator — no public docs (Responses face unverifiable, omitted). Slow long-generation models (glm-5.3-flash ~37 tok/s) exhaust the 60s default; 120s is the measured starting point. Per-model quirks (max_output clamp, reasoning_content rejection) stay per-record. Messages-face auth pending probe P1' (404-vs-401).",
  },
  {
    // 新平台（platform.kimi.ai）：chat 官方仍挂 api.moonshot.ai/v1；Responses/Messages
    // 专页存在但端点 URL 未提取 ⇒ 两面都不预填（宁缺毋假，与 moonshot 档案互补）。
    id: "kimi",
    label: "Kimi (platform.kimi.ai)",
    baseUrl: "https://api.moonshot.ai/v1",
    faces: {
      chat: { policy: "verbatim" },
    },
    suggestedTimeoutMs: 60_000,
    source:
      ".trellis/tasks/09-07-upstream-adapter-optimization/research/industry-survey-2.md §2#1 + §3 矩阵行 Moonshot/Kimi（平台迁移与三类端点并存，2026-09-15）",
    reviewedAt: "2026-09-15",
    notes:
      "New platform (platform.kimi.ai) documents Chat Completions on api.moonshot.ai/v1 plus Responses and Messages API doc pages, but those endpoint URLs were not extracted — faces omitted rather than invented; probe before declaring. Bearer-style auth (Authorization: Bearer $MOONSHOT_API_KEY).",
  },
  {
    // α：messages 面官方坐实 https://api.z.ai/api/anthropic；chat 面 = 同域 + 官方文档的
    // 相对路径 /api/paas/v4。认证 Bearer（ANTHROPIC_AUTH_TOKEN）——与网关 anthropic 方言
    // 默认 x-api-key 不同，需 httpOptions.headers 覆盖。
    id: "z.ai",
    label: "Z.ai (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    faces: {
      chat: { policy: "verbatim" },
      messages: {
        baseUrl: "https://api.z.ai/api/anthropic",
        policy: "verbatim",
        authStyle: "bearer",
      },
    },
    suggestedTimeoutMs: 60_000,
    source:
      ".trellis/tasks/09-07-upstream-adapter-optimization/research/industry-survey-2.md §1#1（docs.z.ai 官方实证，2026-09-15）+ §3（chat 面 /api/paas/v4；host 取自 #1 同一官方域）",
    reviewedAt: "2026-09-15",
    notes:
      "Claude Code guide documents ANTHROPIC_AUTH_TOKEN (bearer style) for the anthropic face — the gateway's anthropic dialect sends x-api-key by default, so add an Authorization header via HTTP options if the upstream rejects it. No Responses face (not provided).",
  },
  {
    // α：双 URL 官方坐实（09-15 复核从 ⚠ 升 ✅）；messages 认证两轮均未提取到显式 auth 行 ⚠。
    id: "minimax",
    label: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    faces: {
      chat: { policy: "verbatim" },
      messages: { baseUrl: "https://api.minimax.io/anthropic", policy: "verbatim" },
    },
    suggestedTimeoutMs: 60_000,
    source:
      ".trellis/tasks/09-07-upstream-adapter-optimization/research/industry-survey-2.md §1#2（platform.minimax.io 官方实证，2026-09-15）+ §3 矩阵行 MiniMax（α 路径分叉）",
    reviewedAt: "2026-09-15",
    notes:
      "Anthropic-compat endpoint officially confirmed (platform.minimax.io). Auth style was not extracted in either survey round — gateway default (x-api-key) applies until verified. No Responses face (not provided).",
  },
];
