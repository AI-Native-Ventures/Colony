import type { SubscriptionScan } from "@/shared/api/tauriSubscriptions";

/** Synthetic native-shaped metadata. This fixture never reads local accounts. */
export const MOCK_SUBSCRIPTION_SCAN: SubscriptionScan = {
  harnesses: [
    {
      id: "claude",
      state: {
        state: "signed_in",
        tier: "Max",
        plan_label: "Max 20x",
        short_window: { remaining_percent: 80, resets_at: null },
        long_window: { remaining_percent: 65, resets_at: null },
        usage_captured_at: null,
      },
    },
    { id: "codex", state: { state: "installed_not_signed_in" } },
    { id: "opencode", state: { state: "not_installed" } },
    { id: "goose", state: { state: "not_installed" } },
  ],
  recommended_id: "claude",
};

export type MockSubscriptionScanResult = SubscriptionScan | { error: string };

/** One scanner per mock installation; a final sequence result repeats on retry. */
export function createMockSubscriptionScanner(config?: {
  subscriptionScan?: SubscriptionScan;
  subscriptionScanSequence?: MockSubscriptionScanResult[];
}): () => SubscriptionScan {
  let calls = 0;
  return () => {
    const sequence = config?.subscriptionScanSequence;
    const result = sequence?.length
      ? sequence[Math.min(calls++, sequence.length - 1)]
      : (config?.subscriptionScan ?? MOCK_SUBSCRIPTION_SCAN);
    if ("error" in result) throw new Error(result.error);
    return structuredClone(result);
  };
}
