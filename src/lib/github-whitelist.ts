// GitHub OAuth 白名单校验（M2 2.4）。
// 规则：GITHUB_ALLOWED_EMAILS 逗号分隔；比较不区分大小写、忽略空白。
// 白名单为空时拒绝所有（fail-closed）：未配置即不允许 GitHub 登录。

/**
 * 判断邮箱是否在 GitHub OAuth 白名单内。
 * @param rawList env 中的 GITHUB_ALLOWED_EMAILS 原始值（逗号分隔）
 * @param email 用户邮箱（GitHub profile 邮箱）
 */
export function isEmailAllowed(rawList: string, email: string): boolean {
  const allowed = rawList
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (allowed.length === 0) {
    return false;
  }
  return allowed.includes(email.trim().toLowerCase());
}
