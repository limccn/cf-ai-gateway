// /users — 用户管理（M6 6.3，admin）：列表搜索/过滤、角色与状态操作、邀请码管理。
import { useEffect, useState, type FormEvent } from "react";
import {
  Copy,
  Search,
  ShieldMinus,
  ShieldPlus,
  Trash2,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { z } from "zod";
import { useSession } from "@/hooks/use-session";
import { useUsers } from "@/modules/users/hooks/use-users";
import { useUpdateUser } from "@/modules/users/hooks/use-update-user";
import { useDeleteUser } from "@/modules/users/hooks/use-delete-user";
import { useInvites } from "@/modules/users/hooks/use-invites";
import { useCreateInvite } from "@/modules/users/hooks/use-create-invite";
import type { UserResponse } from "@/modules/users/types";
import { formatDateTime, formatUsd } from "@/lib/format";
import { copyToClipboard } from "@/lib/clipboard";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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

const inviteFormSchema = z.object({
  expiresInDays: z.coerce.number().int().min(1, "At least 1 day").max(90, "At most 90 days"),
});

/** Invite codes 客户端分页：每页 6 条（grid 3 列 × 2 行，移动端 1 列 × 6 行）。 */
const INVITE_PAGE_SIZE = 6;

export default function UsersPage() {
  const { user: sessionUser } = useSession();

  // ===== 列表筛选 =====
  const [searchDraft, setSearchDraft] = useState("");
  const [roleDraft, setRoleDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [filters, setFilters] = useState<{ search?: string; role?: "admin" | "member"; status?: "active" | "disabled" }>({});

  // 用户列表分页：limit=50（后端上限），超过 50 人时更多用户不可达 → 加分页
  const [offset, setOffset] = useState(0);
  const usersQuery = useUsers({ ...filters, limit: 50, offset });
  const invitesQuery = useInvites();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const createInvite = useCreateInvite();

  const totalUsers = usersQuery.data?.total ?? 0;
  const [updateErrorDismissed, setUpdateErrorDismissed] = useState(false);
  // 新错误出现时重置 dismiss 状态；操作成功或用户手动关闭后不显示
  useEffect(() => setUpdateErrorDismissed(false), [updateUser.error]);

  const [deleteErrorDismissed, setDeleteErrorDismissed] = useState(false);
  // 删除错误条独立 dismiss（与 updateUser.error 错误条互不影响）
  useEffect(() => setDeleteErrorDismissed(false), [deleteUser.error]);

  // ===== 邀请码创建 =====
  const [inviteOpen, setInviteOpen] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteFieldError, setInviteFieldError] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  /** 最近一次成功复制的邀请码（按卡片显示 "Copied"，2s 复位）。 */
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // ===== Invite codes 客户端分页状态（slice 逻辑见 invites 派生区） =====
  const [invitePage, setInvitePage] = useState(0);

  // ===== 用户删除（admin） =====
  const [deleteTarget, setDeleteTarget] = useState<UserResponse | null>(null);

  const applyFilters = () => {
    setFilters({
      search: searchDraft || undefined,
      role: roleDraft === "" ? undefined : (roleDraft as "admin" | "member"),
      status: statusDraft === "" ? undefined : (statusDraft as "active" | "disabled"),
    });
    setOffset(0);
  };

  const items = usersQuery.data?.items ?? [];
  const invites = invitesQuery.data?.items ?? [];

  // ===== Invite codes 客户端分页（后端上限 100 条，切片在客户端完成） =====
  const maxInvitePage = Math.max(0, Math.ceil(invites.length / INVITE_PAGE_SIZE) - 1);
  const safeInvitePage = Math.min(invitePage, maxInvitePage); // 总数变少时钳制
  const pageInvites = invites.slice(
    safeInvitePage * INVITE_PAGE_SIZE,
    safeInvitePage * INVITE_PAGE_SIZE + INVITE_PAGE_SIZE,
  );

  // 删除确认弹窗 busy：按目标 id 判定，防串行时全行禁转
  const isDeletePending = deleteUser.isPending && deleteUser.variables === deleteTarget?.id;

  const handleCreateInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteError(null);
    setInviteFieldError(null);
    setCreatedCode(null);
    const parsed = inviteFormSchema.safeParse({ expiresInDays });
    if (!parsed.success) {
      setInviteFieldError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    try {
      const result = await createInvite.mutateAsync(parsed.data);
      setCreatedCode(result.invite.code);
      setInviteOpen(false);
      setInvitePage(0); // 新邀请码置顶，跳回第 1 页
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "Failed to create invite");
    }
  };

  /** 确认删除：成功关弹窗；失败保留弹窗展示错误条（deleteErrorDismissed 控制）。 */
  const handleConfirmDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    try {
      await deleteUser.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      // 错误经 deleteUser.error 在弹窗内展示
    }
  };

  /** 打开删除确认弹窗：先清掉上一次的 mutation 状态，避免旧错误串到新目标。 */
  const openDeleteConfirm = (target: UserResponse) => {
    deleteUser.reset();
    setDeleteErrorDismissed(false);
    setDeleteTarget(target);
  };

  const handleCopy = async (code: string) => {
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopiedCode(code);
      setCopyError(null);
      setTimeout(() => {
        setCopiedCode((current) => (current === code ? null : current));
      }, 2000);
    } else {
      setCopyError("Copy failed — clipboard is unavailable. Select the code manually.");
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Users"
        description="Manage accounts, roles and invite codes (admin)"
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <ShieldPlus aria-hidden="true" />
            Create invite
          </Button>
        }
      />

      {/* 邀请码区 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Invite codes</CardTitle>
          <CardDescription>One-time codes required for email sign-up</CardDescription>
        </CardHeader>
        <CardContent>
          {invitesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading invites…</p>
          ) : invitesQuery.isError ? (
            <ErrorState message={invitesQuery.error.message} onRetry={() => invitesQuery.refetch()} />
          ) : invites.length === 0 ? (
            <EmptyState title="No invite codes" description="Create one to let new members register." />
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {pageInvites.map((invite) => (
                  <div
                    key={invite.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <code className="block truncate font-mono text-sm">{invite.code}</code>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <Badge variant={invite.status === "active" ? "success" : "muted"}>{invite.status}</Badge>{" "}
                        expires {formatDateTime(invite.expiresAt)}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => handleCopy(invite.code)} disabled={invite.status !== "active"}>
                      <Copy aria-hidden="true" />
                      {copiedCode === invite.code ? "Copied" : "Copy"}
                    </Button>
                  </div>
                ))}
              </div>
              {invites.length > INVITE_PAGE_SIZE ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    Showing {safeInvitePage * INVITE_PAGE_SIZE + 1}–
                    {safeInvitePage * INVITE_PAGE_SIZE + pageInvites.length} of {invites.length}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeInvitePage === 0}
                      onClick={() => setInvitePage(safeInvitePage - 1)}
                    >
                      Prev
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeInvitePage >= maxInvitePage}
                      onClick={() => setInvitePage(safeInvitePage + 1)}
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

      {copyError ? (
        <p role="alert" className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {copyError}
        </p>
      ) : null}

      {updateUser.error && !updateErrorDismissed ? (
        <p
          role="alert"
          className="mb-6 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{updateUser.error.message}</span>
          <Button variant="ghost" size="sm" onClick={() => setUpdateErrorDismissed(true)}>
            Dismiss
          </Button>
        </p>
      ) : null}

      {deleteUser.error && !deleteErrorDismissed ? (
        <p
          role="alert"
          className="mb-6 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{deleteUser.error.message}</span>
          <Button variant="ghost" size="sm" onClick={() => setDeleteErrorDismissed(true)}>
            Dismiss
          </Button>
        </p>
      ) : null}

      {/* 用户列表 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>User list</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="user-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="user-search"
                  className="pl-9"
                  placeholder="Name or email"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-role">Role</Label>
              <Select id="user-role" value={roleDraft} onChange={(e) => setRoleDraft(e.target.value)}>
                <option value="">All roles</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-status">Status</Label>
              <Select id="user-status" value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)}>
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={applyFilters}>Apply</Button>
          </div>

          {usersQuery.isLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading users…</p>
          ) : usersQuery.isError ? (
            <div className="mt-4">
              <ErrorState message={usersQuery.error.message} onRetry={() => usersQuery.refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No users match" />
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead className="hidden md:table-cell">Joined</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const isSelf = sessionUser?.id === item.id;
                    const isBusy = updateUser.isPending && updateUser.variables?.id === item.id;
                    const isDeleteBusy = deleteUser.isPending && deleteUser.variables === item.id;
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <p className="font-medium">{item.name}</p>
                          <p className="text-xs text-muted-foreground">{item.email}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.role === "admin" ? "default" : "outline"}>{item.role}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.status === "active" ? "success" : "destructive"}>
                            {item.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatUsd(item.balance)}</TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {formatDateTime(item.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isBusy || isSelf}
                              onClick={() =>
                                updateUser.mutate({
                                  id: item.id,
                                  role: item.role === "admin" ? "member" : "admin",
                                })
                              }
                              aria-label={
                                isSelf
                                  ? "You cannot change your own role"
                                  : item.role === "admin"
                                    ? `Demote ${item.name} to member`
                                    : `Promote ${item.name} to admin`
                              }
                              title={isSelf ? "You cannot change your own role" : item.role === "admin" ? "Demote to member" : "Promote to admin"}
                            >
                              {item.role === "admin" ? (
                                <ShieldMinus aria-hidden="true" />
                              ) : (
                                <ShieldPlus aria-hidden="true" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isBusy || isSelf}
                              className="text-destructive hover:text-destructive"
                              onClick={() =>
                                updateUser.mutate({
                                  id: item.id,
                                  status: item.status === "active" ? "disabled" : "active",
                                })
                              }
                              aria-label={
                                item.status === "active"
                                  ? `Disable ${item.name}`
                                  : `Enable ${item.name}`
                              }
                              title={isSelf ? "You cannot disable your own account" : item.status === "active" ? "Disable account" : "Enable account"}
                            >
                              {item.status === "active" ? (
                                <UserRoundX aria-hidden="true" />
                              ) : (
                                <UserRoundCheck aria-hidden="true" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isSelf || item.role === "admin" || isDeleteBusy}
                              className="text-destructive hover:text-destructive"
                              onClick={() => openDeleteConfirm(item)}
                              aria-label={
                                isSelf
                                  ? "You cannot delete your own account"
                                  : item.role === "admin"
                                    ? "Admins cannot be deleted"
                                    : `Delete ${item.name}`
                              }
                              title={
                                isSelf
                                  ? "You cannot delete your own account"
                                  : item.role === "admin"
                                    ? "Admins cannot be deleted — demote first"
                                    : "Delete user"
                              }
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {items.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                Showing {offset + 1}–{offset + items.length} of {totalUsers}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + 50 >= totalUsers}
                  onClick={() => setOffset(offset + 50)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 创建邀请码对话框 */}
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          setInviteError(null);
          setInviteFieldError(null);
        }}
        title="Create invite code"
        description="New members need this code to register with email."
      >
        <form onSubmit={handleCreateInvite} className="space-y-4" noValidate>
          {inviteError ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {inviteError}
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="invite-days">Expires in (days)</Label>
            <Input
              id="invite-days"
              type="number"
              min={1}
              max={90}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              aria-invalid={inviteFieldError !== null}
            />
            {inviteFieldError ? <p className="text-xs text-destructive">{inviteFieldError}</p> : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={createInvite.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={createInvite.isPending}>
              {createInvite.isPending ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* 创建成功展示 */}
      <Dialog
        open={createdCode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedCode(null);
          }
        }}
        title="Invite code created"
        description="Share this code with the new member."
      >
        {createdCode ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/50 p-3">
              <code className="block break-all font-mono text-sm">{createdCode}</code>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => handleCopy(createdCode)}>
                <Copy aria-hidden="true" />
                {copiedCode === createdCode ? "Copied" : "Copy"}
              </Button>
              <Button onClick={() => setCreatedCode(null)}>Done</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* 确认删除用户（admin，member only；成功后关闭，失败保留弹窗 + 顶部错误条） */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        title="Delete user"
        description="This action cannot be undone."
      >
        {deleteTarget ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/50 p-3">
              <p className="text-sm font-medium">{deleteTarget.name}</p>
              <p className="text-xs text-muted-foreground">{deleteTarget.email}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Balance {formatUsd(deleteTarget.balance)} will be permanently deleted along with all
              API keys and usage history.
            </p>
            {deleteUser.error && !isDeletePending ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {deleteUser.error.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeletePending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeletePending}>
                {isDeletePending ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </PageContainer>
  );
}
