// 上游协议探测（批次 N，2026-09-21）：对 provider 的 baseUrl 直发三条最小真实请求，
// 逐条报「疏通与否 + HTTP 状态 + TTFB + 总耗时」。
//
// **口径是「上游原生端点」而非「网关出站路径」**（PRD 裁决 D11）：网关的**出站**只有两条 ——
// openai 类型打 {baseUrl}/chat/completions、anthropic 类型打 {baseUrl}/v1/messages；
// `/responses` 是**入站**协议，会被转换成内部 chat 形态后走上面同一条出站路径
// （src/routes/v1/responses.ts + src/routes/v1/router.ts），网关自己从不打上游的 /responses。
// ⇒ 本模块的 responses 一行回答的是「**这个上游**是否支持 Responses API」，**不是**「网关链路是否通」。
// 该行绿了不代表网关能用；该行红了也不代表网关坏了。UI 上必须把这句话原样说给用户。
//
// 两处刻意的复用/不复用：
//   · **复用**生产的 headers/body 构造（buildUpstreamHeaders / applyHttpBody）与两条 URL 规则
//     （openaiEndpointUrl / anthropicMessagesUrl）—— 探测若不反映生产实际发出去的请求，
//     配错 httpOptions 时探测反而报绿，那就成了骗人的绿灯。
//   · **不复用**网关自身的鉴权/计费/用量链路 —— 探测不写 request_logs、不计网关的费、不消耗网关 key
//     （**但上游那边可能真计费**，见 PROBE_MAX_TOKENS）。
//
// 一条已知的取舍：provider 的 `httpOptions.body` 会**同时**套到三条探测上（applyHttpBody 是
// Object.assign，配置值总是赢）。若该配置里带的是 chat 专有参数（如 `max_tokens`、`stream`），
// responses / anthropic 两行就可能因此报 400 —— 那是**真实的上游拒绝**（它确实不认识这个参数），
// 但红的原因不是「不支持该协议」。想按协议分辨键集是不可能的（每家上游认的参数集各不相同），
// 故保持「配置一律照发」，让上游自己说话；错误消息里会带着它的原话。
//
// **绝不写断路器**：探测失败只回结果，不能把 provider 踢出生产轮转（那是真实流量的职责）。
import { applyHttpBody, buildUpstreamHeaders } from "../../../providers/http-options";
import { anthropicMessagesUrl } from "../../../providers/anthropic";
import { openaiEndpointUrl } from "../../../providers/openai";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  fetchUpstream,
  UpstreamTimeoutError,
} from "../../../lib/upstream";
import type { ProviderConfig } from "../../../providers/types";
// 协议字面量的**唯一来源**在契约层（前端也 import 它）；此处不再各写一份，避免漂移
import type { ProbeProtocol } from "../types";

export interface ProbeSpec {
  protocol: ProbeProtocol;
  label: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ProbeResult {
  protocol: ProbeProtocol;
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

/** 错误消息回显上限（防上游把整篇 HTML 错误页塞进 UI）。 */
const ERROR_MAX_CHARS = 300;

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

/**
 * 构造三条探测请求。`model` 缺失（映射表为空）时调用方应拒绝，不到这里。
 * 三条各自带自己的鉴权头与路径规则 —— 这正是「三种协议」的字面含义。
 */
export function buildProbeSpecs(cfg: ProviderConfig, model: string): ProbeSpec[] {
  const chat = applyHttpBody<Record<string, unknown>>(
    {
      model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: PROBE_MAX_TOKENS,
      stream: false,
    },
    cfg,
  );
  const responses = applyHttpBody<Record<string, unknown>>(
    {
      model,
      input: PROBE_PROMPT,
      max_output_tokens: PROBE_MAX_TOKENS,
      stream: false,
    },
    cfg,
  );
  const messages = applyHttpBody<Record<string, unknown>>(
    {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: "user", content: PROBE_PROMPT }],
    },
    cfg,
  );

  return [
    {
      protocol: "openai-chat",
      label: "OpenAI Chat Completions",
      // 与网关 openai 出站**同一条**路径规则（生产实际打的就是这个 URL）
      url: openaiEndpointUrl(cfg.baseUrl, "chat"),
      headers: buildUpstreamHeaders(
        { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        cfg,
      ),
      body: chat,
    },
    {
      protocol: "openai-responses",
      label: "OpenAI Responses",
      // 无生产对应物（见文件头）：网关的 Responses 入站会转成 chat 出站，从不打这里
      url: `${cfg.baseUrl.replace(/\/+$/, "")}/responses`,
      headers: buildUpstreamHeaders(
        { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        cfg,
      ),
      body: responses,
    },
    {
      protocol: "anthropic-messages",
      label: "Anthropic Messages",
      // 与网关 anthropic 出站**同一条**路径规则（baseUrl 以 /v1 结尾则用 /messages）
      url: anthropicMessagesUrl(cfg.baseUrl),
      headers: buildUpstreamHeaders(
        {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        cfg,
      ),
      body: messages,
    },
  ];
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
 * 「Probing three protocols…」而 UI 上还写着 `timeout 30s` —— 那是**本次请求的超时参数**，
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
  const meta = { protocol: spec.protocol, label: spec.label, url: spec.url };
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

    const message =
      error instanceof UpstreamTimeoutError
        ? `Timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "Unknown network error";
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

/** 三条并行探测（各测各的延迟；串行会把三条延迟串成一条，白等两倍时间）。 */
export async function runProbes(specs: ProbeSpec[], timeoutMs: number): Promise<ProbeResult[]> {
  return Promise.all(specs.map((spec) => runProbe(spec, timeoutMs)));
}
