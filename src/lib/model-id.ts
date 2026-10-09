// 模型 ID `[1m]` 后缀工具（PRD R1）：Claude Code 等 agent 工具以 `模型ID[1m]` 声明 1M
// long context 别名。语义：`[1m]` 仅作为**下游别名**兼容使用 —— 新模型（Claude 5 家族等）
// 原生支持 1M context，对上游而言后缀只是别名，网关默认向上游转发**无后缀**的模型 ID；
// 仅当映射显式配置了带 `[1m]` 的上游名时按配置转发。计费与使用记录一律使用剥离后缀的 ID。
// 本模块是「路由匹配 / 上游名 / 计费名」三者的唯一事实来源。

export const SUFFIX_1M = "[1m]";

/** 模型 ID 末尾是否恰为 `[1m]`（仅识别此一种后缀；其余按普通 ID 精确匹配）。 */
export function has1mSuffix(model: string): boolean {
  return model.endsWith(SUFFIX_1M);
}

/** 剥离一次 `[1m]` 后缀（幂等：`X[1m][1m]` → `X[1m]`，保留一个后缀语义）。 */
export function strip1mSuffix(model: string): string {
  return has1mSuffix(model) ? model.slice(0, -SUFFIX_1M.length) : model;
}

/**
 * 模型 ID 解析：给定路由映射与原始请求模型名，得出路由是否可匹配、上游模型名与计费模型名。
 * - matched：`models[raw]` 精确命中，或请求带 `[1m]` 时 `models[strip(raw)]` 回退命中。
 * - upstream：精确命中 = 映射值原样（显式 `X[1m]` 映射由配置者决定上游名）；
 *   回退命中 = 无后缀映射值原样（`[1m]` 仅下游别名，不向上游拼回后缀；映射值自身带 `[1m]` 时按配置保留）。
 * - billing：剥离 `[1m]` 后的 ID（价格查询 / request_logs / usage / 缓存键统一使用）。
 */
export function resolveModelId(
  models: Record<string, string>,
  raw: string,
): { matched: boolean; upstream: string; billing: string } {
  const billing = strip1mSuffix(raw);
  const exact = models[raw];
  if (exact !== undefined) {
    // 精确命中：映射值是配置者给出的完整上游名，原样使用（显式映射 `X[1m]` 由配置者负责后缀）
    return { matched: true, upstream: exact, billing };
  }
  if (has1mSuffix(raw)) {
    const fallback = models[billing];
    if (fallback !== undefined) {
      // 回退命中：`[1m]` 仅下游别名，默认转发无后缀映射值；映射值显式带 `[1m]` 时按配置保留
      return { matched: true, upstream: fallback, billing };
    }
  }
  return { matched: false, upstream: raw, billing };
}
