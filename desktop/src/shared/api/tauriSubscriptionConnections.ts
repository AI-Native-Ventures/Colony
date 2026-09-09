import { invokeTauri } from "./tauri";
import {
  fromRawInstallRuntimeResult,
  type RawInstallRuntimeResult,
} from "./installTypes";

export type SubscriptionScope = { ownerPubkey: string; relayUrl: string };

export type SubscriptionAccount = {
  authentication: "subscription" | "api_key" | "signed_out" | "unknown";
  planLabel: string | null;
  measurementStatus: "live" | "cached" | "stale" | "unavailable";
  capturedAt: number | null;
  windows: {
    id: string;
    label: string;
    usedPercent: number;
    resetsAt: number | null;
    durationMinutes: number | null;
    accountWide: boolean;
  }[];
  models: { id: string; label: string; isDefault: boolean }[];
  notice: string | null;
};

export type SubscriptionConnection = {
  runtimeId: string;
  label: string;
  installed: boolean;
  canInstall?: boolean;
  detected: SubscriptionAccount;
  connected: SubscriptionAccount;
  launchError: string | null;
};

/** Native CLI metadata only; no prompt, payment, or sign-in is started. */
export function getSubscriptionConnections(scope: SubscriptionScope) {
  return invokeTauri<SubscriptionConnection[]>("get_subscription_connections", {
    scope,
  });
}

/** The vendor owns sign-in. Native storage stays outside agent workspaces. */
export function connectSubscription(
  runtimeId: string,
  scope: SubscriptionScope,
) {
  return invokeTauri<void>("connect_subscription", { runtimeId, scope });
}

/** Explicit software installation only; sign-in and teammate launch are separate actions. */
export async function installSubscriptionRuntime(
  runtimeId: string,
  scope: SubscriptionScope,
) {
  const result = await invokeTauri<RawInstallRuntimeResult>(
    "install_subscription_runtime",
    { runtimeId, scope },
  );
  return fromRawInstallRuntimeResult(result);
}
