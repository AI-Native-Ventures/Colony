import type {
  SubscriptionAccount,
  SubscriptionConnection,
  SubscriptionModel,
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

/**
 * The reasoning efforts a model offers, or an empty list when it offers none.
 *
 * Always read from the provider's own answer for that model: two models on one
 * subscription do not offer the same set (GPT-5.6-Sol advertises `ultra`,
 * GPT-5.5 stops at `xhigh`), so a shared list would be wrong for one of them.
 */
export function subscriptionModelEfforts(
  connection: SubscriptionConnection | undefined,
  model: string | null | undefined,
): SubscriptionModel["efforts"] {
  return (
    connection?.connected.models.find((entry) => entry.id === model)?.efforts ??
    []
  );
}

/**
 * The effort the provider itself defaults this model to, or null when it does not
 * say (Claude) or names one it does not list.
 *
 * Null is a real choice, not a missing value: the vendor's own configuration then
 * decides, which is what these teammates did before the picker existed.
 */
export function subscriptionModelDefaultEffort(
  connection: SubscriptionConnection | undefined,
  model: string | null | undefined,
): string | null {
  const entry = connection?.connected.models.find(
    (candidate) => candidate.id === model,
  );
  const advertised = entry?.efforts.some(
    (effort) => effort.effort === entry.defaultEffort,
  );
  return advertised ? (entry?.defaultEffort ?? null) : null;
}

/**
 * Whether this effort is one the chosen model actually advertises.
 *
 * No effort at all is always allowed: it means the vendor's own default, which
 * is what every subscription teammate ran on before the picker existed. A named
 * effort the model never advertised is refused here rather than at the bridge,
 * where it would surface as a teammate that will not start.
 */
export function subscriptionEffortAllowed(
  connection: SubscriptionConnection | undefined,
  model: string | null | undefined,
  effort: string | null | undefined,
): boolean {
  if (!effort) return true;
  return subscriptionModelEfforts(connection, model).some(
    (entry) => entry.effort === effort,
  );
}

/** Auth found elsewhere on the Mac is not permission for Colony's isolated runtime. */
export function subscriptionConnectionReady(
  connection: SubscriptionConnection | undefined,
  model: string | null | undefined,
  nowSeconds: number,
  effort?: string | null,
): boolean {
  return (
    !!connection &&
    connection.installed &&
    !connection.launchError &&
    connection.connected.authentication === "subscription" &&
    !subscriptionExhausted(connection.connected, nowSeconds) &&
    connection.connected.models.some((entry) => entry.id === model) &&
    subscriptionEffortAllowed(connection, model, effort)
  );
}
