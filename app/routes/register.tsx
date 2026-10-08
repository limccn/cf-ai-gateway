// /register — 注册页（M6 6.2）。
// 邀请码注册：后端 validateUserInfo 要求 email/password signup 使用 invite code，
// 客户端 types 不知道 additionalFields，用 spread 技巧传递。
//
// 批次 U（D28–D30，闭环体验 prd D29）：
//   - 邀请链接 `?invite=CODE` → trim+大写归一后预填（无参数则零行为变化，AC49）；
//   - URL 带码、以及输入框 blur（改码后）→ GET /api/invites/validate 预校验；
//   - 服务端 valid:false → `role="alert"` 失效警示 + 禁用提交；重新校验通过即恢复（AC50）；
//   - 校验请求**本身失败**（429/5xx/网络错）→ fail-open：不警示、不禁用，只给中性提示 ——
//     把网络故障说成「码失效」会吓退本可注册的好码，最终判定由提交时 Better Auth 403 兜底；
//   - 警示 / 禁用 / 中性提示三态的判据**唯一**来源是 inviteCheckGate（app/lib/invite-check.ts）——
//     JSX 里不另写条件，否则单测锁住的是没人用的死函数（AC50 变异自检的前提）。
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/hooks/use-session";
import { useMounted } from "@/hooks/use-mounted";
import { apiFetch } from "@/lib/api";
import { inviteCheckGate, type InviteCheckStatus } from "@/lib/invite-check";
import { normalizeInviteCode } from "@/lib/invite-link";
import { MIN_PASSWORD_LENGTH } from "../../src/lib/password";
// type-only 导入（完全擦除、零运行时成本）：响应契约与服务端单一真源（spec type-safety.md）
import type { ValidateInviteOutput } from "../../src/routes/invites/types";
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
  const [searchParams] = useSearchParams();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // 预填：?invite= 归一（trim+大写）后作初值；无该参数时 normalize("") = "" ⇒ 表单现状零回归（AC49）
  const [inviteCode, setInviteCode] = useState(() =>
    normalizeInviteCode(searchParams.get("invite") ?? ""),
  );
  const [errors, setErrors] = useState<Partial<Record<keyof RegisterForm, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ---- 预校验状态机（批次 U，D29）----
  const [inviteCheck, setInviteCheck] = useState<InviteCheckStatus>("unchecked");
  /** 校验序号：改码 / 新一轮校验即递增 —— 乱序回包（旧请求后到）据此作废，不得覆盖新状态。 */
  const checkSeqRef = useRef(0);
  /** 上次拿到**确定结论**（valid/invalid）的码：同码重复 blur 不重发，免得白烧限流额度
   *  （D30：10 次/60s/IP，与登录共享桶）。error 不写入 ⇒ 下次 blur 可重试。 */
  const checkedCodeRef = useRef<string | null>(null);

  const runInviteCheck = useCallback(async (raw: string) => {
    const code = normalizeInviteCode(raw);
    if (code.length === 0) {
      checkSeqRef.current += 1; // 作废在途请求
      checkedCodeRef.current = null;
      setInviteCheck("unchecked");
      return;
    }
    if (code === checkedCodeRef.current) {
      return; // 值未变的重复 blur（已有确定结论）—— 不重发
    }
    const seq = ++checkSeqRef.current;
    setInviteCheck("checking");
    try {
      const result = await apiFetch<ValidateInviteOutput>(
        `/api/invites/validate?code=${encodeURIComponent(code)}`,
      );
      if (seq !== checkSeqRef.current) return; // 已有新一轮校验，丢弃旧回包
      checkedCodeRef.current = code;
      setInviteCheck(result.valid ? "valid" : "invalid");
    } catch {
      if (seq !== checkSeqRef.current) return;
      // fail-open（AC50 第三分支）：429/5xx/网络错 ≠ 码失效 —— 不写 checkedCodeRef，
      // 下次 blur 可重试；中性提示由 gate.showRetryHint 承担。
      setInviteCheck("error");
    }
  }, []);

  // URL 带码 → 打开即校验（AC50 第一分支）。searchParams 由 react-router 按 location.search
  // 记忆化、恒定时不重跑；无 ?invite= 或归一后为空则不发请求（AC49 后半零回归）。
  useEffect(() => {
    const initial = normalizeInviteCode(searchParams.get("invite") ?? "");
    if (initial.length > 0) {
      void runInviteCheck(initial);
    }
  }, [searchParams, runInviteCheck]);

  if (!isMounted) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }
  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  // 三态（警示/禁用/中性提示）的唯一判据 —— JSX 不得另写条件（见文件头）
  const gate = inviteCheckGate(inviteCheck);

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
            onChange={(e) => {
              setInviteCode(e.target.value);
              // 改码即清理警示态（D29），并作废在途校验与旧结论
              checkSeqRef.current += 1;
              checkedCodeRef.current = null;
              setInviteCheck("unchecked");
            }}
            onBlur={() => {
              // 手输/改码 blur → 预校验（D29 闭环的第二条触发路径；空码内部归位 unchecked）
              void runInviteCheck(inviteCode);
            }}
            aria-invalid={errors.inviteCode !== undefined || gate.showInvalidAlert}
          />
          {errors.inviteCode ? <p className="text-xs text-destructive">{errors.inviteCode}</p> : null}
          {/* 失效警示：仅服务端 valid:false 出现（role="alert" 是 AC50 的画面判据）。
              与表单顶部的 formError 同为 alert —— 两条同时出现时都是真警报，不构成歧义。 */}
          {gate.showInvalidAlert ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              Invalid, used or expired invite code — ask an admin for a new one.
            </p>
          ) : gate.showRetryHint ? (
            // 中性提示：**刻意不是** role="alert"、不带失效措辞 —— 网络故障 ≠ 码失效（AC50 第三分支）
            <p className="text-xs text-muted-foreground">
              We couldn&apos;t verify this invite code right now — it will be checked again when you
              submit.
            </p>
          ) : null}
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting || gate.blockSubmit}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
