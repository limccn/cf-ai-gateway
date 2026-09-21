// provider 联通性 ping（批次 O，2026-09-21）：只回答「这个 origin 在网络上通不通」，
// **不**回答「凭据对不对」「模型存不存在」。
//
// 口径（PRD 裁决 D14）：打 `new URL(baseUrl).origin + "/"`，method **HEAD**，
// **不带任何凭据/头/体**；收到**任何** HTTP 回应（含 401/403/404）即算「联通」。
//
// 与 lib/probe.ts 的关系是**刻意的不复用**（这是对照面，别来「统一」它）：
//   · probe **复用**生产的 headers/body 构造（保真优先，见其文件头）；ping **绝不**应用
//     httpOptions、也不带 Authorization / x-api-key —— 联通性不该依赖凭据，而「没凭据也能拿回
//     一个 HTTP 答复」恰恰就是它要测的那一层。
//   · probe 读响应体（要真实总耗时与非 2xx 的错误消息）；ping **不读正文** —— HEAD 无正文，
//     于是 §22 里「先发响应头、再挂住正文」那一整类失败在 ping 上**构造性消失**。
//     别为了「拿到真实 total」给它补上读正文，那是把一类已消灭的失败形态请回来。
//   · probe 超时 = `min(provider 配置, 30s)`；ping 超时是**扁平 10s、不从 provider 派生** ——
//     `upstreamTimeoutMs` 的语义是「慢模型长生成的预算」（见 routes/providers/types.ts 该字段注释），
//     与「网络往返快不快」无关：给配了 1000ms 的 provider 派生预算，会把一个 1.2s 才回 HEAD 的
//     可达 origin 判成不可达 ⇒ 三条协议探测被白白跳过（对刚修完慢上游的那批配置尤其伤）。
//
// 谓词与 probe 的 `ok` **不是一回事**，故字段名也不同（不许合并成一个 result 类型）：
//   ok        = 2xx（「上游接受了这次调用」）
//   reachable = 收到了任何 HTTP 回应（「网络层能把请求送到、并拿回一个答复」）
// 由此两条**相反**的事实：probe 的 `status === null ⟺ ttfbMs === totalMs`；
// ping 成功时 `status` 非空、且 `ttfbMs === totalMs`（HEAD 不读正文，只有一个时刻可测）。
//
// 已知取舍（会**假阴性**）：若上游挂在「未鉴权请求在连接层就被拒」的反向代理 / mTLS 网关 /
// 按 UA 拦截的 WAF 后面，ping 会判不可达，于是三条协议探测被跳过 —— 那**不是**「凭据无效」的
// 结论，UI 文案必须自证这条边界（不许把 ping 结果说成「provider 可用」）。
// 复议杠杆（现在不做，只记录）：让 ping 带上 `httpOptions.headers`（仍不带 apiKey）——
// 代价是给「不带任何凭据」这条口径开口子。
import { describeFetchFailure, fetchUpstream } from "../../../lib/upstream";

/**
 * ping 超时上限（毫秒）：**扁平值，与 provider 配置无关**（理由见文件头）。
 * 最坏串行预算：ping 10s + 三条并行探测 30s = 40s（原为 30s）。
 */
export const PING_TIMEOUT_CAP_MS = 10_000;

export interface PingResult {
  /**
   * 实际请求的 URL（**origin 根**）。baseUrl 非法时为 `null` —— 这是「输入非法」与
   * 「网络失败」（url 非空、status 为 null）之间**唯一的可判别字段**。
   *
   * `.origin` 顺带剥掉了 userinfo / path / query，故回显不可能泄露内嵌在 baseUrl 里的凭据。
   */
  url: string | null;
  /** 收到**任何** HTTP 回应（含 401/403/404）⇒ true。与 probe 的 `ok`（要求 2xx）不是一回事。 */
  reachable: boolean;
  /** 网络层失败（DNS/连接/TLS/超时）时为 null —— 此时没有 HTTP 状态可言。 */
  status: number | null;
  statusText: string | null;
  ttfbMs: number;
  totalMs: number;
  /** 失败原因（非法 baseUrl / 网络错误 / 超时）；成功为 null。 */
  error: string | null;
}

/** `pingUrl` 的结果：判别联合，让「非法输入」在类型层就与「一个 URL」分开。 */
export type PingTarget = { ok: true; url: string } | { ok: false; error: string };

/**
 * baseUrl → origin 根 URL。
 *
 * 三件必须显式做的事（都踩过或被踩过）：
 *   · `new URL` 抛错 ⇒ 回明确文案（baseUrl 是**用户输入**，不是服务端故障，调用方不许回 500）。
 *   · **显式拒非 http(s)**：`z.string().url()` 放行 `ftp://…` 这类协议，而 workerd 的 fetch
 *     对它会抛「Fetch API cannot load…」，那句英文对管理员毫无指向性；这里给一句点名协议的话。
 *   · 末尾补 `/`：`origin` 本身不带路径，不带这一笔的话「打的是主机根」在日志/回显里看不出来。
 */
export function pingUrl(baseUrl: string): PingTarget {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: `baseUrl is not a valid absolute URL: ${baseUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported URL scheme (only http/https): ${parsed.protocol}` };
  }
  return { ok: true, url: `${parsed.origin}/` };
}

/**
 * 执行一次联通性 ping。**本函数不抛异常** —— 所有失败都归一成 `reachable:false` 的结果。
 *
 * `redirect: "manual"` 是刻意的（不是默认值）：口径是「收到任何 HTTP 回应即联通」，
 * 跟随跳转会把「本 origin 明明答了 301」判成不可达（假阴性），而且会让我们去回答
 * **另一个** host 的可达性 —— 那已经不是「配置的这个 origin 通不通」了。
 * UI 侧因此要容忍「3xx 但状态码不可读」的运行时形态（见 ping 行的 `status > 0` 守卫）。
 */
export async function runPing(baseUrl: string, timeoutMs: number): Promise<PingResult> {
  const started = Date.now();
  const target = pingUrl(baseUrl);
  if (!target.ok) {
    const ms = Date.now() - started;
    return {
      url: null,
      reachable: false,
      status: null,
      statusText: null,
      ttfbMs: ms,
      totalMs: ms,
      error: target.error,
    };
  }

  try {
    const resp = await fetchUpstream(
      target.url,
      { method: "HEAD", redirect: "manual" },
      timeoutMs,
    );
    const ms = Date.now() - started;
    return {
      url: target.url,
      reachable: true,
      status: resp.status,
      statusText: resp.statusText,
      ttfbMs: ms,
      totalMs: ms,
      error: null,
    };
  } catch (error) {
    const ms = Date.now() - started;
    return {
      url: target.url,
      reachable: false,
      status: null,
      statusText: null,
      ttfbMs: ms,
      totalMs: ms,
      error: describeFetchFailure(error, timeoutMs),
    };
  }
}
