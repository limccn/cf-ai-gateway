// Profile 模块类型：复用后端 Zod schema 推导（spec type-safety.md：前后端类型单一真源）。
//
// 刻意保持**纯类型**导入：`import type` 在构建期被完全擦除，因此本模块不会把后端 schema
// （及其 zod 依赖）拉进任何分块。曾试过在此 re-export 运行时值 MIN_PASSWORD_LENGTH，结果
// 把 zod 拖进首屏图 —— 见下方说明。要加运行时值请先读这段。
import type { Profile, ProfileOutput } from "../../../src/routes/profile/types";

export type { Profile, ProfileOutput };

// 密码下限（MIN_PASSWORD_LENGTH）**不走本模块**：它定义在零依赖的 src/lib/password.ts，
// 前端一律直取。原因不是洁癖，是实测的分块后果 —— 本模块若 import 该常量，就会与
// src/routes/profile/types.ts（import zod、模块加载即构造 schema）建立运行时边；而
// change-password-form 经 profile-dialog → user-button 挂在根布局上（非懒加载），
// 于是整份 profile schema + zod 被并入首屏 index（182 kB → 255 kB，gzip +19 kB）。
// 直取 src/lib/password.ts 则只多一个常量。前端导入后端运行时值的先例：
// app/routes/providers.tsx:12（那里取的是 schema，本就该带 zod，故无此问题）。
