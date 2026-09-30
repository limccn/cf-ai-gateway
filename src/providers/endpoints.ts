// 解析后端点（09-28-upstream-custom-type-passthrough 批次 1）：providers 行 → ResolvedEndpoint[]。
// 设计真源：任务 design.md §2.1-§2.3。本模块是「type / preset 不参与运行时分支」（AC2）的支点：
// 路由选择 / 适配器选择 / 流式直通 / 计费 detector（批次 2+ 接入）一律消费这里的解析产物，
// 而不是读 provider.type 原值做分支。
//
// 遗留等价规则（本批次的**核心断言面**，零回归红线）：
//   protocols=NULL ∧ type=openai    ⇒ 恰 3 端点 {chat, completions, embeddings}，全部
//                                      policy=convert ∧ streamPassthrough=false，
//                                      URL = openaiEndpointUrl(base_url, kind)（与今天逐字节一致）；
//   protocols=NULL ∧ type=anthropic ⇒ 恰 2 端点 {chat, messages}，全部 policy=convert，
//                                      **messages 面 streamPassthrough=true** —— 今天 P2a
//                                      （非流式转换 + 流式字节直通）的恒等复现，不是新行为；
//   声明面（protocols 非 NULL）     ⇒ 面表**完全取代**隐式面表（不做并集）；面内 baseUrl
//                                      缺省 ⇒ 继承 base_url（不复制 URL，避免两份漂移）；
//                                      policy 缺省 ⇒ 取面默认（FACE_DEFAULT_POLICY）；
//                                      policy=verbatim ⇒ streamPassthrough=true。
//   type=custom ∧ protocols 缺失/空 ⇒ 解析报错（fail-fast，T1 数据不变式被绕过写入时的兜底）。
//
// 主端点规则（design §2.3）：policy=convert ⇒ **一律打主端点 base_url**（与今天逐字节等价，
// 声明面里写的 baseUrl 在 convert 面上不生效——它只描述该面的原生端点，供 verbatim 使用）；
// policy=verbatim ⇒ 打该面端点（面内 baseUrl ?? base_url）。
// dialect 与适配器层 ProviderType（src/providers/types.ts，仍是 2 值）结构同构 ⇒ 批次 2 可以
// 把 resolved.dialect 直接喂给 getAdapter，无需改签名。
import type { EndpointKind } from "./types";
import { openaiEndpointUrl } from "./openai";
import { anthropicMessagesUrl } from "./anthropic";

/** 协议面（闭集）：出现某面 = 该上游支持该面。与 src/routes/providers/types.ts 的
 * providerProtocolsSchema 键集同源（那边 `satisfies Record<ProviderFace, …>` 编译期锁死
 * —— 新增面必须两处同步，否则 typecheck 红）。 */
export type ProviderFace = "chat" | "completions" | "embeddings" | "messages" | "responses";

export const PROVIDER_FACES = [
  "chat",
  "completions",
  "embeddings",
  "messages",
  "responses",
] as const satisfies readonly ProviderFace[];

/** 面端点原生协议方言（design §2.3）：messages 面是 Anthropic Messages 协议，其余面均为 OpenAI 系。 */
export type EndpointDialect = "openai" | "anthropic";

/** 面改写策略（design §2.2）：verbatim = 逐字节直通；convert = 网关转换。 */
export type EndpointPolicy = "verbatim" | "convert";

export type EndpointAuthStyle = "bearer" | "x-api-key";

/** 解析产物（design §2.3 形态，一字不差）：policy 与 streamPassthrough 是**两个独立属性** ——
 * 刻意不合并成一个开关，因为遗留 anthropic 的 messages 面是「convert + 流式直通」
 * （P2a），合并表达不了它。 */
export interface ResolvedEndpoint {
  face: ProviderFace;
  dialect: EndpointDialect;
  endpointUrl: string;
  authStyle: EndpointAuthStyle;
  policy: EndpointPolicy;
  streamPassthrough: boolean;
}

/** 解析输入：providers 行的最小结构面（drizzle 行可直接传入；protocols 为 JSON 文本，
 * 与 models 列同惯例）。 */
export interface ProviderEndpointRow {
  type: string;
  baseUrl: string;
  protocols: string | null;
}

/** providers 行无法解析出端点（type=custom 而 protocols 缺失/空/损坏、面键或字段非法等）。
 * 与 AdapterError 刻意分开：这是**记录级配置损坏**（服务端数据问题），不是客户端请求
 * 格式问题——不默认映射 400，调用方（批次 2 的路由层）自行决定跳过该候选或 500。 */
export class EndpointResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointResolutionError";
  }
}

/** 面默认 policy（design §2.2 规则 3）：messages/chat = verbatim（原生面优先逐字透传）；
 * responses/completions/embeddings = convert —— responses 面默认转换是 D3 裁决
 * （Codex Lite 适配不被 verbatim 绕过）。 */
export const FACE_DEFAULT_POLICY: Record<ProviderFace, EndpointPolicy> = {
  chat: "verbatim",
  completions: "convert",
  embeddings: "convert",
  messages: "verbatim",
  responses: "convert",
};

