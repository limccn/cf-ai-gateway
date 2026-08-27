// 价格表 DB → API 响应转换（type-safety spec：时间戳统一 ISO 字符串）。
import type { Model } from "../../../db/schema";
import type { ModelResponse } from "../types";

export function toModelResponse(model: Model): ModelResponse {
  return {
    id: model.id,
    model: model.model,
    inputPriceShort: model.inputPriceShort,
    inputPriceLong: model.inputPriceLong,
    inputPriceCached: model.inputPriceCached,
    outputPriceShort: model.outputPriceShort,
    outputPriceLong: model.outputPriceLong,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}
