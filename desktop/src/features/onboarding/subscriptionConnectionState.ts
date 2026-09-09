import type {
  SubscriptionAccount,
  SubscriptionConnection,
} from "@/shared/api/tauriSubscriptionConnections";

/** Limits that have reset or describe another model do not block this account. */
export function subscriptionExhausted(
  account: SubscriptionAccount,
  nowSeconds: number,
): boolean {
  return (
    account.measurementStatus === "live" &&
    account.windows.some(
      (window) =>
        window.accountWide &&
        window.usedPercent >= 100 &&
        (window.resetsAt === null || window.resetsAt > nowSeconds),
    )
  );
}

/** Auth found elsewhere on the Mac is not permission for Colony's isolated runtime. */
export function subscriptionConnectionReady(
  connection: SubscriptionConnection | undefined,
  model: string | null | undefined,
  nowSeconds: number,
): boolean {
  return (
    !!connection &&
    connection.installed &&
    !connection.launchError &&
    connection.connected.authentication === "subscription" &&
    !subscriptionExhausted(connection.connected, nowSeconds) &&
    connection.connected.models.some((entry) => entry.id === model)
  );
}
