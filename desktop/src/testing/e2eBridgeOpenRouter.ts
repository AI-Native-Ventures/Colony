import type { OpenRouterQuotaCheck } from "@/shared/api/tauriOpenRouterQuota";
import type { OpenRouterConnectOutcome } from "@/shared/api/tauriOpenRouter";

export type MockOpenRouterConfig = {
  openRouterConnection?: OpenRouterConnectOutcome;
  openRouterQuotaSequence?: Array<OpenRouterQuotaCheck | { error: string }>;
};

/** Deterministic provider evidence; never opens or pays a real provider account. */
export function createMockOpenRouter(config?: MockOpenRouterConfig) {
  let reads = 0;
  return {
    connect: () => config?.openRouterConnection ?? { status: "cancelled" },
    quota: () => {
      const values = config?.openRouterQuotaSequence ?? [{ status: "unknown" }];
      const value = values[Math.min(reads++, values.length - 1)] ?? {
        status: "unknown",
      };
      if ("error" in value) throw new Error(value.error);
      return value;
    },
  };
}
