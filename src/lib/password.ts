// 密码策略常量的唯一真源。
//
// 为什么单独成文件：库侧（src/lib/auth.ts 的 emailAndPassword.minPasswordLength）与前端
// 拦截文案（change-password 表单的下限提示）必须同口径。若两边各写一个字面量，改下限时
// 必然先漂一边 —— 库拒了前端放行（用户白填一次），或库放行前端拦下（合法密码改不了）。
// 消费方：src/lib/auth.ts（库校验）、app/components/layout/change-password-form.tsx（改密表单文案）、
// app/routes/register.tsx（注册页拦截与占位符）。
//
// **前端一律直取本模块，不得经 src/routes/profile/types.ts 等契约模块中转**：那些模块
// `import { z } from "zod"` 且加载即构造 schema，一旦与其建立运行时边，整份 schema + zod
// 会被并进调用方的分块。改密表单经 profile-dialog → user-button 挂在根布局上（非懒加载），
// 实测把首屏 index 从 182 kB 顶到 255 kB（gzip +19 kB）。本模块零依赖，取它只多一个常量。

export const MIN_PASSWORD_LENGTH = 8;
