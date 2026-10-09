// 修改密码表单（09-17-change-password，design §4）。
//
// 只在 ChangePasswordDialog 内挂载（09-17 已从 Profile 弹窗搬出）；能走到这一步本身就意味着
// 服务端下发过 hasPassword === true（菜单项据此才可点击）。本组件**不自己判断**
// 「这个用户能不能改密码」—— 判据唯一来源是 GET /api/me/profile 的 hasPassword
// （design §3.2）：前端没有 accounts 表，任何本地推导都会与库漂移，而漂移的两个方向
// 代价不对称（见 get-profile.ts 文件头）。
//
// 写路径复用库端点 POST /api/auth/change-password，不自建（design §2.2 / D3）。
// revokeOtherSessions: true —— 改密码通常是安全动机（怀疑泄露），若攻击者会话仍存活
// 则改密码失去意义；当前设备由库换发 cookie，不被打扰（R4 / D2）。
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
// 直取零依赖的属主模块，不经 @/modules/profile/types：后者会与 import 了 zod 的
// src/routes/profile/types.ts 建立运行时边，把整份 schema 拖进首屏（见该文件内说明）。
import { MIN_PASSWORD_LENGTH } from "../../../src/lib/password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 文案插值常量而非字面量 8：常量一改文案先漂的话，「单一真源」就名存实亡（R5）。
const MIN_LENGTH_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

/**
 * 库错误码 → 可理解文案（design §4.2）。
 * 实测响应体形状为 `{ message, code }`（@better-fetch/fetch 把 body 原样并入 error 对象），
 * 故按 code 映射；未知码回落通用文案 —— 绝不把原始 code 或 message 直接展示给用户。
 */
function messageForCode(code: string | undefined): string {
  switch (code) {
    case "INVALID_PASSWORD":
      return "Your current password is incorrect";
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return "This account has no password to change";
    case "PASSWORD_TOO_SHORT":
      return MIN_LENGTH_MESSAGE;
    case "PASSWORD_TOO_LONG":
      return "Password is too long";
    default:
      return "Failed to change your password";
  }
}

interface FieldErrors {
  current: string | null;
  next: string | null;
  confirm: string | null;
}

const NO_FIELD_ERRORS: FieldErrors = { current: null, next: null, confirm: null };

export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSucceeded(false);

    // 前端拦截（R5）：**一次算全**、全部展示，不停在第一条 —— 用户一次纠正到位，
    // 而不是"改完一条再发现还有一条"。任一条不满足即 return，不发请求（AC3 以此取证）。
    const errors: FieldErrors = {
      current: current === "" ? "Enter your current password" : null,
      next: next.length < MIN_PASSWORD_LENGTH ? MIN_LENGTH_MESSAGE : null,
      // 确认框只比对，不重复长度规则：新密码为空时长度规则已先报，这里再报一次是噪音
      confirm: confirm !== next ? "Passwords do not match" : null,
    };
    setFieldErrors(errors);
    if (errors.current !== null || errors.next !== null || errors.confirm !== null) {
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (error) {
        setFormError(messageForCode(error.code));
        return;
      }
      // 成功：清空三字段 + 就地反馈（D6：不关弹窗 —— 「其他设备已登出」这个副作用
      // 需要被看见，而仓库无 toast 基建，关掉弹窗就无处告知）
      setCurrent("");
      setNext("");
      setConfirm("");
      setFieldErrors(NO_FIELD_ERRORS);
      setSucceeded(true);
    } catch {
      setFormError("Failed to change your password");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      {formError !== null ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="profile-current-password">Current password</Label>
        <Input
          id="profile-current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
          }}
          aria-invalid={fieldErrors.current !== null}
          aria-describedby={fieldErrors.current !== null ? "profile-current-password-error" : undefined}
        />
        {fieldErrors.current !== null ? (
          <p id="profile-current-password-error" className="text-xs text-destructive">
            {fieldErrors.current}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-new-password">New password</Label>
        <Input
          id="profile-new-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => {
            setNext(event.target.value);
          }}
          aria-invalid={fieldErrors.next !== null}
          aria-describedby={fieldErrors.next !== null ? "profile-new-password-error" : undefined}
        />
        {fieldErrors.next !== null ? (
          <p id="profile-new-password-error" className="text-xs text-destructive">
            {fieldErrors.next}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-confirm-password">Confirm new password</Label>
        <Input
          id="profile-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
          }}
          aria-invalid={fieldErrors.confirm !== null}
          aria-describedby={fieldErrors.confirm !== null ? "profile-confirm-password-error" : undefined}
        />
        {fieldErrors.confirm !== null ? (
          <p id="profile-confirm-password-error" className="text-xs text-destructive">
            {fieldErrors.confirm}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Changing…" : "Change password"}
        </Button>
      </div>

      {succeeded ? (
        // 诚实性（R6）：必须明确告知其他设备已登出，否则用户会以为它们仍在线。
        // 当前设备由库换发 cookie，保持登录 —— 这一点也写出来，免得用户以为要重登。
        <p role="status" className="text-xs text-muted-foreground">
          Password changed. All other devices have been signed out. This device stays signed in.
        </p>
      ) : null}
    </form>
  );
}
