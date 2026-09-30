import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ListProviderPresetsOutput } from "../types";

/**
 * GET /api/providers/presets — preset 档案常量表（09-28 批次 5，design §2.4）。
 * 档案本体是服务端代码 const；前端经 API 取（**不做前后端共享 import**——先例
 * app/modules/models/display.ts「SPA 不该背服务端常量」）。staleTime 放宽：
 * 常量表只在发版时变化，一次会话内取一次足够。
 */
export function useProviderPresets() {
  return useQuery({
    queryKey: ["provider-presets"],
    queryFn: () => apiFetch<ListProviderPresetsOutput>("/api/providers/presets"),
    staleTime: 300_000,
  });
}
