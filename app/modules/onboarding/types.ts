// 引导模块类型：复用后端 Zod schema 推导（spec type-safety.md：前后端类型单一真源）。
import type {
  MarkWelcomeSeenOutput,
  OnboardingOutput,
  OnboardingWelcome,
} from "../../../src/routes/onboarding/types";

export type { MarkWelcomeSeenOutput, OnboardingOutput, OnboardingWelcome };
