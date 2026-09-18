// /providers — 上游 Provider 管理（M6 6.3，admin）：
// CRUD 表格；models 映射以 textarea 行格式 `内部名=上游名` 编辑，Zod 校验后转为 JSON。
// httpOptions 以 JSON textarea 编辑（前端校验与后端 httpOptionsSchema 一致，见 src/routes/providers/types.ts）。
import { useState, type FormEvent } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { z } from "zod";
import { useProviders } from "@/modules/providers/hooks/use-providers";
import { useCreateProvider } from "@/modules/providers/hooks/use-create-provider";
import { useUpdateProvider } from "@/modules/providers/hooks/use-update-provider";
import { useDeleteProvider } from "@/modules/providers/hooks/use-delete-provider";
import type { ProviderResponse } from "@/modules/providers/types";
import { httpOptionsSchema } from "../../src/routes/providers/types";
import { formatDateTime } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Collapsible } from "@/components/ui/collapsible";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ErrorState, EmptyState } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ============= Zod 表单 Schema =============

/** textarea 行格式 → 路由映射对象（内部名=上游名，每行一个）。 */
const modelsMapTextSchema = z
  .string()
  .transform((text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )
  .refine((lines) => lines.length > 0, {
    message: "At least one model mapping is required",
  })
  .refine((lines) => lines.every((line) => line.includes("=")), {
    message: "Each line must be in the form: internalName=upstreamName",
  })
  .transform((lines) => {
    const record: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...rest] = line.split("=");
      if (key === undefined) {
        continue;
      }
      const internal = key.trim();
      const upstream = rest.join("=").trim();
      if (internal.length > 0 && upstream.length > 0) {
        record[internal] = upstream;
      }
    }
    return record;
  })
  .refine((record) => Object.keys(record).length > 0, {
    message: "Each mapping needs a non-empty internal and upstream name",
  });

function modelsToText(models: Record<string, string>): string {
  return Object.entries(models)
    .map(([internal, upstream]) => `${internal}=${upstream}`)
    .join("\n");
}

// ============= httpOptions（JSON textarea）=============

/**
 * 解析 httpOptions JSON 文本 → 提交值。
 * 空文本 → undefined（创建：不配置；编辑：保持原配置）；解析/结构校验失败 → 错误消息。
 * 校验规则与后端 httpOptionsSchema 一致（header 名 token 字符集、值禁 CR/LF、长度上限）。
 */
function parseHttpOptionsText(
  text: string,
): { ok: true; value?: z.infer<typeof httpOptionsSchema> } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "Must be valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      message: 'Must be a JSON object, e.g. {"userAgent":"MyAgent/1.0","headers":{"X-Provider":"acme"},"body":{"temperature":0}}',
    };
  }
  const result = httpOptionsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "";
    return { ok: false, message: `${path ? `${path}: ` : ""}${issue?.message ?? "Invalid http options"}` };
  }
  return { ok: true, value: result.data };
}

/** 是否已配置 httpOptions（响应中未配置 = 空对象）。 */
function hasHttpOptions(httpOptions: ProviderResponse["httpOptions"]): boolean {
  if (!httpOptions) {
    return false;
  }
  return (
    httpOptions.userAgent !== undefined ||
    Object.keys(httpOptions.headers ?? {}).length > 0 ||
    Object.keys(httpOptions.body ?? {}).length > 0
  );
}

/** 响应对象 → 编辑回填文本：跳过空对象字段；全部为空 → 空文本（编辑留空 = 保持原配置）。 */
function httpOptionsToText(httpOptions: ProviderResponse["httpOptions"]): string {
  if (!httpOptions) {
    return "";
  }
  const compact: Record<string, unknown> = {};
  if (httpOptions.userAgent !== undefined) {
    compact.userAgent = httpOptions.userAgent;
  }
  if (Object.keys(httpOptions.headers ?? {}).length > 0) {
    compact.headers = httpOptions.headers;
  }
  if (Object.keys(httpOptions.body ?? {}).length > 0) {
    compact.body = httpOptions.body;
  }
  return Object.keys(compact).length === 0 ? "" : JSON.stringify(compact, null, 2);
}

const providerFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Max 100 characters"),
  type: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().url("Enter a valid URL").max(500),
  apiKey: z.string().min(1, "API key is required").max(1000),
  models: modelsMapTextSchema,
  weight: z.coerce.number().int("Must be a whole number").min(1, "Min 1").max(1000, "Max 1000"),
  // R2 思考模式（null ≡ auto）；仅 anthropic 上游有意义，UI 下拉选择
  thinkingMode: z.enum(["adaptive", "budget", "off"]).nullable().optional(),
  // Workstream B：reasoning 回传（仅 openai 上游有意义，UI checkbox）
  reasoningRoundtrip: z.boolean().optional(),
  // 09-01-stg-glm-ccswitch-fix：上游超时（ms；null ≡ 默认 60s；UI 空输入 = null）
  upstreamTimeoutMs: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? null : v),
    z
      .coerce
      .number()
      .int("Must be a whole number")
      .min(1000, "Min 1000 ms")
      .max(600000, "Max 600000 ms")
      .nullable()
      .optional(),
  ),
});

const updateProviderFormSchema = providerFormSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Change at least one field" });

// ============= 子组件：表单对话框 =============

interface ProviderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ProviderResponse;
}

function ProviderFormDialog({ open, onOpenChange, editing }: ProviderFormDialogProps) {
  const createProvider = useCreateProvider();
  const updateProvider = useUpdateProvider();

  const [name, setName] = useState("");
  const [type, setType] = useState<"openai" | "anthropic">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [httpOptionsText, setHttpOptionsText] = useState("");
  const [weight, setWeight] = useState(1);
  const [thinkingMode, setThinkingMode] = useState<"adaptive" | "budget" | "off" | null>(null);
  const [reasoningRoundtrip, setReasoningRoundtrip] = useState(false);
  const [upstreamTimeoutMs, setUpstreamTimeoutMs] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName(editing?.name ?? "");
      setType(editing?.type ?? "openai");
      setBaseUrl(editing?.baseUrl ?? "");
      setApiKey("");
      setModelsText(editing ? modelsToText(editing.models) : "");
      setHttpOptionsText(editing ? httpOptionsToText(editing.httpOptions) : "");
      setWeight(editing?.weight ?? 1);
      setThinkingMode(editing?.thinkingMode ?? null);
      setReasoningRoundtrip(editing?.reasoningRoundtrip ?? false);
      setUpstreamTimeoutMs(editing?.upstreamTimeoutMs?.toString() ?? "");
      // 编辑已有高级配置时默认展开，避免用户看不到已配置项
      setAdvancedOpen(editing ? hasHttpOptions(editing.httpOptions) : false);
      setErrors({});
    }
  }

  const isBusy = createProvider.isPending || updateProvider.isPending;
  const mutationError = createProvider.error?.message ?? updateProvider.error?.message;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    // httpOptions 单独解析（JSON 文本 → 结构校验；空文本：创建不配置 / 编辑保持原配置）
    const httpOptions = parseHttpOptionsText(httpOptionsText);
    if (!httpOptions.ok) {
      setErrors({ httpOptions: httpOptions.message });
      return;
    }
    const values = {
      name,
      type,
      baseUrl,
      apiKey,
      models: modelsText,
      weight,
      // R2：思考模式（null ≡ auto；编辑时显式传 null = 重置）
      thinkingMode,
      // Workstream B：reasoning 回传（false = 剥离；编辑时显式传 false = 关闭）
      reasoningRoundtrip,
      // 09-01：上游超时（空 = null ≡ 默认 60s；编辑时显式传 null = 重置默认）
      upstreamTimeoutMs: upstreamTimeoutMs === "" ? null : Number(upstreamTimeoutMs),
    };
    if (editing) {
      // 编辑模式：空 apiKey 表示不更换密钥（omit）；空 httpOptions 表示保持原配置
      const payload: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(values)) {
        if (field === "apiKey" && (value === "" || value === undefined)) {
          continue;
        }
        if (field === "models") {
          continue; // 在下面按 schema 单独解析
        }
        payload[field] = value;
      }
      if (httpOptions.value !== undefined) {
        payload.httpOptions = httpOptions.value;
      }
      // Zod v4：含 refine 的 object schema 不能用 .extend() 覆盖已有 key（会抛错），须用 .safeExtend()
      const schema = updateProviderFormSchema.safeExtend({
        models: modelsMapTextSchema.optional(),
      });
      const parsed = schema.safeParse({
        ...payload,
        ...(modelsText.trim().length > 0 ? { models: modelsText } : {}),
      });
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        await updateProvider.mutateAsync({ id: editing.id, ...parsed.data });
        onOpenChange(false);
      } catch {
        // 错误显示在对话框底部
      }
    } else {
      const parsed = providerFormSchema.safeParse(values);
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        // 新 provider 恒为 enabled（启停由列表 Action 开关管理，创建时不提供 enabled UI）
        await createProvider.mutateAsync({
          ...parsed.data,
          enabled: true,
          ...(httpOptions.value !== undefined ? { httpOptions: httpOptions.value } : {}),
        });
        onOpenChange(false);
      } catch {
        // 错误显示在对话框底部
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit provider — ${editing.name}` : "Add provider"}
      description={
        editing
          ? "Leave the API key empty to keep the existing key."
          : "Provider keys are encrypted at rest and never shown again."
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {mutationError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {mutationError}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="provider-name">Name</Label>
            <Input
              id="provider-name"
              placeholder="openai-prod"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={errors.name !== undefined}
            />
            {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-type">Type</Label>
            <Select
              id="provider-type"
              value={type}
              onChange={(e) => setType(e.target.value as "openai" | "anthropic")}
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
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            aria-invalid={errors.baseUrl !== undefined}
          />
          {errors.baseUrl ? <p className="text-xs text-destructive">{errors.baseUrl}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-key">API key</Label>
          <Input
            id="provider-key"
            type="password"
            placeholder={editing ? "Leave empty to keep current key" : "sk-..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-invalid={errors.apiKey !== undefined}
          />
          {errors.apiKey ? <p className="text-xs text-destructive">{errors.apiKey}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="provider-models">Model mapping (internal=upstream, one per line)</Label>
          <Textarea
            id="provider-models"
            rows={4}
            placeholder={"gpt-4o=gpt-4o-2024-11-20\nclaude-sonnet=claude-sonnet-4.5"}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            aria-invalid={errors.models !== undefined}
          />
          {errors.models ? <p className="text-xs text-destructive">{errors.models}</p> : null}
          <p className="text-xs text-muted-foreground">
            Editing: leave empty to keep the current mapping (there is no way to clear all
            mappings — set them individually or recreate the provider).
          </p>
        </div>
        <Collapsible title="Advanced options" open={advancedOpen} onOpenChange={setAdvancedOpen}>
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
              value={httpOptionsText}
              onChange={(e) => setHttpOptionsText(e.target.value)}
              aria-invalid={errors.httpOptions !== undefined}
            />
            <p className="text-xs text-muted-foreground">
              {editing
                ? "Leave empty to keep the current options; stored header values are shown masked (retype a full value to replace it)."
                : "Overrides User-Agent, adds/overrides headers and body fields on upstream requests. Header values are encrypted at rest and never shown again."}
            </p>
            {errors.httpOptions ? <p className="text-xs text-destructive">{errors.httpOptions}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="provider-weight">Weight (load balance)</Label>
            <Input
              id="provider-weight"
              type="number"
              min={1}
              max={1000}
              value={weight}
              onChange={(e) => setWeight(e.target.valueAsNumber || 0)}
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
              value={thinkingMode ?? "auto"}
              onChange={(e) => {
                const v = e.target.value;
                setThinkingMode(v === "auto" ? null : (v as "adaptive" | "budget" | "off"));
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
                checked={reasoningRoundtrip}
                onChange={(e) => setReasoningRoundtrip(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Reasoning round-trip <span className="text-muted-foreground">(openai upstream)</span>
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Keep assistant <code>reasoning_content</code> when forwarding to the upstream (required
              by deepseek thinking-mode models). Off by default — upstreams receive no{" "}
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
              value={upstreamTimeoutMs}
              onChange={(e) => setUpstreamTimeoutMs(e.target.value)}
              aria-invalid={errors.upstreamTimeoutMs !== undefined}
            />
            <p className="text-xs text-muted-foreground">
              Timeout for upstream responses. Slow long-generation models (e.g. b.ai glm-5.3-flash)
              may need 120000+. Leave empty for the 60s default.
            </p>
            {errors.upstreamTimeoutMs ? (
              <p className="text-xs text-destructive">{errors.upstreamTimeoutMs}</p>
            ) : null}
          </div>
        </Collapsible>
        {errors.root ? <p className="text-xs text-destructive">{errors.root}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button type="submit" disabled={isBusy}>
            {isBusy ? "Saving…" : editing ? "Save changes" : "Add provider"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ============= 页面 =============

export default function ProvidersPage() {
  const providersQuery = useProviders();
  const updateProvider = useUpdateProvider();
  const deleteProvider = useDeleteProvider();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderResponse | null>(null);
  const [deleting, setDeleting] = useState<ProviderResponse | null>(null);

  const items = providersQuery.data?.items ?? [];

  // 前端内存过滤（列表量小；API 无 search 参数）
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const filtered = query
    ? items.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.baseUrl.toLowerCase().includes(query) ||
          p.apiKeyMasked.toLowerCase().includes(query),
      )
    : items;

  return (
    <PageContainer>
      <PageHeader
        title="Providers"
        description="Upstream AI providers and their model mappings (admin)"
        actions={
          <Button onClick={() => setFormOpen(true)}>
            <Plus aria-hidden="true" />
            Add provider
          </Button>
        }
      />

      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Providers</CardTitle>
            <CardDescription>Add and manage upstream providers</CardDescription>
          </div>
          {items.length > 0 ? (
            <div className="relative w-40 shrink-0">
              <Search
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="Search providers"
                className="pl-9"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {providersQuery.isLoading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : providersQuery.isError ? (
            <div className="p-6">
              <ErrorState message={providersQuery.error.message} onRetry={() => providersQuery.refetch()} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={items.length === 0 ? "No providers yet" : "No providers match"}
                description={
                  items.length === 0 ? "Add an upstream provider to start routing requests." : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Type</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead className="hidden md:table-cell">Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((provider) => (
                  <TableRow key={provider.id}>
                    <TableCell className="font-medium">{provider.name}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline">{provider.type}</Badge>
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground" title={provider.baseUrl}>
                      {provider.baseUrl}
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs text-muted-foreground">
                        {provider.apiKeyMasked}
                      </code>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {formatDateTime(provider.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={provider.enabled ? "success" : "muted"}>
                          {provider.enabled ? "enabled" : "disabled"}
                        </Badge>
                        {provider.circuitBroken ? (
                          <Badge variant="destructive" title={`Circuit open since ${provider.circuitReason}`}>
                            circuit open ({provider.circuitReason})
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Switch
                          checked={provider.enabled}
                          onCheckedChange={(next) =>
                            updateProvider.mutate({ id: provider.id, enabled: next })
                          }
                          aria-label={
                            provider.enabled
                              ? `Disable ${provider.name}`
                              : `Enable ${provider.name}`
                          }
                          title={provider.enabled ? "Disable provider" : "Enable provider"}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditing(provider)}
                          aria-label={`Edit ${provider.name}`}
                          title="Edit"
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleting(provider)}
                          aria-label={`Delete ${provider.name}`}
                          title="Delete"
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProviderFormDialog
        open={formOpen || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setFormOpen(false);
            setEditing(null);
          }
        }}
        editing={editing ?? undefined}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        title="Delete provider"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Delete provider <strong>{deleting?.name}</strong>? Requests referencing its models will
            fail until the models are re-routed.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={deleteProvider.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProvider.isPending}
              onClick={() => {
                if (deleting) {
                  deleteProvider.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
                }
              }}
            >
              {deleteProvider.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </Dialog>
    </PageContainer>
  );
}
