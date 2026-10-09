import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { LifetimeCostOutput } from "../types";

/**
 * GET /api/me/usage/lifetime — 账户**累计消费**（全时段）。
 *
 * 与 useUsage 的 queryKey 刻意分开（`["usage","me","lifetime"]` 对 `["usage","me",params]`）：
 * 该值不随时间窗筛选变化，staleTime 给足 60s —— 切换窗口只重取窗口那一路，这一路原地不动
 * （若并进 useUsage，每次切窗口都会重算一次全表求和，且卡片会跟着闪加载态）。
 * 前缀失效（invalidateQueries(["usage"])）仍会同时命中两者，这是想要的行为。
 */
export function useLifetimeCost() {
  return useQuery({
    queryKey: ["usage", "me", "lifetime"],
    queryFn: () => apiFetch<LifetimeCostOutput>("/api/me/usage/lifetime"),
    staleTime: 60_000,
  });
}
