import {
  verifyAgentResponse,
  type AgentResponseProof,
} from "../../../verifyAgentResponse";
import { useEffect, useRef, useState } from "react";
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
import type { GlobalAgentConfig } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { getRelayWsUrl } from "@/shared/api/tauri";
import { assertFirstJobScope } from "../../../firstJobScope";
import {
  configForPowerLane,
  initialPowerConfig,
  powerLaneForConfig,
  type PowerLane,
} from "../../../powerChoice";
import { effectiveOnboardingRuntimeId } from "../../onboardingRuntimeSelection";
import { FounderLayout } from "../FounderLayout";
import { CreditsModelFields } from "./CreditsModelFields";
import { FreeOpenRouterFields } from "./FreeOpenRouterFields";
import { PowerCreditsPurchase } from "./PowerCreditsPurchase";
import { SubscriptionPowerFields } from "./SubscriptionPowerFields";

/** Third founder step. Credentials live only in this mounted draft and native storage. */
export function PowerScreen({
  scopeKey,
  expectedOwnerPubkey,
  receiptEmail,
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
  receiptEmail?: string;
  expectedRelayUrl?: string;
  prepareScope?: (assertCurrent: () => void) => Promise<string>;
  businessOnly: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onContinue: (proof: AgentResponseProof) => Promise<void>;
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
  const [draft, setDraft] = useState<GlobalAgentConfig | null>(null);
  const [lane, setLane] = useState<PowerLane | null>(null);
  const [valid, setValid] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [modelAttempt, setModelAttempt] = useState(0);
  const [customProvider, setCustomProvider] = useState(false);
  const [proof, setProof] = useState<AgentResponseProof | null>(null);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState("");
  const [testError, setTestError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every draft change invalidates response proof.
  useEffect(() => {
    setProof(null);
    setTestError(null);
    attempt.current?.abort();
  }, [draft]);
  async function testConnection() {
    if (attempt.current && !attempt.current.signal.aborted) return;
    const controller = new AbortController();
    attempt.current = controller;
    setTesting(true);
    setProof(null);
    setTestError(null);
    setTestStatus("Saving your connection…");
    try {
      await save();
      controller.signal.throwIfAborted();
      if (!scope.data) throw new Error("Your business connection changed.");
      const verified = await verifyAgentResponse(
        scope.data,
        controller.signal,
        setTestStatus,
      );
      if (!controller.signal.aborted) {
        setProof(verified);
        setTestStatus("Your agent replied");
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setTestError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        setTesting(false);
      }
    }
  }

  useEffect(() => {
    if (!saved.data || draft) return;
    const initialLane = powerLaneForConfig(saved.data);
    setLane(initialLane);
    setDraft(initialPowerConfig(saved.data));
  }, [saved.data, draft]);
  const runtime = runtimes.data?.find(
    (entry) =>
      !!draft &&
      entry.id ===
        (lane === "subscription"
          ? draft.preferred_runtime
          : effectiveOnboardingRuntimeId(draft.preferred_runtime)),
  );
  const runtimeFile = useRuntimeFileConfigQuery(runtime?.id ?? "");
  const credits = useQuery({
    queryKey: ["onboarding-credits-account", scopeKey],
    queryFn: async () => {
      if (!scope.data)
        throw new Error("Your business connection is not ready.");
      await assertFirstJobScope(scope.data);
      const account = await getColonyCreditsAccount();
      await assertFirstJobScope(scope.data);
      return account;
    },
    enabled: lane === "colony" && scope.isSuccess && !scope.isFetching,
    retry: false,
    staleTime: 0,
  });
  const creditsNeedsUpdate =
    lane === "colony" &&
    !!draft?.preferred_runtime &&
    draft.preferred_runtime !== "buzz-agent";
  function selectLane(next: PowerLane, runtimeId?: string) {
    if (!draft) return;
    if (
      next === lane &&
      !creditsNeedsUpdate &&
      (!runtimeId || runtimeId === draft.preferred_runtime)
    )
      return;
    setValid(false);
    setCustomModel(false);
    setCustomProvider(false);
    setLane(next);
    setDraft(configForPowerLane(draft, next, runtimeId));
  }
  const canContinue =
    scope.isSuccess &&
    !scope.isFetching &&
    !!scope.data &&
    !!draft &&
    powerLaneForConfig(draft) === lane &&
    !creditsNeedsUpdate &&
    !!runtime &&
    !runtime.localLaunchError &&
    runtime.availability === "available" &&
    valid &&
    (lane !== "colony" || credits.isSuccess);
  async function save() {
    if (
      !draft ||
      !scope.data ||
      !canContinue ||
      powerLaneForConfig(draft) !== lane
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
          <h2>Connect and test</h2>
          <p>Choose an account, then check that your agent responds.</p>
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
          <fieldset
            disabled={busy || testing || !scope.isSuccess || scope.isFetching}
            className="space-y-5"
          >
            <fieldset className="onb-power-lanes">
              <legend className="sr-only">Ways to power agents</legend>
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
            </fieldset>
            {saved.data && powerLaneForConfig(saved.data) === "existing" && (
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
            {lane === "subscription" && scope.data && (
              <SubscriptionPowerFields
                key={scopeKey}
                scope={scope.data}
                selectedRuntimeId={draft.preferred_runtime}
                selectedModel={draft.model}
                selectedEffort={draft.reasoning_effort}
                disabled={busy}
                onSelect={(runtimeId, model, reasoningEffort) => {
                  setValid(false);
                  setDraft({
                    ...configForPowerLane(draft, "subscription", runtimeId),
                    model,
                    reasoning_effort: reasoningEffort,
                  });
                }}
                onValidityChange={setValid}
              />
            )}
            {lane === "colony" && (
              <div role="status" className="onb-simple-note">
                {credits.isPending
                  ? "Checking Colony Credits…"
                  : credits.isError
                    ? "Colony Credits is unavailable for this workspace. Choose another connection, or check again after the service is restored."
                    : credits.data
                      ? `${formatNanousdAsUsd(credits.data.available_balance_nanousd)} available for your agents.`
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
            {creditsNeedsUpdate && (
              <div className="space-y-2" role="status">
                <p>
                  Your saved setup uses an older connection. Update it to use
                  Colony Credits here; your balance stays with this business.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => selectLane("colony")}
                >
                  Use Colony Credits
                </Button>
              </div>
            )}
            {lane === "colony" && scope.data && (
              <PowerCreditsPurchase
                key={scopeKey}
                scope={scope.data}
                receiptEmail={receiptEmail}
                onBalanceChanged={() => void credits.refetch()}
              />
            )}
            {lane !== "subscription" &&
              (runtime?.localLaunchError ? (
                <p role="alert" className="onb-simple-error">
                  {runtime.localLaunchError}
                </p>
              ) : (
                scope.isSuccess &&
                !scope.isFetching &&
                runtime &&
                (lane === "openrouter" ? (
                  <FreeOpenRouterFields
                    scope={scope.data}
                    key={`${lane}:${runtime.id}`}
                    config={draft}
                    runtime={runtime}
                    onChange={setDraft}
                    onValidityChange={setValid}
                  />
                ) : lane === "colony" ? (
                  !creditsNeedsUpdate &&
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
              ))}
            {error && (
              <p className="onb-simple-error" role="alert">
                {error}
              </p>
            )}
            <Button
              className="onb-simple-button onb-simple-primary"
              disabled={!canContinue || busy || testing}
              onClick={() => void testConnection()}
            >
              {proof
                ? "Test again"
                : testError
                  ? "Retry test"
                  : "Test connection"}
            </Button>
          </fieldset>
        )}
        {(testing || proof || testError) && (
          <div className="onb-response" aria-live="polite">
            {testing && (
              <>
                <p role="status">{testStatus}</p>
                <button
                  type="button"
                  className="onb-simple-link"
                  onClick={() => {
                    attempt.current?.abort();
                    setTesting(false);
                    setTestStatus("");
                  }}
                >
                  Cancel test
                </button>
              </>
            )}
            {testError && (
              <p role="alert" className="onb-simple-error">
                {testError}
              </p>
            )}
            {proof && (
              <>
                <strong>Your agent replied</strong>
                <p>{proof.reply}</p>
                <Button
                  className="onb-simple-button onb-simple-primary"
                  disabled={busy || testing}
                  onClick={() =>
                    void onContinue(proof).catch((cause) => {
                      setProof(null);
                      setTestError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    })
                  }
                >
                  Continue
                </Button>
              </>
            )}
          </div>
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
