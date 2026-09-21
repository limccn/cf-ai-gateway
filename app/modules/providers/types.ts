// Provider 模块类型：复用后端 Zod schema 推导（spec type-safety.md）。
import type {
  ProviderResponse,
  ProviderType,
  CreateProviderInput,
  UpdateProviderInput,
  ThinkingMode,
  ProbeProtocol,
  ProviderProbeResult,
  TestProviderOutput,
  ProviderPingResult,
  PingProviderOutput,
} from "../../../src/routes/providers/types";

export type {
  ProviderResponse,
  ProviderType,
  CreateProviderInput,
  UpdateProviderInput,
  ThinkingMode,
  ProbeProtocol,
  ProviderProbeResult,
  TestProviderOutput,
  ProviderPingResult,
  PingProviderOutput,
};

export interface ListProvidersOutput {
  success: true;
  items: ProviderResponse[];
}
