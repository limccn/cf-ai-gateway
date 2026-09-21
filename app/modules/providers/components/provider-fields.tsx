// Provider 表单的两组字段（批次 N，2026-09-21）。
//
// 为什么要抽成字段组件而不是把 JSX 复制三份：Add provider（不拆）与 Edit basics / Edit advanced
// 共用同一批字段。若各写一份，同一个字段的标签、placeholder、"留空=保持原值"提示、
// aria-invalid 接线就会三处漂移 —— 而漂移的形态恰恰是「Add 里改了提示、Edit 里还是旧文案」，
// 测试很难抓到。字段规则（校验）在 ../form.ts，字段呈现在这里，两者是同一份规则的两半。
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FieldErrors, ProviderFormState } from "../form";

// ============= 基础信息（Add / Edit basics 共用）=============

/**
 * API key 区块的三态。**用判别联合而不是两个布尔**：`keyReadOnly` + `keyEditing` 能表达
 * 「既只读又在编辑」这种不存在的状态，而三态里根本没有这种组合。
 */
export type ApiKeyMode =
  /** 新建：空密码框，必填。 */
  | { kind: "create" }
  /** 编辑·未点 Edit：**纯文本**展示掩码 + Edit 按钮。 */
  | { kind: "locked"; masked: string; onEdit: () => void }
  /** 编辑·已点 Edit：空密码框 + Discard 退回。 */
  | { kind: "editing"; onCancel: () => void };

export interface ProviderBasicsFieldsProps {
  value: ProviderFormState;
  onChange: (patch: Partial<ProviderFormState>) => void;
  errors: FieldErrors;
  apiKeyMode: ApiKeyMode;
  /** 编辑态：models 留空 = 保持原映射。新建态：必填。 */
  editing: boolean;
}

