import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ListModelsOutput } from "../types";

/**
 * GET /api/models — 模型价格表。**任何已登录用户**可读（批次 P，D18）：
 * admin 拿到全量 + 库中真价，member 拿到过滤后（无隐藏行）且免费行价格已由**服务端置 0** 的视图。
 * 角色差异全部在服务端完成，本 hook 两种角色走同一条查询。
 */
export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: () => apiFetch<ListModelsOutput>("/api/models"),
    staleTime: 60_000,
  });
}
