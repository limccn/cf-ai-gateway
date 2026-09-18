// /keys — 密钥管理（M6 6.3）：CRUD 表格；创建时明文仅展示一次；
// 更新（名称/限流/缓存）、吊销、删除均带确认。
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Ban, Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { z } from "zod";
import { useKeys } from "@/modules/keys/hooks/use-keys";
import { useCreateKey } from "@/modules/keys/hooks/use-create-key";
import { useUpdateKey } from "@/modules/keys/hooks/use-update-key";
import { useRevokeKey } from "@/modules/keys/hooks/use-revoke-key";
import { useDeleteKey } from "@/modules/keys/hooks/use-delete-key";
import type { CreateKeyOutput, KeyResponse } from "@/modules/keys/types";
import { formatDateTime } from "@/lib/format";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [copyError, setCopyError] = useState<string | null>(null);

  // result 变化（新 key 创建）时重置复制状态：上一个 key 的 "Copied" 残留会误导当前展示
  useEffect(() => {
    setCopied(false);
    setCopyError(null);
  }, [result]);

  const handleCopy = async () => {
    if (!result) {
      return;
    }
    // 与 QuickStart 同款降级（Clipboard API → execCommand）；失败给出用户可见反馈而非静默
    const ok = await copyToClipboard(result.plaintext);
    if (ok) {
      setCopied(true);
      setCopyError(null);
    } else {
      setCopyError("Copy failed — clipboard is unavailable. Select the secret manually.");
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
          {copyError ? (
            <p role="alert" className="text-xs text-destructive">
              {copyError}
            </p>
          ) : null}
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

// ============= Quick start =============

/** 一种入站协议的「开始方式」。
 * **三者的 base URL 并不相同**，这正是本卡片要传达的关键差异：OpenAI 两条挂 `/v1`，
 * Anthropic 挂 `/anthropic` —— 官方 Anthropic SDK 会自己把 `/v1/messages` 接到 baseURL 后面，
 * 所以它的 baseURL 只到 `/anthropic`。与 README「SDK baseURL conventions」一节同源。 */
interface ProtocolGuide {
  /** 分段控件上的标签 */
  label: string;
  /** base URL 路径后缀（与当前 origin 拼接） */
  basePath: string;
  /** 主端点（相对 base URL），作为示例的说明文字 */
  endpoint: string;
  /** curl 开始方式；入参为该协议的完整 base URL */
  curl: (base: string) => string;
  /** 官方 SDK 开始方式；入参为该协议的完整 base URL */
  sdk: (base: string) => string;
  /** 该协议最易踩的一点（README 已记载的行为差异） */
  note: string;
}

/** 首项单独具名：`noUncheckedIndexedAccess` 下 `PROTOCOL_GUIDES[0]` 也是可空的，
 * 具名后可作为索引兜底的值。 */
const CHAT_COMPLETIONS_GUIDE: ProtocolGuide = {
  label: "Chat Completions",
  basePath: "/v1",
  endpoint: "POST /chat/completions",
  curl: (base) => `curl ${base}/chat/completions \\
  -H "Authorization: Bearer sk-xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "gpt-5.6-sol", "messages": [{"role": "user", "content": "Hello"}]}'`,
  sdk: (base) => `const openai = new OpenAI({ apiKey: "sk-xxxxxxxx", baseURL: "${base}" });
await openai.chat.completions.create({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "Hello" }] });`,
  note: 'Set "stream": true for SSE; the stream ends with data: [DONE].',
};

const PROTOCOL_GUIDES: ProtocolGuide[] = [
  CHAT_COMPLETIONS_GUIDE,
  {
    label: "Responses",
    basePath: "/v1",
    endpoint: "POST /responses",
    curl: (base) => `curl ${base}/responses \\
  -H "Authorization: Bearer sk-xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "gpt-5.6-sol", "input": "Hello"}'`,
    sdk: (base) => `const openai = new OpenAI({ apiKey: "sk-xxxxxxxx", baseURL: "${base}" });
await openai.responses.create({ model: "gpt-5.6-sol", input: "Hello" });`,
    note: 'input takes a plain string or an array of input items; "stream": true returns SSE with no [DONE] terminator.',
  },
  {
    label: "Anthropic Messages",
    basePath: "/anthropic",
    endpoint: "POST /v1/messages",
    curl: (base) => `curl ${base}/v1/messages \\
  -H "x-api-key: sk-xxxxxxxx" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "claude-sonnet-5", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'`,
    sdk: (base) => `const anthropic = new Anthropic({ apiKey: "sk-xxxxxxxx", baseURL: "${base}" });
await anthropic.messages.create({ model: "claude-sonnet-5", max_tokens: 1024, messages: [{ role: "user", content: "Hello" }] });`,
    note: "max_tokens is required by the Messages API; the SDK sends x-api-key and anthropic-version for you.",
  },
];

/** 等宽代码块 + Copy 按钮。每个实例自持复制态：切换协议时面板整体卸载重建，
 * 「Copied」不会跨协议残留。 */
interface CopyBlockProps {
  /** 小节标题。与 Copy **同排**，代码块因此能独占整行宽度 ——
   * 若把 Copy 放在代码块旁边，窄屏下会被挤到只剩 ~180px，curl 截成 `-H "Authorizati` 不可读。 */
  label: ReactNode;
  value: string;
  /** 剪贴板不可用时的提示语（须说清下一步怎么办） */
  errorHint: string;
  /** 多行示例用 pre + 横向滚动；单行 base URL 用 code + 强制折行 */
  multiline?: boolean;
}

function CopyBlock({ label, value, errorHint, multiline = false }: CopyBlockProps) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<number | null>(null);

  // 卸载时清掉复位定时器，避免离开页面后仍触发 setState
  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const handleCopy = async () => {
    // 与 PlaintextDialog 同款降级（Clipboard API → execCommand）；失败给出可见反馈而非静默
    const ok = await copyToClipboard(value);
    if (!ok) {
      setError(errorHint);
      return;
    }
    setError(null);
    setCopied(true);
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="text-sm font-medium leading-none">{label}</p>
        <Button variant="outline" size="sm" onClick={handleCopy}>
          <Copy aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="rounded-md border bg-muted/50 p-3">
        {multiline ? (
          <pre className="overflow-x-auto font-mono text-xs leading-relaxed">{value}</pre>
        ) : (
          <code className="block break-all font-mono text-sm">{value}</code>
        )}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** 接入说明：三种协议各自的 base URL + curl / 官方 SDK 开始方式，用分段控件切换。
 * 默认停在最常用的 Chat Completions。 */
function QuickStart() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const [activeIndex, setActiveIndex] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const guide = PROTOCOL_GUIDES[activeIndex] ?? CHAT_COMPLETIONS_GUIDE;
  const baseUrl = `${origin}${guide.basePath}`;

  /** ARIA tabs 键盘约定：左右方向键循环、Home/End 跳首尾。必须与下面的 roving tabIndex
   * 配套 —— 只加 role="tab" 而不实现方向键，屏幕阅读器会报「标签页」但按键无反应。 */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = PROTOCOL_GUIDES.length - 1;
    let next: number;
    if (event.key === "ArrowRight") {
      next = index === last ? 0 : index + 1;
    } else if (event.key === "ArrowLeft") {
      next = index === 0 ? last : index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    } else {
      return;
    }
    event.preventDefault();
    setActiveIndex(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Quick start</CardTitle>
        <CardDescription>
          Point an OpenAI- or Anthropic-compatible client at the gateway with a key from the list
          above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          role="tablist"
          aria-label="Protocol"
          className="flex flex-wrap gap-1 rounded-md border p-1"
        >
          {PROTOCOL_GUIDES.map((item, index) => (
            <button
              key={item.label}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`quickstart-tab-${index}`}
              aria-selected={index === activeIndex}
              aria-controls="quickstart-panel"
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={cn(
                // 窄屏三块放不下同一行（400px 下内容盒仅 ~239px，三个标签合计 ~399px），必然换行。
                // max-sm:flex-auto 让换行后的每块各自撑满本行 —— 等宽的竖列，而不是参差的散按钮。
                // 不能用 flex-1：它把 basis 设为 0，三块反而会挤进同一行再等分，文字被压爆。
                "rounded px-3 py-1.5 text-sm font-medium transition-colors max-sm:flex-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                index === activeIndex
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id="quickstart-panel"
          aria-labelledby={`quickstart-tab-${activeIndex}`}
          className="space-y-4"
        >
          <CopyBlock
            label="Base URL"
            value={baseUrl}
            errorHint="Copy failed — clipboard is unavailable. Select the URL manually."
          />

          <CopyBlock
            label={
              <>
                Example request{" "}
                <span className="font-normal text-muted-foreground">{guide.endpoint}</span>
              </>
            }
            value={guide.curl(baseUrl)}
            multiline
            errorHint="Copy failed — clipboard is unavailable. Select the command manually."
          />

          <CopyBlock
            label="Official SDK"
            value={guide.sdk(baseUrl)}
            multiline
            errorHint="Copy failed — clipboard is unavailable. Select the snippet manually."
          />

          <p className="text-xs text-muted-foreground">{guide.note}</p>
          <p className="text-xs text-muted-foreground">
            Replace <code className="font-mono">sk-xxxxxxxx</code> with a key — the full secret is
            shown only once, right after you create it. Model names above are examples;{" "}
            <code className="font-mono">GET /v1/models</code> lists the ones a key can route.
          </p>
        </div>
      </CardContent>
    </Card>
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

  // 前端内存过滤（列表量小；API 无 search 参数）
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const filtered = query
    ? items.filter(
        (k) => k.name.toLowerCase().includes(query) || k.prefix.toLowerCase().includes(query),
      )
    : items;

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

      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>API keys</CardTitle>
          </div>
          {items.length > 0 ? (
            <div className="relative w-40 shrink-0">
              <Search
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="Search keys"
                className="pl-9"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {keysQuery.isLoading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : keysQuery.isError ? (
            <div className="p-6">
              <ErrorState message={keysQuery.error.message} onRetry={() => keysQuery.refetch()} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title={items.length === 0 ? "No keys yet" : "No keys match"}
                description={
                  items.length === 0 ? "Create your first API key to start making requests." : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">QPS</TableHead>
                  <TableHead className="hidden sm:table-cell">Cache</TableHead>
                  <TableHead className="hidden md:table-cell">Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((key) => (
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
                    <TableCell className="hidden sm:table-cell">{key.qpsLimit}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {key.cacheEnabled ? `${key.cacheTtl}s` : "Off"}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {formatDateTime(key.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditing(key)}
                          aria-label={`Edit ${key.name}`}
                          title="Edit"
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={key.status === "revoked"}
                          onClick={() => setRevoking(key)}
                          aria-label={`Revoke ${key.name}`}
                          title="Revoke"
                        >
                          <Ban aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleting(key)}
                          aria-label={`Delete ${key.name}`}
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

      <QuickStart />

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
