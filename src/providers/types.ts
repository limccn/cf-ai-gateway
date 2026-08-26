// Provider 适配器契约（design.md §4）。
// 适配器职责：OpenAI 形态内部请求 → 上游请求；上游响应 → OpenAI 形态（含流式 SSE）。
// 注册表：src/providers/index.ts；新增 Provider 类型只需实现本接口。

/** 网关内部统一请求形态 = OpenAI 兼容格式。 */
export type EndpointKind = "chat" | "completions" | "embeddings";

export interface InternalRequest {
  kind: EndpointKind;
  /** OpenAI 形态请求体（已过 Zod 校验的 JSON object） */
  body: Record<string, unknown>;
  /** 内部模型名（路由映射的 key） */
  model: string;
  stream: boolean;
}

export interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;
  /** 解密后的上游密钥（仅请求构造内存中使用，不落日志） */
  apiKey: string;
  /** 内部模型名 -> 上游模型名 */
  models: Record<string, string>;
}

export interface UpstreamRequest {
  url: string;
  init: RequestInit;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 适配器抛出的格式转换错误 → 网关映射为 400（OpenAI 风格错误体）。 */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface ProviderAdapter {
  type: ProviderType;
  /** 是否支持该端点（Anthropic 仅 chat/completions）。 */
  supports(kind: EndpointKind): boolean;
  /** 构造上游请求（含模型名替换与鉴权头）。 */
  buildRequest(req: InternalRequest, cfg: ProviderConfig): UpstreamRequest;
  /**
   * 非流式上游响应 → 网关返回体（OpenAI 形态）。
   * OpenAI 适配器不实现（原样透传）；Anthropic 实现消息格式转换。
   */
  transformResponse?(body: unknown): unknown;
  /** 非流式响应中解析 usage（无法解析返回 null，M4 计费据此决定免计/估算）。 */
  parseUsage(body: unknown): TokenUsage | null;
  /**
   * 流式：从 SSE 尾部 chunk（OpenAI 形态，含 usage 字段）解析用量。
   * 两个适配器的流式变换都会在末尾合成携带 usage 的 chunk。
   */
  parseStreamUsage(tailChunk: unknown): TokenUsage | null;
  /** 上游流式响应体 → OpenAI SSE（OpenAI 透传；Anthropic 逐事件转换）。 */
  transformStreamToOpenAI(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}

export type ProviderType = "openai" | "anthropic";
