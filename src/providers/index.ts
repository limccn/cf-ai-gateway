// Provider 适配器注册表（design.md §4：新增类型仅需实现 ProviderAdapter 并在此注册）。
import type { ProviderAdapter, ProviderType } from "./types";
import { openaiAdapter } from "./openai";
import { anthropicAdapter } from "./anthropic";

const ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
};

/** 取适配器（未注册类型返回 null，由调用方报 400/500）。 */
export function getAdapter(type: string): ProviderAdapter | null {
  const adapter = ADAPTERS[type as ProviderType];
  return adapter ?? null;
}
