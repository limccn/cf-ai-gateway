// 价格表 DB → API 响应转换（type-safety spec：时间戳统一 ISO 字符串）。
//
// 批次 P（09-14-admin-ui-adjustments-2，D18/D20）：**两个投影，按角色选**。
// 角色相关投影必须发生在**服务端** —— member 的响应里既不出现被隐藏的行（lib 不负责过滤，
// 见 procedures/list.ts 的 where），也不出现免费模型的真实价（本文件的 toMemberModelResponse）。
// 前端拿不到原值，devtools 也读不到 ⇒ 这是"看不见"，不是"不显示"。
import type { Model } from "../../../db/schema";
import type { ModelResponse } from "../types";

/** 库内完整行（admin 视角）：含两个标记 + 库中真实价格。 */
export function toModelResponse(model: Model): ModelResponse {
  return {
    id: model.id,
    model: model.model,
    inputPriceShort: model.inputPriceShort,
    inputPriceLong: model.inputPriceLong,
    inputPriceCached: model.inputPriceCached,
    outputPriceShort: model.outputPriceShort,
    outputPriceLong: model.outputPriceLong,
    maxOutputTokens: model.maxOutputTokens ?? null,
    freeMode: model.freeMode,
    hiddenFromMembers: model.hiddenFromMembers,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

/**
 * member 视角（只读）：免费模型的 5 个价**置 0**（D20）。
 *
 * 为什么置 0 而不是省略/置 null：价格字段在全站是**非空 number**（前端格式化、用量明细、
 * 模型环形图都假定有值），把它变成可空会逼全站处理"价格缺失"。置 0 的语义也自洽 ——
 * **该模型当前免费**，member 看到的就是它实际要付的价；真实价是运维信息，不给 member 看。
 *
 * 隐藏行**不在这里处理**：过滤发生在 SQL（`where hiddenFromMembers = false`），
 * 到了本函数就已经只剩可见行 —— 两处分开是因为行过滤必须在**查库**时做（省带宽、也避免
 * 顺手在内存里 filter 后被后续代码重新引入）。
 */
export function toMemberModelResponse(model: Model): ModelResponse {
  const free = model.freeMode;
  return {
    id: model.id,
    model: model.model,
    inputPriceShort: free ? 0 : model.inputPriceShort,
    inputPriceLong: free ? 0 : model.inputPriceLong,
    inputPriceCached: free ? 0 : model.inputPriceCached,
    outputPriceShort: free ? 0 : model.outputPriceShort,
    outputPriceLong: free ? 0 : model.outputPriceLong,
    maxOutputTokens: model.maxOutputTokens ?? null,
    freeMode: model.freeMode,
    // member 恒 false：为真的行已被 SQL 过滤掉，进不到这里（admin 视角才可能读到 true）
    hiddenFromMembers: model.hiddenFromMembers,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}
