// Profile 弹窗（09-16-account-menu，design §4.2）：自助查看账号资料 + 改 name。
//
// 09-17-password-menu-and-dialog-overflow：**改密区块已迁出**（原内嵌于本弹窗底部），
// 现在是账户菜单里的并列项 + 独立弹窗 —— 见 user-button.tsx 的 ChangePasswordMenuItem
// 与 change-password-dialog.tsx。本弹窗因此显著变矮，矮视口下不再咬着视口两头
// （642px 是改动前在 600px 视口下的实测值；改动后高度见本任务 verification.md）。
//
// 数据源：useProfile()（GET /api/me/profile）—— 一次请求拿到 name/email/emailVerified/验证开关，
// 且是服务端最新值（session 可能因 staleTime 滞后，且 SessionUser 不含 emailVerified）。
//
// name 写入复用 Better Auth 内置 POST /api/auth/update-user（authClient.updateUser）：
//   - 库内部硬拦 email 改动（R5/AC6 是结构性保证，非本组件校验）；
//   - 更新后回写 session cookie → 客户端 session store 自动刷新 → 菜单头部与页面立即显示新值
//     （R8/AC7，无需手动刷新）；
//   - **只发 name**：additionalFields 里的 inviteCode 是 input:true，混发会被 parseUserInput
//     当作可写字段（design §2.2 注意项）。
//
// 邮箱不可改：输入框 readOnly + 旁注（AC5），界面上无任何编辑途径。
// 查询未就绪 / 失败时不渲染可提交表单 —— 避免用空 name 覆盖服务端数据（design §6）。
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProfile } from "@/modules/profile/hooks/use-profile";
import type { Profile } from "@/modules/profile/types";

export interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfileDialog({ open, onOpenChange }: ProfileDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Profile"
      description="Your account details."
    >
      {/* 只在打开时挂载内容：关闭态不发起 /api/me/profile 请求，重开即拿最新数据 */}
      {open ? <ProfileContent onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function ProfileContent({ onClose }: { onClose: () => void }) {
  const { data, isPending, isError, refetch } = useProfile();

  if (isPending) {
    return (
      <p className="text-sm text-muted-foreground" aria-busy="true" aria-live="polite">
        Loading your profile…
      </p>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-3">
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Failed to load your profile. Please try again.
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  // 数据就绪后一次性挂载表单：state 初值即服务端最新值（无需 useEffect 回填）
  return <ProfileForm profile={data.profile} onClose={onClose} />;
}

function ProfileForm({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(profile.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "pending" | "requested">("idle");
  const [resendError, setResendError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      // AC8：前端拦截，不发送请求
      setNameError("Name cannot be empty");
      return;
    }
    setNameError(null);
    setIsSaving(true);
    try {
      const { error } = await authClient.updateUser({ name: trimmed });
      if (error) {
        setFormError(error.message ?? "Failed to update your name");
        return;
      }
      // session store 已由 better-auth 客户端在 /update-user 后刷新（菜单头部即时更新）；
      // 这里只负责让本弹窗下次打开时拿到新的 profile 快照
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      onClose();
    } catch {
      setFormError("Failed to update your name");
    } finally {
      setIsSaving(false);
    }
  };

  const handleResend = async () => {
    setResendError(null);
    setResendStatus("pending");
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: profile.email,
        callbackURL: "/dashboard",
      });
      if (error) {
        setResendStatus("idle");
        setResendError(error.message ?? "Failed to request a verification email");
        return;
      }
      setResendStatus("requested");
    } catch {
      setResendStatus("idle");
      setResendError("Failed to request a verification email");
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        {formError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {formError}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="profile-name">Name</Label>
          <div className="flex items-center gap-2">
            <Input
              id="profile-name"
              autoComplete="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              aria-invalid={nameError !== null}
              aria-describedby={nameError !== null ? "profile-name-error" : undefined}
            />
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
          {nameError !== null ? (
            <p id="profile-name-error" className="text-xs text-destructive">
              {nameError}
            </p>
          ) : null}
        </div>
      </form>

      <div className="space-y-2">
        <Label htmlFor="profile-email">Email</Label>
        <Input
          id="profile-email"
          value={profile.email}
          readOnly
          className="bg-muted text-muted-foreground"
          aria-describedby="profile-email-note"
        />
        <p id="profile-email-note" className="text-xs text-muted-foreground">
          Email cannot be changed.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium leading-none">Email verification</p>
        <div className="flex flex-wrap items-center gap-2">
          {profile.emailVerified ? (
            <Badge variant="success">Verified</Badge>
          ) : (
            <Badge variant="muted">Not verified</Badge>
          )}
          {/* R6/R7/AC9：只有「未验证 + 开关开启」才出现操作入口；开关关闭时仅静默展示状态 */}
          {!profile.emailVerified && profile.emailVerificationEnabled ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleResend()}
              disabled={resendStatus === "pending"}
            >
              {resendStatus === "pending" ? "Requesting…" : "Resend verification email"}
            </Button>
          ) : null}
        </div>
        {resendError !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {resendError}
          </p>
        ) : null}
        {resendStatus === "requested" ? (
          // 文案诚实性（design §2.3）：本轮 sendVerificationEmail 是占位、不发真实邮件，
          // 不得声称「已发送到你的邮箱」。接入真实邮件通道后必须同步改写此文案。
          <p role="status" className="text-xs text-muted-foreground">
            Verification email requested. Note: email delivery is not enabled on this gateway
            yet, so nothing has been sent to your inbox.
          </p>
        ) : null}
      </div>
    </div>
  );
}
