// Test connection 弹窗（批次 N 建，批次 O 加「先 ping 联通、再跑三条协议」）。
//
// **两步**（PRD 裁决 D16）：先打上游 origin 根的联通性（HEAD，不带任何凭据；收到**任何** HTTP
// 回应含 401/403/404 即算联通），联通后才发第二步跑三条协议探测。未联通 ⇒ 三条协议**完全不跑**，
// 上游一条模型调用都没有 —— 这是本功能存在的意义：把「网络/DNS/TLS 不通」与「上游拒绝了这次调用」
// 分开，前者根本不该产生任何上游调用，也不该消耗任何 token。
//
// 三条协议的口径必须说清（D11）：探的是**上游原生端点**，不是网关出站路径。网关出站只有两条
// （openai → /chat/completions、anthropic → /v1/messages）；`/responses` 是入站协议，
// 会被转换成 chat 形态后走 openai 那条出站，网关自己从不打上游的 /responses。
// ⇒ responses 那一行回答的是「这个上游支不支持 Responses API」，与网关链路是否通无关。
// 这句话不能只写在代码注释里 —— 用户看到一行红/绿就会据此判断，所以 UI 上原样说明。
//
// 本弹窗**对网关自身无副作用**：后端两条路由都不写断路器、不计网关的费、不落 request_logs，故：
//   · 不 invalidate provider 列表（没有任何东西变了，闪一下反而像「测试把 provider 踢下线了」）；
//   · 失败不代表 provider 被停用 —— 文案里要说明，否则用户会以为测试失败=已下线。
//
// ⚠ **但不能说「不产生任何费用」**：第二步是三条**真实的上游调用**，用 provider 自己的 key，
// 多数上游按 token 计费（默认 max_tokens=16 仍是真实账单）；且 provider 的 `httpOptions.body`
// 会覆盖这个默认值（`applyHttpBody` 是 Object.assign，配置值总是赢），配了
// `{"max_tokens": 8192}` 就是三条真实大生成。**「Nothing is billed」是句无法兑现的承诺** ——
// 描述文案按相位分叉（见 provider-test-state.ts），第一条命令的 HEAD 才真的不产生费用。
import { CircleCheck, CircleX, Loader2, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/states";
import { useProviderTestRun } from "../hooks/use-provider-test-run";
import {
  dialogDescription,
  PING_ROW_LABEL,
  pingStatusLabel,
  REACHABILITY_DOCTRINE,
  SKIP_NOTICE,
  type TestRunPhase,
} from "../provider-test-state";
import type { ProviderPingResult, ProviderProbeResult, ProviderResponse } from "../types";

export interface ProviderTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderResponse | null;
}

export function ProviderTestDialog({ open, onOpenChange, provider }: ProviderTestDialogProps) {
  // 编排挂在这里（组件在页面加载时就已挂载，open=false），**不是**挂在随 open 才挂载的子树里：
  // 于是 StrictMode 的挂载双调用两次都早退，一次打开 = 恰好 1 个 ping + 1 个 test（见 hook 文件头）。
  const { phase, restart } = useProviderTestRun(open, provider?.id ?? null);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `Test connection — ${provider.name}` : "Test connection"}
      // 描述是**状态的函数**：静态描述在「未联通」相位会变成假话（那时一条上游调用都没发生）。
      description={dialogDescription(phase)}
    >
      {open && provider ? (
        <TestRunView phase={phase} provider={provider} onRestart={restart} />
      ) : null}
    </Dialog>
  );
}

