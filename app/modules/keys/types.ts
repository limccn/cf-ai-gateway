// 密钥模块类型：复用后端 Zod schema 推导（spec type-safety.md：禁止前端重定义）。
// 注意：verbatimModuleSyntax 下 `export { X } from` 不建立本地绑定，需 import 后再 export。
import type {
  CreateKeyInput,
  UpdateKeyInput,
  KeyResponse,
} from "../../../src/routes/keys/types";

export type { CreateKeyInput, UpdateKeyInput, KeyResponse };

/** POST /api/keys 响应：明文仅在创建响应中出现一次。 */
export interface CreateKeyOutput {
  success: true;
  key: KeyResponse;
  plaintext: string;
}

export interface ListKeysOutput {
  success: true;
  items: KeyResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface UpdateKeyOutput {
  success: true;
  key: KeyResponse;
}
