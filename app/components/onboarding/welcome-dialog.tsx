// 首登赠金到账引导弹窗（09-16-first-login-welcome）。
//
// 职责：新用户首次进入应用时告知「赠金已到账 + 金额」，并给出下一步动作（创建 API Key）。
// 展示条件（不满足即不渲染任何东西）：
//   - 服务端 pending=true 且金额非空（无赠金流水 / 赠金开关关闭 / 存量用户 / 发放失败 → 不弹）
//   - 查询未就绪（isPending）或失败（isError）→ 静默不渲染：首登提示不是关键路径，
//     不值得把用户挡在错误提示前
//   - 本地已关闭（乐观关闭）→ 立即消失，不等网络
//
// 三条关闭路径（主按钮 Create API key / 次按钮 Later / Esc·遮罩·X → onOpenChange(false)）
// **都**写服务端已读标记（AC3）。标记写入失败也照样关闭（R6）：重复提示一次远好于把用户卡住。
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatUsd } from "@/lib/format";
import { useMarkWelcomeSeen } from "@/modules/onboarding/hooks/use-mark-welcome-seen";
import { useOnboarding } from "@/modules/onboarding/hooks/use-onboarding";

export function WelcomeDialog() {
  const navigate = useNavigate();
  const { data, isPending, isError } = useOnboarding();
  const markSeen = useMarkWelcomeSeen();
  // 乐观关闭：本地置位后即便标记请求失败也不再展示（R6）
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || isPending || isError) {
    return null;
  }

  const welcome = data?.welcome;
  if (!welcome?.pending) {
    return null;
  }
  const bonusAmount = welcome.bonusAmount;
  if (bonusAmount === null) {
    // pending=true 时金额恒非空（服务端契约）；防御性兜底：宁可少弹，不展示 $0.00 误导用户
    return null;
  }
  // 提前格式化：金额文案在渲染前定型，不依赖属性收窄在回调里的存活
  const description = `We've added ${formatUsd(bonusAmount)} to your account. Create an API key to start making requests.`;

  /** 关闭 + 标记已读（fire-and-forget：失败静默，仅影响下次登录是否再弹）。 */
  const close = () => {
    setDismissed(true);
    markSeen.mutate();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      title="Welcome — your credit is ready"
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Later
          </Button>
          <Button
            onClick={() => {
              close();
              navigate("/keys");
            }}
          >
            Create API key
          </Button>
        </>
      }
    />
  );
}
