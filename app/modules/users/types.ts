// 用户管理模块类型：复用后端 Zod schema 推导（spec type-safety.md）。
import type {
  UserResponse,
  InviteCodeResponse,
  UpdateUserInput,
  AdjustBalanceInput,
  CreateInviteInput,
  DeleteUserOutput,
} from "../../../src/routes/users/types";

export type {
  UserResponse,
  InviteCodeResponse,
  UpdateUserInput,
  AdjustBalanceInput,
  CreateInviteInput,
  DeleteUserOutput,
};

export interface ListUsersOutput {
  success: true;
  items: UserResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdjustBalanceOutput {
  success: true;
  balance: number;
  tx: {
    id: number;
    amount: number;
    type: "adjust";
    note: string | null;
    createdAt: string;
  };
}

export interface CreateInviteOutput {
  success: true;
  invite: InviteCodeResponse;
}

export interface ListInvitesOutput {
  success: true;
  items: InviteCodeResponse[];
}
