import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAcpRuntimesQuery,
  useRuntimeFileConfigQuery,
} from "@/features/agents/hooks";
import { AgentConfigFields } from "@/features/agents/ui/AgentConfigFields";
import { globalAgentConfigQueryKey } from "@/features/agents/useGlobalAgentConfig";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";
import {
  getColonyCreditsAccount,
  formatNanousdAsUsd,
} from "@/shared/api/tauriProvisionedCredits";
import { scanAgentSubscriptions } from "@/shared/api/tauriSubscriptions";
import type { GlobalAgentConfig } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { getRelayWsUrl } from "@/shared/api/tauri";
import { assertFirstJobScope } from "../../../firstJobScope";
import { brainsFromRuntimes } from "../../../flow/track";
import {
  configForPowerLane,
  powerLaneForConfig,
  type PowerLane,
} from "../../../powerChoice";
import { resolveAgentReadiness } from "../../agentReadiness";
import { FounderLayout } from "../FounderLayout";
import { subscriptionTiles } from "./brainLanes";
import { CreditsModelFields } from "./CreditsModelFields";
import { FreeOpenRouterFields } from "./FreeOpenRouterFields";

/** Third founder step. Credentials live only in this mounted draft and native storage. */
export function PowerScreen({
  scopeKey,
  expectedOwnerPubkey,
  expectedRelayUrl,
  prepareScope,
  businessOnly,
  busy,
  error,
  onBack,
  onContinue,
}: {
  scopeKey: string;
  expectedOwnerPubkey?: string;
  expectedRelayUrl?: string;
  prepareScope?: (assertCurrent: () => void) => Promise<string>;
  businessOnly: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onContinue: (save: () => Promise<void>) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const runtimes = useAcpRuntimesQuery();
  const scope = useQuery({
    queryKey: ["onboarding-power-scope", scopeKey],
    queryFn: async ({ signal }) => {
      const assertCurrent = () => {
        if (signal.aborted) throw new Error("This setup run has ended");
      };
      const appliedRelay = await prepareScope?.(assertCurrent);
      assertCurrent();
      const identity = await getIdentity();
      const relayUrl =
        expectedRelayUrl ?? appliedRelay ?? (await getRelayWsUrl());
      const captured = {
        ownerPubkey: expectedOwnerPubkey ?? identity.pubkey,
        relayUrl,
      };
      await assertFirstJobScope(captured);
      return captured;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const saved = useQuery({
    queryKey: globalAgentConfigQueryKey,
    queryFn: getGlobalAgentConfig,
  });
  const scan = useQuery({
    queryKey: ["onboarding-subscriptions"],
    queryFn: scanAgentSubscriptions,
    retry: false,
  });
  const [draft, setDraft] = useState<GlobalAgentConfig | null>(null);
  const [lane, setLane] = useState<PowerLane | null>(null);
  const [valid, setValid] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [modelAttempt, setModelAttempt] = useState(0);
  const [customProvider, setCustomProvider] = useState(false);
  useEffect(() => {
    if (!saved.data || draft) return;
    const initialLane = powerLaneForConfig(saved.data);
    setLane(initialLane);
    setDraft(
      saved.data.preferred_runtime
        ? saved.data
        : configForPowerLane(saved.data, initialLane),
    );
  }, [saved.data, draft]);
  const runtime = runtimes.data?.find(
    (entry) => entry.id === draft?.preferred_runtime,
  );
  const runtimeFile = useRuntimeFileConfigQuery(runtime?.id ?? "");
  const credits = useQuery({
    queryKey: ["onboarding-credits-account", scopeKey],
    queryFn: getColonyCreditsAccount,
    enabled: lane === "colony" && scope.isSuccess,
    retry: false,
    staleTime: 0,
  });
  const subscriptions = subscriptionTiles(
    scan.data ?? null,
    brainsFromRuntimes(runtimes.data ?? []),
  );
  function selectLane(next: PowerLane, runtimeId?: string) {
    if (!draft) return;
    if (next === lane && (!runtimeId || runtimeId === draft.preferred_runtime))
      return;
    setValid(false);
    setCustomModel(false);
    setCustomProvider(false);
    setLane(next);
    setDraft(configForPowerLane(draft, next, runtimeId));
  }
  const subscriptionReady =
    !!draft &&
    resolveAgentReadiness(runtimes.data ?? [], draft, "preferred").ready;
  const canContinue =
    scope.isSuccess &&
    !!scope.data &&
    !!draft &&
    !!runtime &&
    !runtime.localLaunchError &&
    runtime.availability === "available" &&
    (lane === "subscription" ? subscriptionReady && valid : valid) &&
    (lane !== "colony" || credits.isSuccess);
  async function save() {
    if (
      !draft ||
      !scope.data ||
      !canContinue ||
      (lane !== "existing" && powerLaneForConfig(draft) !== lane)
    )
      throw new Error(
        "Choose a supported connection and model before continuing.",
      );
    await assertFirstJobScope(scope.data);
    const result = await setGlobalAgentConfig(draft, scope.data);
    await assertFirstJobScope(scope.data);
    queryClient.setQueryData(globalAgentConfigQueryKey, result.config);
    if (result.failed_restart_count > 0)
      throw new Error(
        "Your defaults were saved, but an existing teammate could not restart. Check Agents before continuing.",
      );
  }
  return (
    <FounderLayout step="power" businessOnly={businessOnly}>
      <div className="onb-simple-card" data-testid="onboarding-power-form">
        <div className="onb-simple-form-heading">
          <h2>Power your agents</h2>
          <p>
            Choose your default account and model for teammates on this
            computer.
          </p>
        </div>
        {saved.isLoading || runtimes.isLoading ? (
          <p role="status">Checking your connections…</p>
        ) : null}
        {saved.isError || runtimes.isError ? (
          <div role="alert">
            <p>We could not check your connections.</p>
            <Button
              variant="outline"
              onClick={() => {
                void saved.refetch();
                void runtimes.refetch();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {scope.isError && (
          <p role="alert" className="onb-simple-error">
            This account or business changed. Return to business setup and try
            again.
          </p>
        )}
        {draft && lane && (
          <fieldset disabled={busy || !scope.isSuccess} className="space-y-5">
            <div className="onb-power-lanes" aria-label="Ways to power agents">
              <button
                type="button"
                aria-pressed={lane === "subscription"}
                onClick={() => selectLane("subscription")}
              >
                <strong>Subscriptions</strong>
                <span>Use an account you already pay for.</span>
              </button>
              <button
                type="button"
                aria-pressed={lane === "colony"}
                onClick={() => selectLane("colony")}
              >
                <strong>Colony Credits</strong>
                <span>Pay for usage through Colony.</span>
              </button>
              <button
                type="button"
                aria-pressed={lane === "openrouter"}
                onClick={() => selectLane("openrouter")}
              >
                <strong>OpenRouter free models</strong>
                <span>Connect OpenRouter. Usage limits apply.</span>
              </button>
            </div>
            {powerLaneForConfig(saved.data ?? draft) === "existing" && (
              <Button
                variant="outline"
                onClick={() => {
                  if (lane === "existing") return;
                  setLane("existing");
                  setDraft(saved.data ?? draft);
                  setValid(false);
                }}
              >
                Keep my current setup
              </Button>
            )}
            {lane === "existing" && (
              <p className="onb-simple-note">
                Your existing provider settings are preserved. You can choose a
                different way to power agents above.
              </p>
            )}
            {lane === "subscription" && (
              <div className="space-y-3">
                <p className="onb-simple-note">
                  {scan.isPending
                    ? "Looking for subscriptions on this computer…"
                    : scan.isError
                      ? "Subscription detection could not finish. Available connections are shown below."
                      : "Choose a detected connection. Being installed does not always mean it is signed in."}
                </p>
                {subscriptions.map((entry) => {
                  const native = runtimes.data?.find(
                    (item) => item.id === entry.id,
                  );
                  return (
                    <div key={entry.id} className="onb-power-subscription">
                      <Button
                        variant="outline"
                        aria-pressed={draft.preferred_runtime === entry.id}
                        onClick={() => selectLane("subscription", entry.id)}
                      >
                        {entry.label}
                      </Button>
                      <p className="onb-simple-note">
                        {entry.pill}
                        {native?.localLaunchError
                          ? ` · ${native.localLaunchError}`
                          : ""}
                      </p>
                    </div>
                  );
                })}
                {!scan.isPending && subscriptions.length === 0 && (
                  <p>
                    No subscriptions found. Choose Colony Credits or connect
                    OpenRouter.
                  </p>
                )}
                <Button
                  variant="outline"
                  onClick={() => {
                    void scan.refetch();
                    void runtimes.refetch();
                  }}
                >
                  Check again
                </Button>
              </div>
            )}
            {lane === "colony" && (
              <div role="status" className="onb-simple-note">
                {credits.isPending
                  ? "Checking Colony Credits…"
                  : credits.isError
                    ? "Colony Credits is unavailable for this workspace. Choose another connection, or check again after the service is restored."
                    : credits.data
                      ? `${formatNanousdAsUsd(credits.data.available_balance_nanousd)} available. You can add credits before starting a job.`
                      : null}
                {credits.isError && (
                  <Button
                    variant="outline"
                    onClick={() => void credits.refetch()}
                  >
                    Check again
                  </Button>
                )}
              </div>
            )}
            {runtime?.localLaunchError ? (
              <p role="alert" className="onb-simple-error">
                {runtime.localLaunchError}
              </p>
            ) : (
              scope.isSuccess &&
              runtime &&
              (lane === "openrouter" ? (
                <FreeOpenRouterFields
                  key={`${lane}:${runtime.id}`}
                  config={draft}
                  runtime={runtime}
                  onChange={setDraft}
                  onValidityChange={setValid}
                />
              ) : lane === "colony" ? (
                credits.isSuccess && (
                  <CreditsModelFields
                    key={`${lane}:${runtime.id}:${credits.dataUpdatedAt}:${modelAttempt}`}
                    onRetry={() => setModelAttempt((value) => value + 1)}
                    config={draft}
                    runtime={runtime}
                    onChange={setDraft}
                    onValidityChange={setValid}
                  />
                )
              ) : (
                <AgentConfigFields
                  key={`${lane}:${runtime.id}`}
                  bakedEnv={[]}
                  config={draft}
                  selectedRuntime={runtime}
                  runtimeFileConfig={runtimeFile.data}
                  disclosure="onboarding-essential"
                  isCustomModelEditing={customModel}
                  isCustomProvider={customProvider}
                  onConfigChange={setDraft}
                  onCustomModelEditingChange={setCustomModel}
                  onIsCustomProviderChange={setCustomProvider}
                  onValidityChange={setValid}
                />
              ))
            )}
            {error && (
              <p className="onb-simple-error" role="alert">
                {error}
              </p>
            )}
            <Button
              className="onb-simple-button onb-simple-primary"
              disabled={!canContinue || busy}
              onClick={() => void onContinue(save)}
            >
              {busy ? "Opening your Colony…" : "Open my Colony"}
            </Button>
          </fieldset>
        )}
        <button
          type="button"
          className="onb-simple-link"
          disabled={busy}
          onClick={onBack}
        >
          Back to business
        </button>
      </div>
    </FounderLayout>
  );
}
