// 上游密钥展示位（09-21-seed-migration-tooling R-A15/A16）。
//
// 后端契约：`providers.api_key_prefix` 为空 ⇒ `apiKeyMasked === ""`（见
// src/routes/providers/lib/convert.ts）。前端据此渲染**明确标记**，绝不能让它显示成 `****` ——
// 那与真实密钥的掩码逐字相同，管理台会以「已配置」的样子撒谎（AC-A7 的反面）。
//
// 两个面共用这一个组件（表格的 Key 列 / Edit basics 弹窗的只读态密钥行）：
// 文案只此一份，各写一份字面量必然漂移。这一态在 stg→prod 迁移后是 10/10 行，
// 是管理台里最先被看到的状态，不是边角。

/** 「未配置上游密钥」标记的唯一文案。 */
export const API_KEY_NOT_CONFIGURED_LABEL = "Upstream key not configured";

/**
 * 掩码**内容**（不含外壳 `<code>`）：外层结构由调用方给（表格是裸 `<code>`，
 * 弹窗是带 `h-9` 边框的盒），这里只决定「渲染掩码原文」还是「渲染未配置标记」。
 */
export function ApiKeyMask({ masked }: { masked: string }) {
  if (masked === "") {
    // 斜体 + 同色系：与掩码等宽等色，但一眼可辨「这不是一个前缀」
    return <span className="italic">{API_KEY_NOT_CONFIGURED_LABEL}</span>;
  }
  return <>{masked}</>;
}
