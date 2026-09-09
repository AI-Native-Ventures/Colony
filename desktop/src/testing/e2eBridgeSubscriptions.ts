import type { SubscriptionScan } from "@/shared/api/tauriSubscriptions";
import type {
  SubscriptionAccount,
  SubscriptionConnection,
} from "@/shared/api/tauriSubscriptionConnections";

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

const emptyAccount: SubscriptionAccount = {
  authentication: "signed_out",
  planLabel: null,
  measurementStatus: "unavailable",
  capturedAt: null,
  windows: [],
  models: [],
  notice: null,
};

export const MOCK_SUBSCRIPTION_CONNECTIONS: SubscriptionConnection[] = [
  {
    runtimeId: "claude",
    label: "Claude",
    installed: true,
    detected: {
      ...emptyAccount,
      authentication: "subscription",
      planLabel: "Max 20x",
      measurementStatus: "live",
      capturedAt: 1788951600,
      windows: [
        {
          id: "seven_day",
          label: "Weekly allowance",
          usedPercent: 35,
          resetsAt: 1893499200,
          durationMinutes: 10080,
          accountWide: true,
        },
      ],
      models: [
        {
          id: "claude-test-model",
          label: "Claude test model",
          isDefault: true,
        },
      ],
    },
    connected: { ...emptyAccount },
    launchError: null,
  },
  {
    runtimeId: "codex",
    label: "ChatGPT / Codex",
    installed: true,
    detected: { ...emptyAccount, authentication: "unknown" },
    connected: { ...emptyAccount },
    launchError: null,
  },
];

export type MockSubscriptionConnectionsConfig = {
  subscriptionConnections?: SubscriptionConnection[];
  subscriptionConnectionsSequence?: (
    | SubscriptionConnection[]
    | { error: string }
  )[];
};

/** Vendor sign-in and measurements are synthetic; this fixture never launches a CLI. */
export function createMockSubscriptionConnections(
  config?: MockSubscriptionConnectionsConfig,
) {
  let calls = 0;
  const connected = new Set<string>();
  return {
    read(payload: unknown) {
      const scope = connectionScope(payload);
      const sequence = config?.subscriptionConnectionsSequence;
      const result = sequence?.length
        ? sequence[Math.min(calls++, sequence.length - 1)]
        : (config?.subscriptionConnections ?? MOCK_SUBSCRIPTION_CONNECTIONS);
      if ("error" in result) throw new Error(result.error);
      return structuredClone(result).map((entry) =>
        connected.has(`${scope}:${entry.runtimeId}`)
          ? { ...entry, connected: structuredClone(entry.detected) }
          : entry,
      );
    },
    connect(payload: unknown) {
      const runtime = (payload as { runtimeId?: string })?.runtimeId;
      if (!runtime) throw new Error("A provider is required");
      connected.add(`${connectionScope(payload)}:${runtime}`);
    },
  };
}

function connectionScope(payload: unknown) {
  const scope = (
    payload as { scope?: { ownerPubkey?: string; relayUrl?: string } }
  )?.scope;
  if (!scope?.ownerPubkey || !scope.relayUrl)
    throw new Error("An account and business are required");
  return JSON.stringify([scope.ownerPubkey, scope.relayUrl]);
}