export function ProviderBasicsFields({
  value,
  onChange,
  errors,
  apiKeyMode,
  editing,
}: ProviderBasicsFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="provider-name">Name</Label>
          <Input
            id="provider-name"
            placeholder="openai-prod"
            value={value.name}
            onChange={(e) => onChange({ name: e.target.value })}
            aria-invalid={errors.name !== undefined}
          />
          {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-type">Type</Label>
          <Select
            id="provider-type"
            value={value.type}
            onChange={(e) => onChange({ type: e.target.value as ProviderFormState["type"] })}
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="provider-url">Base URL</Label>
        <Input
          id="provider-url"
          type="url"
          placeholder="https://api.openai.com/v1"
          value={value.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          aria-invalid={errors.baseUrl !== undefined}
        />
        {errors.baseUrl ? <p className="text-xs text-destructive">{errors.baseUrl}</p> : null}
      </div>

      <ApiKeyField value={value} onChange={onChange} errors={errors} mode={apiKeyMode} />

      <div className="space-y-2">
        <Label htmlFor="provider-models">Model mapping (internal=upstream, one per line)</Label>
        <Textarea
          id="provider-models"
          rows={4}
          placeholder={"gpt-4o=gpt-4o-2024-11-20\nclaude-sonnet=claude-sonnet-4.5"}
          value={value.modelsText}
          onChange={(e) => onChange({ modelsText: e.target.value })}
          aria-invalid={errors.models !== undefined}
        />
        {errors.models ? <p className="text-xs text-destructive">{errors.models}</p> : null}
        {editing ? (
          <p className="text-xs text-muted-foreground">
            Leave empty to keep the current mapping (there is no way to clear all mappings — set
            them individually or recreate the provider).
          </p>
        ) : null}
      </div>
    </>
  );
}

interface ApiKeyFieldProps {
  value: ProviderFormState;
  onChange: (patch: Partial<ProviderFormState>) => void;
  errors: FieldErrors;
  mode: ApiKeyMode;
}

/**
 * API key 字段。防 autofill 的关键在 `locked` 分支的**渲染形态**，不在属性上：
 * 密码管理器只对**表单控件**做 autofill，所以未进入编辑态时这里根本不渲染 `<input>`，
 * 而是一个 `<code>` 文本节点 —— 没有可填的目标，也就无从覆盖。
 *
 * 对比「渲染 `<input readonly>` 再指望浏览器别填」：那是靠属性请求浏览器配合，
 * 而 readonly 输入框在部分密码管理器里仍会被填充（填进去还不触发 onChange，用户看不见）。
 * 非控件渲染是**构造性**免疫，不依赖任何一方守规矩。
 */
function ApiKeyField({ value, onChange, errors, mode }: ApiKeyFieldProps) {
  if (mode.kind === "locked") {
    return (
      <div className="space-y-2">
        <Label htmlFor="provider-key-readonly">API key</Label>
        <div className="flex items-center gap-2">
          <code
            id="provider-key-readonly"
            className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-input bg-muted/50 px-3 font-mono text-xs text-muted-foreground"
          >
            <span className="truncate">{mode.masked}</span>
          </code>
          <Button type="button" variant="outline" size="sm" onClick={mode.onEdit}>
            <Pencil aria-hidden="true" />
            Edit
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Stored keys are only ever shown masked. Click Edit to replace it.
        </p>
      </div>
    );
  }

  const editing = mode.kind === "editing";
  return (
    <div className="space-y-2">
      <Label htmlFor="provider-key">API key</Label>
      <div className="flex items-center gap-2">
        <Input
          id="provider-key"
          type="password"
          // 显式声明「这是新密码」：用户主动点 Edit 后才渲染出该控件，
          // 不加这句密码管理器会把它当登录框，用存好的凭据覆盖用户正在输入的值。
          autoComplete="new-password"
          autoFocus={editing}
          placeholder={editing ? "Leave empty to keep current key" : "sk-..."}
          value={value.apiKey}
          onChange={(e) => onChange({ apiKey: e.target.value })}
          aria-invalid={errors.apiKey !== undefined}
        />
        {editing ? (
          // 文案是 "Discard" 而不是 "Cancel"：弹窗底部已有一个 Cancel（关整个弹窗），
          // 两个同名按钮并排会让「我点的是哪个」变成猜谜。Discard 明确指「丢弃这次密钥修改」。
          <Button type="button" variant="outline" size="sm" onClick={mode.onCancel}>
            Discard
          </Button>
        ) : null}
      </div>
      {errors.apiKey ? <p className="text-xs text-destructive">{errors.apiKey}</p> : null}
      {editing ? (
        <p className="text-xs text-muted-foreground">Leave empty to keep the existing key.</p>
      ) : null}
    </div>
  );
}

// ============= 高级选项（Add 的 Collapsible 内 / Edit advanced 共用）=============

export interface ProviderAdvancedFieldsProps {
  value: ProviderFormState;
  onChange: (patch: Partial<ProviderFormState>) => void;
  errors: FieldErrors;
}

export function ProviderAdvancedFields({ value, onChange, errors }: ProviderAdvancedFieldsProps) {
  const httpOptionsError = errors.httpOptions ?? null;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="provider-http-options">HTTP options (JSON, optional)</Label>
        <Textarea
          id="provider-http-options"
          rows={4}
          className="font-mono text-xs"
          placeholder={JSON.stringify(
            { userAgent: "MyAgent/1.0", headers: { "X-Provider": "acme" }, body: { temperature: 0 } },
            null,
            2,
          )}
          value={value.httpOptionsText}
          onChange={(e) => onChange({ httpOptionsText: e.target.value })}
          aria-invalid={httpOptionsError !== null}
        />
        <p className="text-xs text-muted-foreground">
          Overrides User-Agent, adds/overrides headers and body fields on upstream requests. Stored
          header values are shown masked — leave the field empty to keep them, or retype a full
          value to replace it.
        </p>
        {httpOptionsError ? <p className="text-xs text-destructive">{httpOptionsError}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="provider-weight">Weight (load balance)</Label>
        <Input
          id="provider-weight"
          type="number"
          min={1}
          max={1000}
          value={value.weight}
          onChange={(e) => onChange({ weight: e.target.valueAsNumber || 0 })}
          aria-invalid={errors.weight !== undefined}
        />
        <p className="text-xs text-muted-foreground">
          Requests are split across providers sharing a model proportionally to weight (1-1000).
        </p>
        {errors.weight ? <p className="text-xs text-destructive">{errors.weight}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="provider-thinking-mode">Thinking mode (anthropic upstream)</Label>
        <Select
          id="provider-thinking-mode"
          value={value.thinkingMode ?? "auto"}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              thinkingMode: v === "auto" ? null : (v as Exclude<ProviderFormState["thinkingMode"], null>),
            });
          }}
        >
          <option value="auto">auto — adaptive line (default)</option>
          <option value="adaptive">adaptive — force adaptive thinking</option>
          <option value="budget">budget — legacy fixed-budget models</option>
          <option value="off">off — drop reasoning_effort</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          Maps inbound <code>reasoning_effort</code> (Codex / OpenAI clients) to Anthropic{" "}
          <code>output_config.effort</code>. auto prefers the adaptive line; budget is for old
          models that only accept <code>thinking.budget_tokens</code> (passthrough only, effort
          mapping is skipped).
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          <input
            type="checkbox"
            id="provider-reasoning-roundtrip"
            checked={value.reasoningRoundtrip}
            onChange={(e) => onChange({ reasoningRoundtrip: e.target.checked })}
            className="mt-0.5"
          />
          <span>
            Reasoning round-trip <span className="text-muted-foreground">(openai upstream)</span>
          </span>
        </label>
        <p className="text-xs text-muted-foreground">
          Keep assistant <code>reasoning_content</code> when forwarding to the upstream (required by
          deepseek thinking-mode models). Off by default — upstreams receive no{" "}
          <code>reasoning_content</code>.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="provider-upstream-timeout">Upstream timeout (ms)</Label>
        <Input
          id="provider-upstream-timeout"
          type="number"
          min={1000}
          max={600000}
          step={1000}
          placeholder="60000 (default)"
          value={value.upstreamTimeoutMs}
          onChange={(e) => onChange({ upstreamTimeoutMs: e.target.value })}
          aria-invalid={errors.upstreamTimeoutMs !== undefined}
        />
        <p className="text-xs text-muted-foreground">
          Timeout for upstream responses. Slow long-generation models (e.g. b.ai glm-5.3-flash) may
          need 120000+. Leave empty for the 60s default.
        </p>
        {errors.upstreamTimeoutMs ? (
          <p className="text-xs text-destructive">{errors.upstreamTimeoutMs}</p>
        ) : null}
      </div>
    </>
  );
}

/** 表单顶部的提交错误条（mutation 失败时显示）。 */
export function FormError({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
