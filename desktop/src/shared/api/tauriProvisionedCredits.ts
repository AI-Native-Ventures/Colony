import { invoke } from "@/shared/api/nativeBridge";

export type ColonyCreditsAccountStatus = "active" | "depleted";
export type ColonyCreditsAccount = {
  balance_nanousd: string;
  currency: "USD";
  status: ColonyCreditsAccountStatus;
};

/** Read the current volatile Colony Credits account handle. */
export function getColonyCreditsAccount(): Promise<ColonyCreditsAccount> {
  return invoke<ColonyCreditsAccount>("get_colony_credits_account");
}

/** Trigger the one explicit replacement/reconnect path. */
export function reconnectColonyCredits(): Promise<void> {
  return invoke<void>("reconnect_colony_credits");
}

/**
 * Format signed nanodollars without converting through a binary float.
 * Balances at or below zero intentionally display as `$0.00`; callers use
 * `getColonyCreditsStatus` to preserve the depleted state separately.
 */
export function formatNanousdAsUsd(balanceNanousd: string): string {
  let balance: bigint;
  try {
    balance = BigInt(balanceNanousd.trim());
  } catch {
    return "$0.00";
  }
  if (balance <= 0n) return "$0.00";
  const nanodollarsPerDollar = 1_000_000_000n;
  const nanodollarsPerCent = 10_000_000n;
  const dollars = balance / nanodollarsPerDollar;
  const cents = (balance % nanodollarsPerDollar) / nanodollarsPerCent;
  return `$${dollars.toString()}.${cents.toString().padStart(2, "0")}`;
}

/** Derive status from the exact integer balance, independent of formatting. */
export function getColonyCreditsStatus(
  balanceNanousd: string,
): ColonyCreditsAccountStatus {
  try {
    return BigInt(balanceNanousd.trim()) > 0n ? "active" : "depleted";
  } catch {
    return "depleted";
  }
}