/** 面 → 原生协议方言（声明面用；遗留记录的 dialect 取自 type，不走本表）。 */
const FACE_DIALECT: Record<ProviderFace, EndpointDialect> = {
  chat: "openai",
  completions: "openai",
  embeddings: "openai",
  messages: "anthropic",
  responses: "openai",
};

/** 方言 → 默认鉴权风格（design §2.3：适配器默认；httpOptions.headers 的显式覆盖
 * 发生在请求构造时，不在解析层）。 */
const DIALECT_AUTH_STYLE: Record<EndpointDialect, EndpointAuthStyle> = {
  openai: "bearer",
  anthropic: "x-api-key",
};

/** openai 方言各面的端点 URL 规则：chat/completions/embeddings 复用 openaiEndpointUrl
 * （尾斜杠归一 + 现路径表）；responses 面与探测（lib/probe.ts）同款 `{base}/responses`。 */
function openaiFaceUrl(face: ProviderFace, base: string): string {
  switch (face) {
    case "chat":
      return openaiEndpointUrl(base, "chat");
    case "completions":
      return openaiEndpointUrl(base, "completions");
    case "embeddings":
      return openaiEndpointUrl(base, "embeddings");
    case "responses":
      return `${base.replace(/\/+$/, "")}/responses`;
    default:
      // dialect=openai 与 face=messages 不可能同时出现（FACE_DIALECT 表保证）；防御性 fail-fast
      throw new EndpointResolutionError(`face '${face}' has no openai-dialect URL rule`);
  }
}

interface DeclaredFace {
  baseUrl?: string;
  policy?: EndpointPolicy;
}

/** 解析 protocols JSON（DB 直读路径的白名单 + fail-fast 校验；API 侧同类校验在
 * src/routes/providers/types.ts 的 zod——两层都挡，DB 直改只被这里拦）。 */
function parseDeclaredProtocols(raw: string): Partial<Record<ProviderFace, DeclaredFace>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EndpointResolutionError("providers.protocols is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EndpointResolutionError("providers.protocols must be a JSON object");
  }
  const out: Partial<Record<ProviderFace, DeclaredFace>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!PROVIDER_FACES.includes(key as ProviderFace)) {
      throw new EndpointResolutionError(`providers.protocols has unknown face '${key}'`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new EndpointResolutionError(`providers.protocols.${key} must be an object`);
    }
    const face = value as Record<string, unknown>;
    const declared: DeclaredFace = {};
    if (face.baseUrl !== undefined) {
      if (typeof face.baseUrl !== "string" || face.baseUrl.length === 0) {
        throw new EndpointResolutionError(
          `providers.protocols.${key}.baseUrl must be a non-empty string`,
        );
      }
      declared.baseUrl = face.baseUrl;
    }
    if (face.policy !== undefined) {
      if (face.policy !== "verbatim" && face.policy !== "convert") {
        throw new EndpointResolutionError(
          `providers.protocols.${key}.policy must be 'verbatim' or 'convert'`,
        );
      }
      declared.policy = face.policy;
    }
    out[key as ProviderFace] = declared;
  }
  return out;
}

/**
 * providers 行 → 解析后端点列表（design §2.2/§2.3 规则表）。
 * 输出面顺序恒为 PROVIDER_FACES 的白名单序（确定性：路由扫描与测试断言都可依赖）。
 * 抛 EndpointResolutionError：type=custom 而 protocols 缺失/空/损坏，或 protocols JSON 非法。
 */
export function parseResolvedEndpoints(row: ProviderEndpointRow): ResolvedEndpoint[] {
  // NULL/undefined ≡ 未声明（走遗留等价面表）；空串按损坏处理（不算「未声明」也不算合法声明）
  if (row.protocols === null || row.protocols === undefined) {
    if (row.type === "custom") {
      throw new EndpointResolutionError(
        `provider type '${row.type}' with protocols=NULL cannot be resolved (type=custom requires a protocols declaration with at least one face)`,
      );
    }
    // 遗留等价规则：按 type 复现今天的隐式面表
    if (row.type === "openai") {
      const legacyFaces = ["chat", "completions", "embeddings"] as const;
      return legacyFaces.map((face) => ({
        face,
        dialect: "openai" as const,
        endpointUrl: openaiEndpointUrl(row.baseUrl, face),
        authStyle: "bearer" as const,
        policy: "convert" as const,
        streamPassthrough: false,
      }));
    }
    if (row.type === "anthropic") {
      const messagesUrl = anthropicMessagesUrl(row.baseUrl);
      return [
        {
          face: "chat",
          dialect: "anthropic",
          // 与 anthropic 适配器 buildRequest 的 kind=chat 同一条 URL 规则（逐字节一致）
          endpointUrl: messagesUrl,
          authStyle: "x-api-key",
          policy: "convert",
          streamPassthrough: false,
        },
        {
          face: "messages",
          dialect: "anthropic",
          endpointUrl: messagesUrl,
          authStyle: "x-api-key",
          policy: "convert",
          streamPassthrough: true, // 今天 P2a 的恒等复现：非流式走转换，流式字节直通
        },
      ];
    }
    throw new EndpointResolutionError(`unknown provider type '${row.type}'`);
  }

  const declared = parseDeclaredProtocols(row.protocols);
  const faces = PROVIDER_FACES.filter((face) => declared[face] !== undefined);
  if (row.type === "custom" && faces.length === 0) {
    throw new EndpointResolutionError(
      "provider type 'custom' requires at least one declared face in protocols",
    );
  }
  return faces.map((face) => {
    const d = declared[face] as DeclaredFace;
    const policy = d.policy ?? FACE_DEFAULT_POLICY[face];
    const dialect = FACE_DIALECT[face];
    // 主端点规则：convert ⇒ 一律打主端点（声明面 baseUrl 在 convert 面上不生效）；
    // verbatim ⇒ 打该面端点（面内 baseUrl 缺省继承主端点）
    const base = policy === "verbatim" ? (d.baseUrl ?? row.baseUrl) : row.baseUrl;
    return {
      face,
      dialect,
      endpointUrl:
        dialect === "anthropic" ? anthropicMessagesUrl(base) : openaiFaceUrl(face, base),
      authStyle: DIALECT_AUTH_STYLE[dialect],
      policy,
      streamPassthrough: policy === "verbatim",
    };
  });
}

