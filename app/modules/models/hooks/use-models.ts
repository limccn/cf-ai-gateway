import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ListModelsOutput } from "../types";

/** GET /api/models — 模型价格表（admin）。 */
export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => apiFetch<ListModelsOutput>("/api/models"),
    staleTime: 60_000,
  });
}
