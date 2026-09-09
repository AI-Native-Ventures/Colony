import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@/shared/api/nativeBridge";
import {
  fetchOpenRouterQuota,
  type OpenRouterQuotaCheck,
} from "@/shared/api/tauriOpenRouterQuota";
import { assertFirstJobScope } from "../../../firstJobScope";
import type { PowerCreditsScope } from "../../../powerCredits";

/** Account evidence and a provider-owned purchase handoff, without collecting payment. */
export function OpenRouterAllowance({
  apiKey,
  scope,
}: {
  apiKey: string;
  scope: PowerCreditsScope;
}) {
  const [result, setResult] = useState<OpenRouterQuotaCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [opened, setOpened] = useState(false);
  const generation = useRef(0);
  const current = useRef({
    apiKey,
    owner: scope.ownerPubkey,
    relay: scope.relayUrl,
  });
  current.current = { apiKey, owner: scope.ownerPubkey, relay: scope.relayUrl };
  const evidence = useRef<typeof current.current | null>(null);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setChecking(true);
    setError(null);
    try {
      await assertFirstJobScope(scope);
      const next = await fetchOpenRouterQuota(apiKey);
      await assertFirstJobScope(scope);
      if (generation.current === request) {
        evidence.current = {
          apiKey,
          owner: scope.ownerPubkey,
          relay: scope.relayUrl,
        };
        setResult(next);
      }
    } catch (cause) {
      if (generation.current === request) {
        setResult(null);
        setError(
          cause instanceof Error
            ? cause.message
            : "We could not check your OpenRouter allowance.",
        );
      }
    } finally {
      if (generation.current === request) setChecking(false);
    }
  }, [apiKey, scope]);
  useEffect(() => {
    setResult(null);
    setOpened(false);
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (!opened) return;
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [opened, refresh]);
  async function credits() {
    const request = generation.current;
    try {
      await assertFirstJobScope(scope);
      await openUrl("https://openrouter.ai/settings/credits");
      await assertFirstJobScope(scope);
      if (generation.current === request) setOpened(true);
    } catch {
      if (generation.current === request)
        setError("OpenRouter did not open. Try again.");
    }
  }
  const matches =
    evidence.current?.apiKey === current.current.apiKey &&
    evidence.current?.owner === current.current.owner &&
    evidence.current?.relay === current.current.relay;
  const activeResult = matches ? result : null;
  const quota = activeResult?.status === "verified" ? activeResult.quota : null;
  const met = quota?.threshold_met === true;
  const below =
    activeResult?.status === "unpaid" || quota?.threshold_met === false;
  const shortfall = quota?.usd_to_threshold ?? 10;
  return (
    <section
      className="space-y-3 rounded-xl border border-border/60 p-4"
      data-testid="openrouter-allowance"
      aria-busy={checking}
    >
      <h3 className="font-semibold">Your free-model allowance</h3>
      {checking ? (
        <p role="status">Checking your OpenRouter account…</p>
      ) : error ? (
        <p role="status">Your OpenRouter allowance could not be verified.</p>
      ) : met ? (
        <p role="status">
          Eligible for 1,000 free-model requests a day. Your lifetime credit
          purchases meet OpenRouter’s $10 threshold.
        </p>
      ) : below ? (
        <>
          <p role="status">
            Your account currently has 50 free-model requests a day.
          </p>
          <p className="onb-simple-note">
            {quota
              ? "You have purchased $" +
                quota.total_credits_usd.toFixed(2) +
                " in total. "
              : ""}
            Buy {"$" + shortfall.toFixed(2)} more in OpenRouter credits to reach
            the current 1,000-request daily allowance. OpenRouter may add
            checkout fees.
          </p>
        </>
      ) : (
        <p role="status">
          Connected, but OpenRouter has not shared enough purchase history to
          verify the $10 threshold. Check your purchases on OpenRouter; you may
          already qualify.
        </p>
      )}
      {error && (
        <p className="onb-simple-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!met && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void credits()}
          >
            {below
              ? "Add credits on OpenRouter"
              : "Check purchases on OpenRouter"}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={checking}
          onClick={() => void refresh()}
        >
          Check again
        </Button>
      </div>
      <p className="onb-simple-note">
        20 requests a minute still applies. These limits are shared across your
        OpenRouter account. Credits stay in OpenRouter and are separate from
        Colony Credits.
      </p>
    </section>
  );
}
