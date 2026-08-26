// providers.models 列（JSON 字符串：内部模型名 -> 上游模型名）解析工具。
/** 解析失败返回空映射（防御性兜底；不应发生，创建时已 JSON 校验）。 */
export function parseProviderModels(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}
