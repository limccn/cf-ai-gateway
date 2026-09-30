// 上游端点探测（批次 N 建；批次 6 改**逐面探测**，2026-09-29）：对 provider 的解析层端点
// 逐面直发最小真实请求，逐行报「疏通与否 + HTTP 状态 + TTFB + 总耗时」。
//
// **探测行 = 解析层 resolved 端点集**（src/providers/endpoints.ts 的 parseResolvedEndpoints，
// 由 procedures/test.ts 解析后传入）：
//   · legacy 记录（protocols=NULL）按遗留等价面表展开 —— openai ⇒ chat/completions/embeddings
//     三行、anthropic ⇒ chat/messages 两行；
//   · custom 记录按声明面逐面一行（面表完全取代隐式面表，design §2.2 规则 1）。
// 每一行都是解析层判定**该面可达的 URL** —— 路由选择（selectEndpoint）能返回的支路与探测行
// 一一对应 ⇒ 核心不变式「**探测绿 = 生产同 URL**」在行级成立，唯一例外是声明 responses 面 ×
// convert（该行打原生 /responses，而 convert 生产经 chat 出站打主端点——批次 6 边界 K）。
// 本模块**不做任何 URL 拼接**：直接消费
// 解析层产物 ep.endpointUrl；同源性在 endpoints.ts 内部成立（openaiFaceUrl / anthropicMessagesUrl
// 正是生产出站构造用的同两个函数）。
//
// 旧版口径的谢幕（批次 N D11）：旧探测对任何记录都打固定三行（chat/responses/messages），
// 其中 `/responses` 一行「无生产对应物」（网关把 Responses 入站转成 chat 出站）——UI 曾为此
// 常驻一句口径说明。逐面探测后：未声明 responses 面的记录不再有该行；声明了 responses 的
// 记录，verbatim 打 `{base}/responses`（本行探的正是它），**convert 声明的生产出站仍走
// chat**（endpoints.ts 主端点规则）——即该行对 verbatim 是「生产同 URL」、对 convert 是
// 「verbatim 翻转前置探针」（批次 5 边界 J 前半句已按此勘误、批次 6 边界 K）。
//
// 两处复用/不复用（保持批次 N 原状）：
//   · **复用**生产的 headers/body 构造（buildUpstreamHeaders / applyHttpBody）——探测若不反映
//     生产实际发出去的请求，配错 httpOptions 时探测反而报绿，那就成了骗人的绿灯。
//   · **不复用**网关自身的鉴权/计费/用量链路 —— 探测不写 request_logs、不计网关的费、
//     不消耗网关 key（**但上游那边可能真计费**，见 PROBE_MAX_TOKENS）。
//
// ⚠ TODO(批次 0 探针 P1'/P1''，research/batch0-probe-kit.md)：anthropic 面的目标 URL 形态
// （直连 /v1/messages？OpenRouter 的 /api/v1 前缀？）未实证——本批**保守处理**：探测只消费
// 解析层产物，不改任何 URL 规则、不预判最终形态；P1'/P1'' 实测后再议 anthropicMessagesUrl
// 的形态放宽（design §6.1/§9 #2）。
//
// httpOptions.body 会**同时**套到所有探测行上（applyHttpBody 是 Object.assign，配置值总是赢）。
// 若该配置里带的是 chat 专有参数（如 `max_tokens`、`stream`），其他面的行就可能因此报 400 ——
// 那是**真实的上游拒绝**（它确实不认识这个参数），但红的原因不是「不支持该面」。想按面分辨
// 键集是不可能的（每家上游认的参数集各不相同），故保持「配置一律照发」，让上游自己说话；
// 错误消息里会带着它的原话。
//
// **绝不写断路器、绝不自动写回 provider 行**：探测失败只回结果，不把 provider 踢出生产轮转
// （那是真实流量的职责）；「声明此端点」是显式人工动作（procedures/declare-endpoint.ts），
// 探测与声明之间没有任何自动通路（design §6.2：防「偶发红 ⇒ 抹掉已生效的声明」）。
import { applyHttpBody, buildUpstreamHeaders } from "../../../providers/http-options";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  describeFetchFailure,
  fetchUpstream,
  UPSTREAM_ERROR_MAX_CHARS,
  UpstreamTimeoutError,
} from "../../../lib/upstream";
import type { ProviderConfig } from "../../../providers/types";
import type {
  EndpointDialect,
  ProviderFace,
  ResolvedEndpoint,
} from "../../../providers/endpoints";