/** 纯展示：无自身状态、无 effect —— 相位由编排 hook 单向下发。 */
function TestRunView({
  phase,
  provider,
  onRestart,
}: {
  phase: TestRunPhase;
  provider: ProviderResponse;
  onRestart: () => void;
}) {
  if (phase.kind === "pinging") {
    return <BusyLine text="Checking reachability… (up to 10s)" />;
  }

  if (phase.kind === "probing") {
    // ping 行**留在场上**：这是「两步」的可见证据，也避免弹窗在两步之间掉成空白帧
    return (
      <div className="space-y-3">
        <PingRow ping={phase.ping} />
        <BusyLine text="Probing three protocols…" />
      </div>
    );
  }

  if (phase.kind === "failed") {
    return (
      <div className="space-y-3">
        {phase.ping ? <PingRow ping={phase.ping} /> : null}
        <ErrorState
          title={phase.ping ? "Test request failed" : "Reachability request failed"}
          message={phase.message}
          onRetry={onRestart}
        />
        <RestartRow onRestart={onRestart} />
      </div>
    );
  }

  if (phase.kind === "skipped") {
    // `showDoctrine={false}`：跳过态由 SKIP_NOTICE 覆盖（且更具体 —— 它说的是「一个 HTTP 回应
    // 都没收到」，此时「401/403/404 也算联通」这句反而不适用），两句并排是同义反复。
    return (
      <div className="space-y-3">
        <PingRow ping={phase.ping} showDoctrine={false} />
        <p className="text-sm text-muted-foreground">{SKIP_NOTICE}</p>
        <RestartRow onRestart={onRestart} />
      </div>
    );
  }

  const passed = phase.probes.filter((probe) => probe.ok).length;
  return (
    <div className="space-y-3">
      <PingRow ping={phase.ping} />

      <p className="text-sm text-muted-foreground">
        <strong className="text-foreground">
          {passed} of {phase.probes.length}
        </strong>{" "}
        protocols responded · model <code className="font-mono text-xs">{phase.model}</code> · timeout{" "}
        {Math.round(phase.timeoutMs / 1000)}s
      </p>

      <div className="space-y-2">
        {phase.probes.map((probe) => (
          <ProbeRow key={probe.protocol} probe={probe} />
        ))}
      </div>

      {/* D11 的口径说明：只在确有 responses 一行时渲染，且不塞进行内（那行本身已经很挤） */}
      {phase.probes.some((p) => p.protocol === "openai-responses") ? (
        <p className="text-xs text-muted-foreground">
          <strong className="text-foreground">OpenAI Responses</strong> probes whether{" "}
          <em>this upstream</em> supports the Responses API. The gateway never calls it — inbound
          Responses requests are converted to Chat Completions before going out — so a green row
          here does not mean the gateway path works, and a red one does not mean it is broken.
        </p>
      ) : null}

      {provider.type === "anthropic" ? (
        <p className="text-xs text-muted-foreground">
          This provider is configured as <code className="font-mono">anthropic</code>. The two
          OpenAI rows are expected to fail unless the upstream also exposes OpenAI-compatible
          endpoints — only the Messages row reflects how the gateway actually calls it.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        A failed probe does not disable the provider — it stays in rotation for real traffic. Fix
        what the probe reports and run it again.
      </p>

      <RestartRow onRestart={onRestart} />
    </div>
  );
}

function BusyLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" aria-busy="true">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {text}
    </div>
  );
}

/**
 * 「Test again」只在**终态**渲染（进行中的相位没有按钮）⇒ 两轮不可能重叠，重测的竞态
 * 是构造性消除的，不靠禁用态去挡。重跑的是**整轮两步**（不提供「只重跑协议」的分支）。
 */
function RestartRow({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button variant="outline" onClick={onRestart}>
        Test again
      </Button>
    </div>
  );
}

/**
 * 联通性行（批次 O）。与协议行的视觉骨架相同，但**图标与 sr-only 文案刻意不同串**：
 * `reachable`/`unreachable` ≠ `passed`/`failed`（两个谓词不同，探针也要各认各的）。
 *
 * D14 的口径说明**常驻在行内**（除跳过态）：绿点 + `404 Not Found` 并排出现时，
 * 用户最自然的反应是「404 为什么是绿的」—— 不说这一句，这一行的信息就是自相矛盾的。
 */
