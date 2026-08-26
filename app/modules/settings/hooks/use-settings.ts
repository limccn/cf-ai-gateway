import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { SettingsOutput } from "../types";

/** GET /api/admin/settings — 当前生效的运行时默认配置（admin 只读）。 */
export function useSettings() {
  return useQuery({
    queryKey: ["settings", "admin"],
    queryFn: () => apiFetch<SettingsOutput>("/api/admin/settings"),
    staleTime: 60_000,
  });
}
