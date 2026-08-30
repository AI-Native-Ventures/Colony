import { useCallback, useEffect, useState } from "react";
import { Loader, RefreshCw } from "lucide-react";

import type { GlobalAgentConfig } from "@/shared/api/types";
import {
  formatNanousdAsUsd,
  getColonyCreditsAccount,
  getColonyCreditsStatus,
  reconnectColonyCredits,
} from "@/shared/api/tauriProvisionedCredits";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import {
  getColonyCreditsUnavailableReason,
  isColonyCreditsEligible,
  resolveEffectiveProviderForColonyCredits,
} from "./colonyCreditsEligibility";

type ColonyCreditsCredentialChoiceProps = {
  config: GlobalAgentConfig;
  runtimeId: string;
  onConfigChange: (next: GlobalAgentConfig) => void;
};

/** Minimal global credential choice for the Phase 1 Colony Credits handle. */
export function ColonyCreditsCredentialChoice({
  config,
  runtimeId,
  onConfigChange,
}: ColonyCreditsCredentialChoiceProps) {
  const [balanceNanousd, setBalanceNanousd] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const effectiveProvider = resolveEffectiveProviderForColonyCredits(
    runtimeId,
    config.provider,
    config.env_vars,
  );
  const supported = isColonyCreditsEligible(runtimeId, effectiveProvider);

  const refreshAccount = useCallback(async () => {
    setIsLoading(true);
    setAccountError(null);
    try {
      const account = await getColonyCreditsAccount();
      setBalanceNanousd(account.balance_nanousd);
    } catch (error) {
      setAccountError(
        typeof error === "string" ? error : "Couldn't read Colony Credits.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const provisionedSelected = config.credential_mode === "colony_credits";

  useEffect(() => {
    if (supported && provisionedSelected) void refreshAccount();
    if (!provisionedSelected) {
      setBalanceNanousd(null);
      setAccountError(null);
    }
  }, [refreshAccount, provisionedSelected, supported]);

  const status = balanceNanousd ? getColonyCreditsStatus(balanceNanousd) : null;

  async function handleReconnect() {
    setIsReconnecting(true);
    setAccountError(null);
    try {
      await reconnectColonyCredits();
      await refreshAccount();
    } catch (error) {
      setAccountError(
        typeof error === "string"
          ? error
          : "Couldn't reconnect Colony Credits.",
      );
    } finally {
      setIsReconnecting(false);
    }
  }

  return (
    <section
      aria-label="Colony Credits"
      className="space-y-3 rounded-2xl border border-border/60 bg-muted/10 p-4"
      data-testid="colony-credits-credential-choice"
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">Credentials</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose how this global default authenticates OpenAI-compatible agents.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          aria-pressed={!provisionedSelected}
          className={cn(
            "rounded-xl border px-3 py-2 text-left text-sm transition-colors",
            !provisionedSelected
              ? "border-primary bg-primary/10"
              : "border-border/60 hover:bg-muted/40",
          )}
          onClick={() => onConfigChange({ ...config, credential_mode: "byok" })}
          type="button"
        >
          <span className="font-medium">Bring your own key</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Keep saved provider credentials and subscription logins unchanged.
          </span>
        </button>
        <button
          aria-disabled={!supported}
          aria-pressed={provisionedSelected}
          className={cn(
            "rounded-xl border px-3 py-2 text-left text-sm transition-colors",
            provisionedSelected && supported
              ? "border-primary bg-primary/10"
              : "border-border/60 hover:bg-muted/40",
            !supported && "cursor-not-allowed opacity-60",
          )}
          disabled={!supported}
          onClick={() =>
            onConfigChange({ ...config, credential_mode: "colony_credits" })
          }
          type="button"
        >
          <span className="font-medium">Colony Credits</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {supported
              ? "Agents pause at $0.00."
              : getColonyCreditsUnavailableReason(runtimeId)}
          </span>
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">Current balance</span>
        {isLoading && <Loader className="size-3.5 animate-spin" />}
        {!isLoading && balanceNanousd !== null && (
          <span
            className={cn(
              "font-medium",
              status === "depleted" && "text-destructive",
            )}
            data-testid="colony-credits-balance"
          >
            {formatNanousdAsUsd(balanceNanousd)}
          </span>
        )}
        {accountError && (
          <span className="text-xs text-destructive">{accountError}</span>
        )}
        <Button
          className="ml-auto"
          disabled={isReconnecting || !supported || !provisionedSelected}
          onClick={() => void handleReconnect()}
          size="sm"
          variant="ghost"
        >
          <RefreshCw className="mr-1.5 size-3.5" />
          {isReconnecting ? "Reconnecting…" : "Reconnect"}
        </Button>
      </div>
    </section>
  );
}
