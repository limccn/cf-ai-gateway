// 邀请链接构建与邀请码归一（批次 U，D28/D29）。
//
// 纯函数、零依赖 —— admin 复制按钮（app/routes/users.tsx 两处）与注册页预填
// （app/routes/register.tsx）共用同一份口径：两边各写一份必然漂移，而漂移的表现是
// 「复制出的链接注册不进去」或「链接里的码与行内展示的码对不上」。
//
// 归一化与服务端**逐字同口径**（src/lib/invites.ts 的 validateInviteCode / consumeInviteCode
// 都是 trim().toUpperCase()）：口径不一致的表现是「链接里能用、手输同一串却判无效」。

/** 邀请码归一：trim + 大写（与服务端同口径）。空/纯空白 → 空串。 */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * 构造邀请链接：`${origin}/register?invite=${CODE}`（D28）。
 *
 * - CODE **原样编码**（encodeURIComponent），不做归一 —— 保证「复制出的码与行内展示的码
 *   逐字一致」（AC48 判据）。库里的码由 generateInviteCode 产出（大写字母数字），
 *   在那里编码是恒等变换；保留 encodeURIComponent 只为防未来码字符集变化时链接被截断。
 * - origin 取 window.location.origin（恒无路径、无尾斜杠），调用方不拼斜杠。
 * - 注册页读取时统一走 normalizeInviteCode（trim + 大小写归一），
 *   故链接里即便带了小写/空白也能正确预填（AC49）。
 */
export function buildInviteLink(code: string, origin: string): string {
  return `${origin}/register?invite=${encodeURIComponent(code)}`;
}