function PingRow({
  ping,
  showDoctrine = true,
}: {
  ping: ProviderPingResult;
  showDoctrine?: boolean;
}) {
  const statusLabel = pingStatusLabel(ping);
  return (
    <div className="space-y-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {ping.reachable ? (
            <Wifi className="size-4 text-emerald-600" aria-hidden="true" />
          ) : (
            <WifiOff className="size-4 text-destructive" aria-hidden="true" />
          )}
          {PING_ROW_LABEL}
          {/* 成败不能只靠颜色传达（色觉障碍 + 截图存档），故状态同时进可读文本 */}
          <span className="sr-only">{ping.reachable ? "reachable" : "unreachable"}</span>
        </span>
        <span
          className={
            ping.reachable
              ? "font-mono text-xs text-muted-foreground"
              : "font-mono text-xs text-destructive"
          }
        >
          {statusLabel}
        </span>
      </div>
      {ping.url ? (
        <code className="block truncate font-mono text-xs text-muted-foreground" title={ping.url}>
          HEAD {ping.url}
        </code>
      ) : null}
      <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        {/* 只印一个耗时：ping 不读正文，TTFB 与 Total **恒等**（后端有断言守着），
            印两遍看着像 bug。分派依据仍是 `status !== null`（= 拿到了 HTTP 回应）——
            那才是「测到了首字节」；`status` 为 null 是连一个字节都没来，换个准确的名字。 */}
        {ping.status !== null ? (
          <span>
            TTFB <strong className="font-mono text-foreground">{ping.ttfbMs} ms</strong>
          </span>
        ) : (
          <span>
            Elapsed <strong className="font-mono text-foreground">{ping.totalMs} ms</strong>
          </span>
        )}
      </div>
      {ping.error ? <p className="break-words text-xs text-destructive">{ping.error}</p> : null}
      {showDoctrine ? (
        <p className="text-xs text-muted-foreground">{REACHABILITY_DOCTRINE}</p>
      ) : null}
    </div>
  );
}

function ProbeRow({ probe }: { probe: ProviderProbeResult }) {
  const statusLabel =
    probe.status !== null ? `${probe.status} ${probe.statusText}`.trim() : "no HTTP response";
  return (
    <div className="space-y-1 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {probe.ok ? (
            <CircleCheck className="size-4 text-emerald-600" aria-hidden="true" />
          ) : (
            <CircleX className="size-4 text-destructive" aria-hidden="true" />
          )}
          {probe.label}
          {/* 成败不能只靠颜色传达（色觉障碍 + 截图存档），故状态同时进可读文本 */}
          <span className="sr-only">{probe.ok ? "passed" : "failed"}</span>
        </span>
        <span
          className={
            probe.ok
              ? "font-mono text-xs text-muted-foreground"
              : "font-mono text-xs text-destructive"
          }
        >
          {statusLabel}
        </span>
      </div>
      <code
        className="block truncate font-mono text-xs text-muted-foreground"
        title={probe.url}
      >
        {probe.url}
      </code>
      <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        {/* 分派依据是 `status !== null`（= 响应头到过），不是 `ok` —— 两者不等价：
            上游回了 401/502 是 status 非空 + ok=false，而「响应头到了、正文读失败」同样是
            status 非空 + ok=false，两者都**确实测到了** TTFB，只有 status 为 null 的那种
            连一个字节都没来。后端有对应的不变式断言（status === null ⟺ 两个耗时同值）。 */}
        {probe.status !== null ? (
          <>
            <span>
              TTFB <strong className="font-mono text-foreground">{probe.ttfbMs} ms</strong>
            </span>
            <span>
              Total <strong className="font-mono text-foreground">{probe.totalMs} ms</strong>
            </span>
          </>
        ) : (
          // 网络层没拿到响应头：**一个字节都没来**，把它标成「首字节耗时」是措辞上的谎
          // （后端那边两个值本就取同一个数，见 probe.ts 的 catch 分支）。
          // 但「等了多久才知道失败」是真的且有用 —— 换个准确的名字，数字不换。
          <span>
            Elapsed <strong className="font-mono text-foreground">{probe.totalMs} ms</strong>
          </span>
        )}
      </div>
      {probe.error ? (
        <p className="break-words text-xs text-destructive">{probe.error}</p>
      ) : null}
    </div>
  );
}
