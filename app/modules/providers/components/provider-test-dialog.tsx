// Test connection 弹窗（批次 N 建；批次 O 加「先 ping 联通、再跑探测」；批次 6 改逐面探测 + 声明动作）。
//
// **两步**（PRD 裁决 D16）：先打上游 origin 根的联通性（HEAD，不带任何凭据；收到**任何** HTTP
// 回应含 401/403/404 即算联通），联通后才发第二步按解析层端点**逐面**探测。未联通 ⇒ 探测
// **完全不跑**，上游一条模型调用都没有 —— 这是本功能存在的意义：把「网络/DNS/TLS 不通」
// 与「上游拒绝了这次调用」分开，前者根本不该产生任何上游调用，也不该消耗任何 token。
//
// 逐面探测的口径（批次 6）：探测行 = 解析层 resolved 端点集，每行都是**生产可达的 URL**
// （「探测绿 = 生产同 URL」行级成立）。旧版「responses 行无生产对应物」的 D11 说明随逐面
// 探测消失：未声明 responses 面的记录不再有该行；声明了的记录网关真的会打它（边界 J）。
// 行数是记录的函数（legacy 2/3 行、custom 按声明面），UI 不写死「三条」。
//
// 「声明此端点」（批次 6 G2）：每行一个显式按钮，POST declare-endpoint **只写 protocols
// 子对象**；成功后 invalidate 列表（与探测的「刻意不 invalidate」相反——这里真的改了状态）。
// 文案有两条硬义务（provider-test-state.ts 的 DECLARE_*，单测守着）：legacy 记录要先警示
// 「声明面完全取代隐式面表」；红行提示「不建议声明」但**不硬拦**。
//
// 本弹窗对网关自身**除声明外无副作用**：后端探测两条路由不写断路器、不计网关的费、不落
// request_logs，故探测失败不 invalidate 列表（闪一下反而像「测试把 provider 踢下线了」）；
// 失败不代表 provider 被停用 —— 文案里要说明，否则用户会以为测试失败=已下线。
//
// ⚠ **但不能说「不产生任何费用」**：第二步是**逐面真实上游调用**，用 provider 自己的 key，
// 多数上游按 token 计费（默认 max_tokens=16 仍是真实账单）；且 provider 的 `httpOptions.body`
// 会覆盖这个默认值（`applyHttpBody` 是 Object.assign，配置值总是赢），配了
// `{"max_tokens": 8192}` 就是逐行真实大生成。**「Nothing is billed」是句无法兑现的承诺** ——
// 描述文案按相位分叉（见 provider-test-state.ts），第一条命令的 HEAD 才真的不产生费用。
import { CircleCheck, CircleX, Loader2, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/states";
import { useDeclareEndpoint } from "../hooks/use-declare-endpoint";
import { useProviderTestRun } from "../hooks/use-provider-test-run";
import {
  DECLARE_AFTER_NOTICE,
  DECLARE_FAILED_HINT,
  DECLARE_IMPLICIT_NOTICE,
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

/**
 * 展示 + 显式声明动作。相位由编排 hook 单向下发（无 effect）；「声明此端点」是
 * useMutation（**不自触发**——只由按钮的 onClick 驱动，StrictMode 双挂载不会多发出请求）。
 */
function TestRunView({
  phase,
  provider,
  onRestart,
}: {
  phase: TestRunPhase;
  provider: ProviderResponse;
  onRestart: () => void;
}) {
  const declare = useDeclareEndpoint();

  if (phase.kind === "pinging") {
    return <BusyLine text="Checking reachability… (up to 10s)" />;
  }

  if (phase.kind === "probing") {
    // ping 行**留在场上**：这是「两步」的可见证据，也避免弹窗在两步之间掉成空白帧
    return (
      <div className="space-y-3">
        <PingRow ping={phase.ping} />
        <BusyLine text="Probing the declared endpoints…" />
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
  // 已声明面（provider.protocols 缺席 = legacy 隐式面表，不是空声明表）
  const declaredFaces = provider.protocols ?? {};
  const declared = (face: ProviderProbeResult["face"]): boolean =>
    declaredFaces[face] !== undefined;
  return (
    <div className="space-y-3">
      <PingRow ping={phase.ping} />

      <p className="text-sm text-muted-foreground">
        <strong className="text-foreground">
          {passed} of {phase.probes.length}
        </strong>{" "}
        endpoints responded · model <code className="font-mono text-xs">{phase.model}</code> · timeout{" "}
        {Math.round(phase.timeoutMs / 1000)}s
      </p>

      {/* legacy 警示常驻在行列表上方：声明面完全取代隐式面表（design §2.2 规则 1），
          不说这句，管理员点一下声明就会踩到静默的服务面收窄 */}
      {provider.protocols === undefined ? (
        <p className="text-xs text-muted-foreground">{DECLARE_IMPLICIT_NOTICE}</p>
      ) : null}

      <div className="space-y-2">
        {phase.probes.map((probe) => (
          <ProbeRow
            key={probe.face}
            probe={probe}
            declared={declared(probe.face)}
            declarePending={declare.isPending && declare.variables?.face === probe.face}
            onDeclare={() => declare.mutate({ id: provider.id, face: probe.face })}
          />
        ))}
      </div>

      {declare.isError ? (
        <p className="break-words text-xs text-destructive">
          {declare.error instanceof Error ? declare.error.message : "Declare request failed"}
        </p>
      ) : null}
      {declare.isSuccess ? (
        <p className="text-xs text-muted-foreground">{DECLARE_AFTER_NOTICE}</p>
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

/**
 * 逐面探测行 + 「声明此端点」动作（批次 6 G2）。
 * 独立动作按钮 ⇒ **原生 disabled**（该禁时不该可聚焦的灰项语义相反，见 spec 前端惯例）：
 * 已声明（该面已在 protocols 里，按钮只发 {face} 是幂等 no-op，没有第二次可做）与
 * 在途（该行的声明请求未落）时禁用；红行**不禁用**——「探测红不建议声明」是提示不是硬拦
 * （401 可能只是鉴权风格不对，端点本身存在），提示文案在行内常驻。
 */
function ProbeRow({
  probe,
  declared,
  declarePending,
  onDeclare,
}: {
  probe: ProviderProbeResult;
  declared: boolean;
  declarePending: boolean;
  onDeclare: () => void;
}) {
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
      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={probe.url}>
          {probe.dialect === "anthropic" ? "Anthropic Messages endpoint" : "OpenAI endpoint"} ·{" "}
          {declared ? "declared in routing" : "not declared"}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={declared || declarePending}
          onClick={onDeclare}
        >
          {declarePending ? "Declaring…" : declared ? "Declared" : "Declare this endpoint"}
        </Button>
      </div>
      {!probe.ok && !declared ? (
        <p className="text-xs text-muted-foreground">{DECLARE_FAILED_HINT}</p>
      ) : null}
    </div>
  );
}