export interface ProbeSpec {
  face: ProviderFace;
  dialect: EndpointDialect;
  label: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ProbeResult {
  face: ProviderFace;
  dialect: EndpointDialect;
  label: string;
  /** 实际请求的 URL（**不含任何密钥**：密钥只在 header 里，回显 URL 供管理员自查打到了哪）。 */
  url: string;
  ok: boolean;
  /** 网络层失败（DNS/连接/超时）时为 null —— 此时没有 HTTP 状态可言。 */
  status: number | null;
  statusText: string | null;
  /** 首字节耗时 = fetch resolve（响应头到达）的时刻。 */
  ttfbMs: number;
  /** 总耗时 = 响应体读完的时刻。 */
  totalMs: number;
  /** 失败原因（网络错误 / 超时 / 上游错误消息摘要）；成功为 null。 */
  error: string | null;
}

/**
 * 探测超时上限（毫秒）。取 `min(provider 配置的超时, 本上限)`：
 * provider 可配到 600s（慢模型长生成），拿 600s 去等一个**诊断**请求会让弹窗看起来像卡死；
 * 30s 足够区分「通但慢」与「不通」，且上限值随响应回传（`timeoutMs`），不是隐藏的谎。
 */
export const PROBE_TIMEOUT_CAP_MS = 30_000;

/** 错误消息回显上限：与联通性 ping 共用同一条（见 src/lib/upstream.ts，防两处漂移）。 */
const ERROR_MAX_CHARS = UPSTREAM_ERROR_MAX_CHARS;

/**
 * 探测请求的最大生成长度**默认值**。取小值是为了把上游那边的成本压到最低 ——
 * 探测要的是「握手通不通、多快」，不是生成质量。
 *
 * **但它只是默认值，不构成保证**：`applyHttpBody` 是 Object.assign，provider 的
 * `httpOptions.body` 若带了 `max_tokens` / `max_output_tokens` / `stream`，配置值总是赢
 * （这是 D11 想要的保真，不是 bug）。所以「成本≈0」这种绝对化说法不成立，
 * 别在注释或 UI 里承诺它。代价：个别只接受更大值的上游会返回 400，那是真实信号，如实展示。
 */
const PROBE_MAX_TOKENS = 16;
const PROBE_PROMPT = "ping";

/** 探测用模型名：provider 映射表的**第一个上游名**（`internal=upstream` 的 upstream 一侧）。 */
export function pickProbeModel(models: Record<string, string>): string | null {
  return Object.values(models)[0] ?? null;
}

/** 探测超时 = min(provider 配置值 ?? 默认 60s, 上限 30s)。 */
export function probeTimeoutMs(configured: number | null | undefined): number {
  const base =
    typeof configured === "number" && configured > 0 ? configured : DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(base, PROBE_TIMEOUT_CAP_MS);
}

/** 行标签 = 面名 + 方言（同一面在不同方言下是不同的行，如 legacy anthropic 的 chat 面）。 */
const PROBE_FACE_LABELS: Record<ProviderFace, string> = {
  chat: "Chat Completions",
  completions: "Completions",
  embeddings: "Embeddings",
  messages: "Messages",
  responses: "Responses",
};

const PROBE_DIALECT_LABELS: Record<EndpointDialect, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/**
 * 方言 → 默认鉴权头。与生产适配器的默认头同款（x-api-key + anthropic-version / Bearer）；
 * provider 的 httpOptions.headers 仍可在其上强制覆盖（buildUpstreamHeaders）。
 * ⚠ TODO(P1'/P1'')：anthropic 面是否还需补 Authorization（OpenRouter 形态）未实证，
 * 见 batch0-probe-kit.md——实测前保持解析层 authStyle 的默认，不预判。
 */
function probeHeaders(dialect: EndpointDialect, apiKey: string): Record<string, string> {
  if (dialect === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

/**
 * 面探测的最小请求体（配 httpOptions 覆盖前）。anthropic 方言只有 Messages API 一种
 * 请求形态（legacy anthropic 的 chat 面与 messages 面打同一个端点，体相同）；openai 方言
 * 按面分体。embeddings 没有 max_tokens / stream 这类生成参数，最小体就是 model + input。
 */
function probeBody(
  dialect: EndpointDialect,
  face: ProviderFace,
  model: string,
): Record<string, unknown> {
  if (dialect === "anthropic") {
    return {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: "user", content: PROBE_PROMPT }],
    };
  }
  switch (face) {
    case "chat":
      return {
        model,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      };
    case "completions":
      return { model, prompt: PROBE_PROMPT, max_tokens: PROBE_MAX_TOKENS, stream: false };
    case "embeddings":
      return { model, input: PROBE_PROMPT };
    case "responses":
      return {
        model,
        input: PROBE_PROMPT,
        max_output_tokens: PROBE_MAX_TOKENS,
        stream: false,
      };
    case "messages":
      // FACE_DIALECT 表保证 messages 面恒为 anthropic 方言，不会走到这；防御性报错
      throw new Error(`face '${face}' has no openai-dialect probe body`);
  }
}

/**
 * 构造逐面探测请求（批次 6）：resolved 端点集一行一个 spec，URL 直接取解析层产物
 * （本函数不做任何 URL 拼接）。`model` 缺失（映射表为空）时调用方应拒绝，不到这里。
 * 头/body 按 resolved 端点的方言与面构造 —— 这正是「该面原生协议」的字面含义。
 */
export function buildProbeSpecs(
  cfg: ProviderConfig,
  model: string,
  resolved: readonly ResolvedEndpoint[],
): ProbeSpec[] {
  return resolved.map((ep) => ({
    face: ep.face,
    dialect: ep.dialect,
    label: `${PROBE_FACE_LABELS[ep.face]} (${PROBE_DIALECT_LABELS[ep.dialect]})`,
    // 解析层产物 = 生产出站会打的 URL（同源性在 endpoints.ts 内部成立）
    url: ep.endpointUrl,
    headers: buildUpstreamHeaders(probeHeaders(ep.dialect, cfg.apiKey), cfg),
    body: applyHttpBody(probeBody(ep.dialect, ep.face, model), cfg),
  }));
}

/** 非 2xx 响应体 → 可读摘要（OpenAI / Anthropic 风格 `{error:{message}}` 优先，截断防超长）。 */
function summarizeErrorBody(text: string, status: number, statusText: string): string {
  const fallback = `${status} ${statusText}`.trim();
  let message = fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const err = obj["error"];
      if (typeof err === "string" && err.length > 0) {
        message = err;
      } else if (err !== null && typeof err === "object") {
        const nested = (err as Record<string, unknown>)["message"];
        if (typeof nested === "string" && nested.length > 0) {
          message = nested;
        }
      }
      if (message === fallback) {
        // 少数上游把 message 放在顶层（非 OpenAI 形态）
        const top = obj["message"];
        if (typeof top === "string" && top.length > 0) {
          message = top;
        }
      }
    }
  } catch {
    // 非 JSON（HTML 错误页 / 空体）→ 退回状态行
  }
  return message.length > ERROR_MAX_CHARS ? `${message.slice(0, ERROR_MAX_CHARS)}…` : message;
}

