// 剪贴板写入（带降级）：优先 Clipboard API，失败/不可用时回退 execCommand。
// 返回是否成功 —— 调用方据此给出用户可见反馈（修复 invite copy 静默失败，task 08-28-fix-invite-copy）。
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API 可用但被拒绝（权限/失焦等）→ 尝试降级路径
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
