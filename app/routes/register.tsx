// /register — 注册页（M6 6.2）。
// 邀请码注册：后端 validateUserInfo 要求 email/password signup 使用 invite code，
// 客户端 types 不知道 additionalFields，用 spread 技巧传递。
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/hooks/use-session";
import { useMounted } from "@/hooks/use-mounted";
import { MIN_PASSWORD_LENGTH } from "../../src/lib/password";
import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const registerFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(64, "Name must be 64 characters or fewer"),
  email: z.string().email("Enter a valid email address"),
  // 下限取自唯一真源 src/lib/password.ts（直接导入属主模块 —— 注册页与 profile 契约无关，
  // 经 @/modules/profile/types 取会是一次语义错配的耦合；同 providers.tsx 直取 src/ 的既有模式）。
  // 09-17 修正：此处原为字面量 8，是「单一真源」名存实亡的第三处（另两处：src/lib/auth.ts、
  // 改密码表单文案）。注册页是**在库校验之前**拦截的，写死会让「库改了、注册页没改」
  // 直接表现为合法密码注册不进去。
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
  inviteCode: z.string().min(1, "An invite code is required"),
});

type RegisterForm = z.infer<typeof registerFormSchema>;

export default function RegisterPage() {
  const isMounted = useMounted();
  const { user } = useSession();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [errors, setErrors] = useState<Partial<Record<keyof RegisterForm, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isMounted) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }
  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const parsed = registerFormSchema.safeParse({ name, email, password, inviteCode });
    if (!parsed.success) {
      const next: Partial<Record<keyof RegisterForm, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof RegisterForm;
        if (key !== undefined && next[key] === undefined) {
          next[key] = issue.message;
        }
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setIsSubmitting(true);
    try {
      const { error } = await authClient.signUp.email({
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name,
        ...(parsed.data.inviteCode.length > 0 ? { inviteCode: parsed.data.inviteCode } : {}),
      });
      if (error) {
        setFormError(error.message ?? "Registration failed");
        return;
      }
      navigate("/dashboard", { replace: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="Create your account"
      description="You need an invite code to join this gateway"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {formError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="register-name">Name</Label>
          <Input
            id="register-name"
            autoComplete="name"
            placeholder="Ada Lovelace"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={errors.name !== undefined}
          />
          {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="register-email">Email</Label>
          <Input
            id="register-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={errors.email !== undefined}
          />
          {errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="register-password">Password</Label>
          <Input
            id="register-password"
            type="password"
            autoComplete="new-password"
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={errors.password !== undefined}
          />
          {errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : null}
        </div>
        <div className="space-y-2">
          {/* 占位符须与 src/lib/invites.ts generateInviteCode 一致：10 位大写字母数字、无连字符。 */}
          <Label htmlFor="register-invite">Invite code</Label>
          <Input
            id="register-invite"
            placeholder="10-character invite code"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            aria-invalid={errors.inviteCode !== undefined}
          />
          {errors.inviteCode ? <p className="text-xs text-destructive">{errors.inviteCode}</p> : null}
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
