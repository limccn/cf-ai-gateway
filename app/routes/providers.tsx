// /providers — 上游 Provider 管理（M6 6.3，admin）：
// CRUD 表格；models 映射以 textarea 行格式 `内部名=上游名` 编辑，Zod 校验后转为 JSON。
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { z } from "zod";
import { useProviders } from "@/modules/providers/hooks/use-providers";
import { useCreateProvider } from "@/modules/providers/hooks/use-create-provider";
import { useUpdateProvider } from "@/modules/providers/hooks/use-update-provider";
import { useDeleteProvider } from "@/modules/providers/hooks/use-delete-provider";
import type { ProviderResponse } from "@/modules/providers/types";
import { formatDateTime } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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

const providerFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Max 100 characters"),
  type: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().url("Enter a valid URL").max(500),
  apiKey: z.string().min(1, "API key is required").max(1000),
  models: modelsMapTextSchema,
  enabled: z.boolean(),
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
  const [enabled, setEnabled] = useState(true);
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
      setEnabled(editing?.enabled ?? true);
      setErrors({});
    }
  }

  const isBusy = createProvider.isPending || updateProvider.isPending;
  const mutationError = createProvider.error?.message ?? updateProvider.error?.message;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    const values = {
      name,
      type,
      baseUrl,
      apiKey,
      models: modelsText,
      enabled,
    };
    if (editing) {
      // 编辑模式：空 apiKey 表示不更换密钥（omit）
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
      const schema = updateProviderFormSchema.extend({
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
        await createProvider.mutateAsync(parsed.data);
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
            placeholder={"gpt-4o=gpt-4o-2024-11-20\nclaude-sonnet=claude-sonnet-4-5"}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            aria-invalid={errors.models !== undefined}
          />
          {errors.models ? <p className="text-xs text-destructive">{errors.models}</p> : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Provider enabled (requests can be routed to it)
        </label>
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
  const deleteProvider = useDeleteProvider();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderResponse | null>(null);
  const [deleting, setDeleting] = useState<ProviderResponse | null>(null);

  const items = providersQuery.data?.items ?? [];

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

      {providersQuery.isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : providersQuery.isError ? (
        <ErrorState message={providersQuery.error.message} onRetry={() => providersQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No providers yet"
          description="Add an upstream provider to start routing requests."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((provider) => (
                <TableRow key={provider.id}>
                  <TableCell className="font-medium">{provider.name}</TableCell>
                  <TableCell>
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
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {Object.keys(provider.models).length} mapping
                      {Object.keys(provider.models).length === 1 ? "" : "s"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={provider.enabled ? "success" : "muted"}>
                      {provider.enabled ? "enabled" : "disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(provider.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(provider)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleting(provider)}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

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
