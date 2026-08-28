// /keys — 密钥管理（M6 6.3）：CRUD 表格；创建时明文仅展示一次；
// 更新（名称/限流/缓存）、吊销、删除均带确认。
import { useState, type FormEvent, type ReactNode } from "react";
import { Copy, Plus } from "lucide-react";
import { z } from "zod";
import { useKeys } from "@/modules/keys/hooks/use-keys";
import { useCreateKey } from "@/modules/keys/hooks/use-create-key";
import { useUpdateKey } from "@/modules/keys/hooks/use-update-key";
import { useRevokeKey } from "@/modules/keys/hooks/use-revoke-key";
import { useDeleteKey } from "@/modules/keys/hooks/use-delete-key";
import type { CreateKeyOutput, KeyResponse } from "@/modules/keys/types";
import { formatDateTime } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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

// ============= Zod 表单 Schema（与后端 keys/types.ts 输入一致） =============

const createFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Max 100 characters"),
  qpsLimit: z.coerce.number().int("Must be a whole number").min(1).max(100000),
  cacheEnabled: z.boolean(),
  cacheTtl: z.coerce.number().int("Must be a whole number").min(1).max(86400),
});

const updateFormSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100, "Max 100 characters").optional(),
    qpsLimit: z.coerce.number().int("Must be a whole number").min(1).max(100000).optional(),
    cacheEnabled: z.boolean().optional(),
    cacheTtl: z.coerce.number().int("Must be a whole number").min(1).max(86400).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Change at least one field",
  });

function fieldError(
  errors: Partial<Record<string, string>>,
  path: string,
): string | undefined {
  return errors[path];
}

// ============= 子组件：创建 / 编辑对话框 =============

interface KeyFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 传入 key 则为编辑模式 */
  editing?: KeyResponse;
  onSubmitted: (result: CreateKeyOutput) => void;
}

