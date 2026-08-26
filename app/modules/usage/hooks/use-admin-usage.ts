import { useQuery } from "@tanstack/react-query";
import { apiFetch, buildQuery } from "@/lib/api";
import type { UsageOutput } from "../types";
import type { UsageParams } from "./usage-params";

export interface AdminUsageParams extends UsageParams {
  userId?: number;
}

/** GET /api/admin/usage — 管理员全局用量报表（可按 user/key/model/时间过滤）。 */
export function useAdminUsage(params: AdminUsageParams) {
  const { enabled = true, userId, ...rest } = params;
  return useQuery({
    queryKey: ["usage", "admin", params],
    queryFn: () =>
      // 注意：查询参数必须合并后一次 buildQuery——两个 buildQuery 结果拼接会产出
      // 第二个 `?`，被服务端解析为上一个参数值的一部分（userId 丢失 / 校验失败）。
      apiFetch<UsageOutput>(
        `/api/admin/usage${buildQuery({
          ...rest,
          ...(userId !== undefined ? { userId } : {}),
        })}`,
      ),
    enabled,
    staleTime: 30_000,
  });
}