/** 面 → 原生协议方言的公开查询（批次 2 消费点：路由偏好趟的方言配对、流式直通门的
 * 入站方言判定）。注意：本表只描述「某面在**声明**形态下的原生方言」；遗留 anthropic
 * 记录的 chat 面方言取自 type（anthropic），不经过本表。 */
export function dialectForFace(face: ProviderFace): EndpointDialect {
  return FACE_DIALECT[face];
}

/**
 * 偏好趟门（design §2.2 规则 1 + §4.2）：解析后端点中是否存在**原生承载**该入站面的端点
 * ——面相同 ∧ 端点方言 === 该面的原生方言。刻意比 selectEndpoint 严：internal kind 的
 * 跨方言承载（anthropic 方言 chat 面服务 chat 入站、messages 面服务 chat 入站）**不进
 * 偏好趟** —— 那是回退趟的转换兜底语义（§4.2），混进偏好趟会改变存量多候选池的构成
 * （遗留 anthropic 行有 anthropic 方言的 chat 面，混入 chat 偏好趟 = 零回归红线被破）。
 * responses 面的既有等价：/v1/responses 归一为 internal chat，遗留 openai 记录今天正是
 * 经 chat 面（openai 方言）偏好命中的 ⇒ responses 入站额外接受 openai 方言 chat 面。
 */
export function supportsProtocol(
  resolved: readonly ResolvedEndpoint[],
  face: ProviderFace,
): boolean {
  const dialect = FACE_DIALECT[face];
  return resolved.some(
    (e) =>
      e.dialect === dialect &&
      (e.face === face || (face === "responses" && e.face === "chat")),
  );
}

/**
 * 单候选对本次请求的「活跃端点」（批次 2 消费点：适配器选择 / 支持判断 / 流式直通门 /
 * 计费 detector 全部消费它的 dialect 与 streamPassthrough，design §3 表）。
 * 选择规则：
 *   1. 原生入站面（面相同 ∧ 方言 === 该面原生方言）——偏好趟候选恒走此支；
 *   2. responses 入站无原生面时由 openai 方言 chat 面承载（遗留 openai 记录服务
 *      /v1/responses 的既有路径，§4.2 对话 kind 归一）；
 *   3. 回退（回退趟 / 未声明入站面）：internal kind 同名面；对话 kind（chat）无同名面时
 *      anthropic 方言 messages 面可承载（跨方言转换兜底，§4.2）；
 *      completions/embeddings 是独立 internal kind，无跨面转换 ⇒ 仅同名面承载。
 * 返回 null ⇔ 该记录不支持该 internal kind —— 消费方按 multiCandidate 分支走
 * "does not support this endpoint" 400 或跳过候选（与今天 adapter.supports 语义一致；
 * 遗留 anthropic 记录对 completions/embeddings 仍拒，:615 的 400 逐字保留）。
 */
export function selectEndpoint(
  resolved: readonly ResolvedEndpoint[],
  inboundFace: ProviderFace | undefined,
  kind: EndpointKind,
): ResolvedEndpoint | null {
  if (inboundFace !== undefined) {
    const native = resolved.find(
      (e) => e.face === inboundFace && e.dialect === FACE_DIALECT[inboundFace],
    );
    if (native !== undefined) {
      return native;
    }
    if (inboundFace === "responses") {
      const viaChat = resolved.find((e) => e.face === "chat" && e.dialect === "openai");
      if (viaChat !== undefined) {
        return viaChat;
      }
    }
  }
  const byKind = resolved.find((e) => e.face === kind);
  if (byKind !== undefined) {
    return byKind;
  }
  if (kind === "chat") {
    const byMessages = resolved.find(
      (e) => e.face === "messages" && e.dialect === "anthropic",
    );
    if (byMessages !== undefined) {
      return byMessages;
    }
  }
  return null;
}
