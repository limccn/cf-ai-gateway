// Test connection 弹窗（批次 N，2026-09-21；PRD N3 / 裁决 D11）。
//
// 三条协议各发一次最小真实请求，报「通不通 + HTTP 状态 + TTFB + 总耗时」。
//
// **口径必须说清**（D11）：探的是**上游原生端点**，不是网关出站路径。网关出站只有两条
// （openai → /chat/completions、anthropic → /v1/messages）；`/responses` 是入站协议，
// 会被转换成 chat 形态后走 openai 那条出站，网关自己从不打上游的 /responses。
// ⇒ responses 那一行回答的是「这个上游支不支持 Responses API」，与网关链路是否通无关。
// 这句话不能只写在代码注释里 —— 用户看到一行红/绿就会据此判断，所以 UI 上原样说明。
//
// 本弹窗**对网关自身无副作用**：后端路由不写断路器、不计网关的费、不落 request_logs，故：
//   · 不 invalidate provider 列表（没有任何东西变了，闪一下反而像「探测把 provider 踢下线了」）；
//   · 失败不代表 provider 被停用 —— 文案里要说明，否则用户会以为测试失败=已下线。
//
// ⚠ **但不能说「不产生任何费用」**：这是三条**真实的上游调用**，用的是 provider 自己的 key，
// 多数上游按 token 计费（默认 max_tokens=16，仍是真实账单）；且 provider 的 `httpOptions.body`
// 会覆盖这个默认值（`applyHttpBody` 是 Object.assign，配置值总是赢），配了
// `{"max_tokens": 8192}` 就是三条真实大生成。**「Nothing is billed」是句无法兑现的承诺** ——
// 卡片描述里必须写「网关不记账 + 上游可能计费」，不能说成「不产生费用」。
import { useEffect } from "react";
import { CircleCheck, CircleX, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/states";
import { useTestProvider } from "../hooks/use-test-provider";
import type { ProviderProbeResult, ProviderResponse } from "../types";

export interface ProviderTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderResponse | null;
}

export function ProviderTestDialog({ open, onOpenChange, provider }: ProviderTestDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `Test connection — ${provider.name}` : "Test connection"}
      // 措辞红线（见文件头）：**不能说 Nothing is billed** —— 网关确实不记账、不改 provider 状态，
      // 但这是三条真实上游调用（用 provider 的 key），上游那边可能真计费。
      description="Real calls to the upstream using this provider's key. The gateway records no usage and changes no provider state — but the upstream may bill a few tokens."
    >
      {open && provider ? <TestRun provider={provider} /> : null}
    </Dialog>
  );
}

function TestRun({ provider }: { provider: ProviderResponse }) {
  const test = useTestProvider();
  const { mutate } = test;
  // 打开即跑：用户点 Zap 图标就是因为想知道结果，再让他点一次「开始测试」是多余的。
  // mutate 在 react-query 里是稳定引用，effect 不会因渲染重复触发。
  useEffect(() => {
    mutate(provider.id);
  }, [mutate, provider.id]);

  if (test.isPending) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" aria-busy="true">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Probing three protocols…
      </div>
    );
  }

  if (test.isError) {
    return (
      <ErrorState
        title="Test request failed"
        message={test.error.message}
        onRetry={() => mutate(provider.id)}
      />
    );
  }

  // 显式收窄（quality.md Forbidden Pattern #6：不用 non-null assertion）。
  // isPending/isError 都不成立时 data 必有值，但 TS 不会跨 isPending/isError 收窄，
  // 这里把「不可能」写成一次可读的早退。
  const data = test.data;
  if (!data) {
    return null;
  }
  const passed = data.probes.filter((probe) => probe.ok).length;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <strong className="text-foreground">
          {passed} of {data.probes.length}
        </strong>{" "}
        protocols responded · model <code className="font-mono text-xs">{data.model}</code> · timeout{" "}
        {Math.round(data.timeoutMs / 1000)}s
      </p>

      <div className="space-y-2">
        {data.probes.map((probe) => (
          <ProbeRow key={probe.protocol} probe={probe} />
        ))}
      </div>

      {/* D11 的口径说明：只在确有 responses 一行时渲染，且不塞进行内（那行本身已经很挤） */}
      {data.probes.some((p) => p.protocol === "openai-responses") ? (
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

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" onClick={() => mutate(provider.id)}>
          Test again
        </Button>
      </div>
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