function KeyFormDialog({ open, onOpenChange, editing, onSubmitted }: KeyFormDialogProps) {
  const createKey = useCreateKey();
  const updateKey = useUpdateKey();

  const [name, setName] = useState("");
  const [qpsLimit, setQpsLimit] = useState("60");
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheTtl, setCacheTtl] = useState("3600");
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  // 打开时同步初始值
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName(editing?.name ?? "");
      setQpsLimit(String(editing?.qpsLimit ?? 60));
      setCacheEnabled(editing?.cacheEnabled ?? false);
      setCacheTtl(String(editing?.cacheTtl ?? 3600));
      setErrors({});
    }
  }

  const isBusy = createKey.isPending || updateKey.isPending;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    if (editing) {
      const parsed = updateFormSchema.safeParse({
        name: name.length > 0 ? name : undefined,
        qpsLimit: qpsLimit.length > 0 ? qpsLimit : undefined,
        cacheEnabled,
        cacheTtl: cacheTtl.length > 0 ? cacheTtl : undefined,
      });
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        await updateKey.mutateAsync({ id: editing.id, ...parsed.data });
        onOpenChange(false);
      } catch {
        // 错误显示在对话框底部
      }
    } else {
      const parsed = createFormSchema.safeParse({ name, qpsLimit, cacheEnabled, cacheTtl });
      if (!parsed.success) {
        setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
        return;
      }
      try {
        const result = await createKey.mutateAsync(parsed.data);
        onOpenChange(false);
        onSubmitted(result);
      } catch {
        // 错误显示在对话框底部
      }
    }
  };

  const mutationError = createKey.error?.message ?? updateKey.error?.message;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit key — ${editing.name}` : "Create API key"}
      description={
        editing
          ? "Changes apply to new requests immediately."
          : "The secret will be shown only once after creation."
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {mutationError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {mutationError}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            placeholder="production-service"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={fieldError(errors, "name") !== undefined}
          />
          {fieldError(errors, "name") ? (
            <p className="text-xs text-destructive">{fieldError(errors, "name")}</p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="key-qps">QPS limit</Label>
            <Input
              id="key-qps"
              type="number"
              min={1}
              max={100000}
              value={qpsLimit}
              onChange={(e) => setQpsLimit(e.target.value)}
              aria-invalid={fieldError(errors, "qpsLimit") !== undefined}
            />
            {fieldError(errors, "qpsLimit") ? (
              <p className="text-xs text-destructive">{fieldError(errors, "qpsLimit")}</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-ttl">Cache TTL (s)</Label>
            <Input
              id="key-ttl"
              type="number"
              min={1}
              max={86400}
              disabled={!cacheEnabled}
              value={cacheTtl}
              onChange={(e) => setCacheTtl(e.target.value)}
              aria-invalid={fieldError(errors, "cacheTtl") !== undefined}
            />
            {fieldError(errors, "cacheTtl") ? (
              <p className="text-xs text-destructive">{fieldError(errors, "cacheTtl")}</p>
            ) : null}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={cacheEnabled}
            onChange={(e) => setCacheEnabled(e.target.checked)}
          />
          Enable response caching
        </label>
        {fieldError(errors, "root") ? (
          <p className="text-xs text-destructive">{fieldError(errors, "root")}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button type="submit" disabled={isBusy}>
            {isBusy ? "Saving…" : editing ? "Save changes" : "Create key"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ============= 子组件：确认对话框（吊销 / 删除） =============

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ============= 子组件：明文一次性展示 =============

interface PlaintextDialogProps {
  result: CreateKeyOutput | null;
  onClose: () => void;
}

function PlaintextDialog({ result, onClose }: PlaintextDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!result) {
      return;
    }
    try {
      await navigator.clipboard.writeText(result.plaintext);
      setCopied(true);
    } catch {
      // 剪贴板不可用时静默失败
    }
  };

  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title="Key created"
      description="Copy the secret now — it will not be shown again."
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-md border bg-muted/50 p-3">
            <code className="block break-all font-mono text-sm">{result.plaintext}</code>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleCopy}>
              <Copy aria-hidden="true" />
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Store it in a safe place. If lost, revoke this key and create a new one.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}

// ============= 页面 =============

export default function KeysPage() {
  const keysQuery = useKeys();
  const revokeKey = useRevokeKey();
  const deleteKey = useDeleteKey();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<KeyResponse | null>(null);
  const [created, setCreated] = useState<CreateKeyOutput | null>(null);
  const [revoking, setRevoking] = useState<KeyResponse | null>(null);
  const [deleting, setDeleting] = useState<KeyResponse | null>(null);

  const items = keysQuery.data?.items ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="API keys"
        description="Create and manage gateway keys for your account"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" />
            Create key
          </Button>
        }
      />

      {keysQuery.isLoading ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : keysQuery.isError ? (
        <ErrorState message={keysQuery.error.message} onRetry={() => keysQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No keys yet"
          description="Create your first API key to start making requests."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>QPS</TableHead>
                <TableHead>Cache</TableHead>
                <TableHead className="hidden md:table-cell">Created</TableHead>
                <TableHead className="sticky right-0 bg-card text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-muted-foreground">{key.prefix}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={key.status === "active" ? "success" : "destructive"}>
                      {key.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{key.qpsLimit}</TableCell>
                  <TableCell>
                    {key.cacheEnabled ? `${key.cacheTtl}s` : "Off"}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatDateTime(key.createdAt)}</TableCell>
                  <TableCell className="sticky right-0 bg-card">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(key)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={key.status === "revoked"}
                        onClick={() => setRevoking(key)}
                      >
                        Revoke
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleting(key)}
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

      <KeyFormDialog
        open={createOpen || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditing(null);
          }
        }}
        editing={editing ?? undefined}
        onSubmitted={setCreated}
      />

      <PlaintextDialog result={created} onClose={() => setCreated(null)} />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
          }
        }}
        title="Revoke key"
        description={
          <>
            Revoke <strong>{revoking?.name}</strong> ({revoking?.prefix})? Existing requests
            with this key will be rejected. This cannot be undone.
          </>
        }
        confirmLabel="Revoke"
        destructive
        busy={revokeKey.isPending}
        onConfirm={() => {
          if (revoking) {
            revokeKey.mutate(revoking.id, {
              onSuccess: () => setRevoking(null),
            });
          }
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        title="Delete key"
        description={
          <>
            Permanently delete <strong>{deleting?.name}</strong> ({deleting?.prefix})? Usage
            history is retained.
          </>
        }
        confirmLabel="Delete"
        destructive
        busy={deleteKey.isPending}
        onConfirm={() => {
          if (deleting) {
            deleteKey.mutate(deleting.id, {
              onSuccess: () => setDeleting(null),
            });
          }
        }}
      />
    </PageContainer>
  );
}
