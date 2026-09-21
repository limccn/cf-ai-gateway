// /providers — 上游 Provider 管理（M6 6.3，admin）：
// CRUD 表格；models 映射以 textarea 行格式 `内部名=上游名` 编辑。
//
// 批次 N（2026-09-21）把这一页的弹窗从「一个大 Edit」拆成「三个各管一段」：
//   Pencil            → Edit basics（name/type/baseUrl/apiKey/models）
//   SlidersHorizontal → Edit advanced（httpOptions/weight/thinkingMode/reasoningRoundtrip/timeout）
//   Zap               → Test connection（三条协议直连探测，见 components/provider-test-dialog.tsx）
//   Add provider      → **不拆**（裁决 D13）：新建只有一个入口，不存在「只想改一个字段」的场景。
// 表单规则与文本互转已移入 modules/providers/form.ts（三处入口共用一份，避免漂移）。
import { useState } from "react";
import { Pencil, Plus, Search, SlidersHorizontal, Trash2, Zap } from "lucide-react";
import { useProviders } from "@/modules/providers/hooks/use-providers";
import { useUpdateProvider } from "@/modules/providers/hooks/use-update-provider";
import { useDeleteProvider } from "@/modules/providers/hooks/use-delete-provider";
import { hasHttpOptions } from "@/modules/providers/form";
import type { ProviderResponse } from "@/modules/providers/types";
import { ProviderCreateDialog } from "@/modules/providers/components/provider-create-dialog";
import { ProviderBasicsDialog } from "@/modules/providers/components/provider-basics-dialog";
import { ProviderAdvancedDialog } from "@/modules/providers/components/provider-advanced-dialog";
import { ProviderTestDialog } from "@/modules/providers/components/provider-test-dialog";
import { formatDateTime, formatNumber } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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

/**
 * 当前打开的弹窗。**判别联合而非若干布尔**：后者能表达「basics 和 advanced 同时打开」，
 * 而那会让两个弹窗的字段一起写库、并且 DOM 里出现两个 `id="dialog-title"`
 * （Dialog 原语的 aria-labelledby 指向固定 id）。联合类型让这种状态根本无法构造。
 */
type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "basics"; provider: ProviderResponse }
  | { kind: "advanced"; provider: ProviderResponse }
  | { kind: "test"; provider: ProviderResponse }
  | { kind: "delete"; provider: ProviderResponse };

/** 每页条数（批次 L，2026-09-21 用户裁决「下方列表做好分页，每页显示 20 条」）。 */
const PAGE_SIZE = 20;