/**
 * 读干响应体，**自带超时**。
 *
 * 为什么需要它：`fetchUpstream` 的定时器在 **fetch resolve（响应头到达）时就被
 * `clearTimeout` 清掉了**（src/lib/upstream.ts 的 finally）⇒ 正文读取本身**没有任何上界**。
 * 上游或中间代理先发响应头、再挂住正文，探测就会永远等下去，弹窗停在
 * 「Probing the declared endpoints…」而 UI 上还写着 `timeout 30s` —— 那是**本次请求的超时参数**，
 * 不是该行的耗时上界。
 *
 * 预算另给一份等量的 `timeoutMs`（响应头已到，再给一份是保守且好解释的取法）。
 */
async function readBodyBounded(resp: Response, budgetMs: number): Promise<string> {
  const textPromise = resp.text();
  // 竞争落败后它仍会 settle（超时那条路径下就是「永远不 settle」）；
  // 挂一个空 catch 把它标记为已处理，免得正文读取失败时冒出 unhandled rejection。
  textPromise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      textPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamTimeoutError(budgetMs)), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 执行单条探测。**本函数不抛异常** —— 所有失败都归一成 `ok:false` 的结果，
 * 否则 Promise.all 下一条失败会吃掉另外两条的结果。
 */
export async function runProbe(spec: ProbeSpec, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  const meta = {
    face: spec.face,
    dialect: spec.dialect,
    label: spec.label,
    url: spec.url,
  };
  // 声明在 try 之外：catch 需要知道**响应头有没有到过**。到过就不是「无响应」——
  // 上游明确答复了、TTFB 也测到了，只是正文没读完，两者的 UI 形态完全不同。
  let resp: Response | null = null;
  let ttfbMs: number | null = null;
  try {
    resp = await fetchUpstream(
      spec.url,
      { method: "POST", headers: spec.headers, body: JSON.stringify(spec.body) },
      timeoutMs,
    );
    ttfbMs = Date.now() - started;
    // 必须读干响应体：① 总耗时才是真的总耗时；② 非 2xx 的错误消息就在体里
    const text = await readBodyBounded(resp, timeoutMs);
    const totalMs = Date.now() - started;
    const { status, statusText } = resp;
    if (!resp.ok) {
      return {
        ...meta,
        ok: false,
        status,
        statusText,
        ttfbMs,
        totalMs,
        error: summarizeErrorBody(text, status, statusText),
      };
    }
    return { ...meta, ok: true, status, statusText, ttfbMs, totalMs, error: null };
  } catch (error) {
    const totalMs = Date.now() - started;

    // 响应头到过 ⇒ 如实报出状态码与**已测到**的 TTFB，不要把「正文读失败」说成「没有响应」
    if (resp !== null && ttfbMs !== null) {
      const detail =
        error instanceof UpstreamTimeoutError
          ? `body read timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "unknown error";
      return {
        ...meta,
        ok: false,
        status: resp.status,
        statusText: resp.statusText,
        ttfbMs,
        totalMs,
        error: `Response body could not be read (${detail})`,
      };
    }

    const message = describeFetchFailure(error, timeoutMs);
    // 网络层没拿到响应头 ⇒ 没有 status，TTFB 与总耗时取同一个值（请求就此终止）
    return {
      ...meta,
      ok: false,
      status: null,
      statusText: null,
      ttfbMs: totalMs,
      totalMs,
      error: message,
    };
  }
}

/** 逐行并行探测（各测各的延迟；串行会把各行延迟串成一条，白等数倍时间）。 */
export async function runProbes(specs: ProbeSpec[], timeoutMs: number): Promise<ProbeResult[]> {
  return Promise.all(specs.map((spec) => runProbe(spec, timeoutMs)));
}
