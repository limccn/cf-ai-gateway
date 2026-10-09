import { useQuery } from "@tanstack/react-query";
import { apiFetch, buildQuery } from "@/lib/api";
import type { ListKeysOutput } from "../types";

export interface KeysParams {
  /** **admin 专用**：只看某个用户的 Key（member 传了也会被后端忽略、强制自身，见 list.ts）。 */
  userId?: number;
  status?: "active" | "revoked";
  limit?: number;
  offset?: number;
  /** 置 false 时不请求。 */
  enabled?: boolean;
}

/** GET /api/keys — 网关 Key 列表。member 恒为自身；admin 为全部，可按 userId / status 过滤。 */
export function useKeys(params: KeysParams = {}) {
  return useQuery({
    // 带参数后 key 从 ["keys"] 变为 ["keys", params]；use-revoke-key / use-create-key /
    // use-update-key 失效的是 `["keys"]` **前缀**，前缀匹配仍命中，无需同步改。
    queryKey: ["keys", params],
    queryFn: () =>
      apiFetch<ListKeysOutput>(
        `/api/keys${buildQuery({
          userId: params.userId,
          status: params.status,
          limit: params.limit,
          offset: params.offset,
        })}`,
      ),
    enabled: params.enabled !== false,
    staleTime: 30_000,
  });
}