export default function ProvidersPage() {
  const providersQuery = useProviders();
  const updateProvider = useUpdateProvider();
  const deleteProvider = useDeleteProvider();

  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const closeDialog = () => setDialog({ kind: "none" });
  // 关闭时才清（打开时不覆盖）—— 否则 Dialog 的 onOpenChange(false) 与已设的 provider 会打架
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      closeDialog();
    }
  };

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

  // 分页（批次 L，2026-09-21 用户裁决）：前端内存分页 —— useProviders 一次返回全部
  // （GET /api/providers 无 limit/offset 参数，返回体也不带 total），过滤同样是内存的，
  // 故页码与切片都跟着 filtered 走。clamp 而非回写 state：搜索后总数变少时越界页会被钳到末页，
  // 不回写就少一次渲染，也不会在输入过程中产生「先归零再跳末页」的抖动。
  const [page, setPage] = useState(0);
  const maxPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const safePage = Math.min(page, maxPage);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <PageContainer>
      <PageHeader
        title="Providers"
        description="Upstream AI providers and their model mappings (admin)"
        actions={
          <Button onClick={() => setDialog({ kind: "create" })}>
            <Plus aria-hidden="true" />
            Add provider
          </Button>
        }
      />

      <Card className="mb-6">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Providers</CardTitle>
            {/* 副标题（批次 L，2026-09-21 用户裁决）：原「Add and manage upstream providers」只是
                复述标题 + 卡片自带搜索框已表达的「可管理」，删掉，改显合计 `<N> total`
                （与 billing「Transactions」卡、keys/models 同款）。取 items.length 而非
                filtered.length：这是**本卡收藏总数**，不随搜索框内容跳动；搜索时的可见条数
                由页尾的 "Showing X–Y of Z" 负责。 */}
            <CardDescription>{formatNumber(items.length)} total</CardDescription>
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
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(0); // 换了结果集就回第 1 页，否则会停在旧结果的第 N 页上
                }}
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
            <>
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
                  {pageItems.map((provider) => (
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
                        {/* 五个控件一行：启用开关 + 三个弹窗入口 + 删除。
                            gap-1（而非原先的 gap-2）是给新增的两个图标按钮腾位 —— 表头列宽
                            在窄屏本就靠 Table 的 overflow-auto 兜底，但间距不收紧会让
                            Actions 列在 1440 档也明显撑宽。 */}
                        <div className="flex items-center justify-end gap-1">
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
                            onClick={() => setDialog({ kind: "basics", provider })}
                            aria-label={`Edit basics for ${provider.name}`}
                            title="Edit basics"
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDialog({ kind: "advanced", provider })}
                            aria-label={`Edit advanced options for ${provider.name}`}
                            // 拆窗后「这条 provider 有没有配高级项」不再靠 Collapsible 自动展开
                            // 来暴露（那个信号随 Collapsible 一起留在了不拆的 Add 弹窗里），
                            // 改由 title 提示 —— 不新增视觉语言，但信息不丢。
                            title={
                              hasHttpOptions(provider.httpOptions)
                                ? "Edit advanced options (HTTP options configured)"
                                : "Edit advanced options"
                            }
                          >
                            <SlidersHorizontal aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDialog({ kind: "test", provider })}
                            aria-label={`Test connection for ${provider.name}`}
                            title="Test connection"
                          >
                            <Zap aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDialog({ kind: "delete", provider })}
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
              {/* 分页条：与 users 的邀请码卡、billing 的流水表同一范式（Showing X–Y of Z + Prev/Next）。
                  仅当超过一页才渲染 —— 条数不足时挂一条恒「Showing 1–N of N」+ 两个禁用按钮是噪音。 */}
              {filtered.length > PAGE_SIZE ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-6 pb-6">
                  <span className="text-sm text-muted-foreground">
                    Showing {safePage * PAGE_SIZE + 1}–{safePage * PAGE_SIZE + pageItems.length} of{" "}
                    {filtered.length}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                    >
                      Prev
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage >= maxPage}
                      onClick={() => setPage(safePage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <ProviderCreateDialog open={dialog.kind === "create"} onOpenChange={handleOpenChange} />
      <ProviderBasicsDialog
        open={dialog.kind === "basics"}
        onOpenChange={handleOpenChange}
        provider={dialog.kind === "basics" ? dialog.provider : null}
      />
      <ProviderAdvancedDialog
        open={dialog.kind === "advanced"}
        onOpenChange={handleOpenChange}
        provider={dialog.kind === "advanced" ? dialog.provider : null}
      />
      <ProviderTestDialog
        open={dialog.kind === "test"}
        onOpenChange={handleOpenChange}
        provider={dialog.kind === "test" ? dialog.provider : null}
      />

      <Dialog
        open={dialog.kind === "delete"}
        onOpenChange={handleOpenChange}
        title="Delete provider"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Delete provider{" "}
            <strong>{dialog.kind === "delete" ? dialog.provider.name : ""}</strong>? Requests
            referencing its models will fail until the models are re-routed.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeDialog} disabled={deleteProvider.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProvider.isPending}
              onClick={() => {
                if (dialog.kind === "delete") {
                  deleteProvider.mutate(dialog.provider.id, { onSuccess: closeDialog });
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
