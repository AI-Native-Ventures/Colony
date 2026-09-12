import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { acpRuntimesQueryKey } from "@/features/agents/hooks";
import { useInstallOutputLine } from "@/features/agents/lib/useInstallOutputLine";
import {
  connectSubscription,
  getSubscriptionConnections,
  installSubscriptionRuntime,
  type SubscriptionAccount,
  type SubscriptionScope,
} from "@/shared/api/tauriSubscriptionConnections";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@/shared/api/nativeBridge";
import {
  subscriptionConnectionReady,
  subscriptionEffortAllowed,
  subscriptionExhausted,
  subscriptionModelDefaultEffort,
  subscriptionModelEfforts,
} from "../../../subscriptionConnectionState";

/** Provider accounts remain native-owned; this view receives only public metadata. */
export function SubscriptionPowerFields({
  scope,
  selectedRuntimeId,
  selectedModel,
  selectedEffort,
  onSelect,
  onValidityChange,
  disabled,
}: {
  scope: SubscriptionScope;
  selectedRuntimeId: string | null | undefined;
  selectedModel: string | null | undefined;
  selectedEffort?: string | null;
  /** `effort` is null for "let the provider decide", never an empty string. */
  onSelect: (runtimeId: string, modelId: string, effort: string | null) => void;
  onValidityChange: (valid: boolean) => void;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef<SubscriptionScope | null>(null);
  useEffect(() => {
    generation.current = {
      ownerPubkey: scope.ownerPubkey,
      relayUrl: scope.relayUrl,
    };
    setConnecting(null);
    setInstalling(null);
    setNotice(null);
    setError(null);
    return () => {
      generation.current = null;
    };
  }, [scope.ownerPubkey, scope.relayUrl]);
  const query = useQuery({
    queryKey: ["subscription-connections", scope.ownerPubkey, scope.relayUrl],
    queryFn: () => getSubscriptionConnections(scope),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const selected = query.data?.find(
    (entry) => entry.runtimeId === selectedRuntimeId,
  );
  const valid =
    !query.isFetching &&
    !query.isError &&
    !connecting &&
    !installing &&
    subscriptionConnectionReady(
      selected,
      selectedModel,
      Date.now() / 1000,
      selectedEffort,
    );
  useEffect(() => {
    onValidityChange(!!valid);
  }, [valid, onValidityChange]);
  const efforts = subscriptionModelEfforts(selected, selectedModel);
  const providerDefaultEffort = subscriptionModelDefaultEffort(
    selected,
    selectedModel,
  );
  // A saved effort can name something the model in front of the owner does not
  // offer: the lists differ per model, and a config written for another model
  // survives the switch. Fall back to this model's own default rather than
  // leaving a choice on screen that the bridge would refuse at startup.
  const staleEffort =
    !!selectedRuntimeId &&
    !!selectedModel &&
    !subscriptionEffortAllowed(selected, selectedModel, selectedEffort);
  useEffect(() => {
    if (!staleEffort || !selectedRuntimeId || !selectedModel) return;
    onSelect(selectedRuntimeId, selectedModel, providerDefaultEffort);
  }, [
    staleEffort,
    selectedRuntimeId,
    selectedModel,
    providerDefaultEffort,
    onSelect,
  ]);
  const locked =
    disabled || query.isFetching || connecting !== null || installing !== null;

  async function connect(runtimeId: string) {
    const started = generation.current;
    setConnecting(runtimeId);
    setError(null);
    try {
      await connectSubscription(runtimeId, scope);
      if (generation.current !== started) return;
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: acpRuntimesQueryKey }),
      ]);
    } catch (cause) {
      if (generation.current === started)
        setError(
          cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : "Sign-in did not finish. Try again.",
        );
    } finally {
      if (generation.current === started) setConnecting(null);
    }
  }

  async function install(runtimeId: string) {
    const started = generation.current;
    if (!started) return;
    setInstalling(runtimeId);
    setError(null);
    setNotice(null);
    try {
      const result = await installSubscriptionRuntime(runtimeId, started);
      if (generation.current !== started) return;
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: acpRuntimesQueryKey }),
      ]);
      if (generation.current !== started) return;
      if (result.success) {
        setNotice(
          "Installed. Select the provider above to connect your subscription.",
        );
      } else {
        const failure = result.steps.find((step) => !step.success);
        setError(
          [failure?.stderr, failure?.hint].filter(Boolean).join(" ") ||
            "Installation did not finish. Try again or open the official guide.",
        );
      }
    } catch (cause) {
      if (generation.current === started)
        setError(
          cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : "Installation did not finish. Try again.",
        );
    } finally {
      if (generation.current === started) setInstalling(null);
    }
  }

  async function installationGuide(runtimeId: string) {
    const started = generation.current;
    try {
      await openUrl(
        runtimeId === "claude"
          ? "https://code.claude.com/docs/en/setup"
          : "https://learn.chatgpt.com/docs/codex/cli",
      );
    } catch {
      if (generation.current === started)
        setError(
          "We could not open the provider’s installation guide. Try again.",
        );
    }
  }

  return (
    <section
      className="space-y-4"
      aria-label="Your subscriptions"
      data-testid="subscription-power-fields"
    >
      <p className="onb-simple-note">
        We can find accounts on this Mac. Connect one to use it securely in
        Colony; sign-in stays with the provider. Your teammates share that
        account’s limits.
      </p>
      {query.isFetching && (
        <p role="status">Checking accounts, models and usage…</p>
      )}
      {query.isError && (
        <p role="alert">We could not check your subscriptions. Try again.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="onb-simple-error">
          {error}
        </p>
      )}
      <div className="space-y-3">
        {query.data?.map((entry) => {
          const connected = entry.connected.authentication === "subscription";
          const detected = entry.detected.authentication === "subscription";
          const chosen = entry.runtimeId === selectedRuntimeId;
          const account = connected ? entry.connected : entry.detected;
          return (
            <div
              key={entry.runtimeId}
              className="rounded-xl border border-border p-4 space-y-3"
            >
              <button
                type="button"
                aria-pressed={chosen}
                disabled={locked || !entry.installed}
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => {
                  if (!chosen) onSelect(entry.runtimeId, "", null);
                }}
              >
                <strong>
                  {entry.label}
                  {account.planLabel ? ` · ${account.planLabel}` : ""}
                </strong>
                <span className="text-sm text-muted-foreground">
                  {connected
                    ? "Connected"
                    : detected
                      ? "Found on this Mac"
                      : entry.installed
                        ? "Not connected"
                        : "Not installed"}
                </span>
              </button>
              {(!entry.installed || entry.launchError) && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {!entry.installed
                      ? entry.canInstall
                        ? "Downloads the provider’s app onto this Mac. You’ll sign in separately; no teammates will start."
                        : "Install the provider’s command-line app using its official guide, then check again here."
                      : "If this provider needs an update, follow its official guide and check again here."}
                  </p>
                  {!entry.installed && entry.canInstall && (
                    <Button
                      type="button"
                      disabled={locked}
                      onClick={() => void install(entry.runtimeId)}
                    >
                      {installing === entry.runtimeId
                        ? "Installing…"
                        : entry.runtimeId === "claude"
                          ? "Install Claude Code"
                          : "Install Codex"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={locked}
                    onClick={() => void installationGuide(entry.runtimeId)}
                  >
                    {entry.installed
                      ? "Install or update guide"
                      : "Open installation guide"}
                  </Button>
                </div>
              )}
              <SubscriptionInstallProgress
                runtimeId={entry.runtimeId}
                active={installing === entry.runtimeId}
              />
              {entry.installed && <SubscriptionUsage account={account} />}
              {account.notice && (
                <p className="text-sm text-muted-foreground">
                  {account.notice}
                </p>
              )}
              {chosen && (
                <>
                  {entry.launchError && (
                    <p role="alert" className="onb-simple-error">
                      {entry.launchError}
                    </p>
                  )}
                  {!connected && (
                    <>
                      {account.authentication === "api_key" && (
                        <p className="text-sm">
                          This app is using an API key. Sign in with your
                          subscription to use this option.
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={locked}
                        onClick={() => void connect(entry.runtimeId)}
                      >
                        {connecting === entry.runtimeId
                          ? "Finish sign-in in your browser…"
                          : `Connect ${entry.label}`}
                      </Button>
                    </>
                  )}
                  {connected && (
                    <>
                      <label className="block space-y-2">
                        <span className="text-sm font-medium">Model</span>
                        <select
                          aria-label="Subscription model"
                          className="w-full rounded-lg border border-input bg-background px-3 py-2"
                          value={selectedModel ?? ""}
                          disabled={locked}
                          onChange={(event) =>
                            // Changing the model re-derives the effort: the new
                            // model has its own list and its own default, and
                            // carrying the old choice over could name an effort
                            // it does not offer.
                            onSelect(
                              entry.runtimeId,
                              event.target.value,
                              subscriptionModelDefaultEffort(
                                entry,
                                event.target.value,
                              ),
                            )
                          }
                        >
                          <option value="">Choose a model</option>
                          {entry.connected.models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                            </option>
                          ))}
                        </select>
                        {!entry.connected.models.length && (
                          <p className="text-sm">
                            The provider did not return available models. Check
                            again before continuing.
                          </p>
                        )}
                      </label>
                      {/* Only the efforts this model advertises, so a model with
                          no effort axis shows no control instead of an empty one. */}
                      {!!efforts.length && (
                        <label className="block space-y-2">
                          <span className="text-sm font-medium">Reasoning</span>
                          <select
                            aria-label="Reasoning effort"
                            className="w-full rounded-lg border border-input bg-background px-3 py-2"
                            value={selectedEffort ?? ""}
                            disabled={locked}
                            onChange={(event) =>
                              onSelect(
                                entry.runtimeId,
                                selectedModel ?? "",
                                event.target.value || null,
                              )
                            }
                          >
                            <option value="">
                              {providerDefaultEffort
                                ? `${providerDefaultEffort} · this model's default`
                                : "The provider decides"}
                            </option>
                            {efforts.map((option) => (
                              <option key={option.effort} value={option.effort}>
                                {option.description
                                  ? `${option.effort} · ${option.description}`
                                  : option.effort}
                              </option>
                            ))}
                          </select>
                          <p className="text-sm text-muted-foreground">
                            Higher reasoning uses more of this account's
                            allowance for every task your teammates do.
                          </p>
                        </label>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={locked}
        onClick={() => void query.refetch()}
      >
        Check again
      </Button>
    </section>
  );
}

function SubscriptionUsage({ account }: { account: SubscriptionAccount }) {
  if (account.authentication !== "subscription") return null;
  if (account.measurementStatus === "unavailable" || !account.windows.length)
    return (
      <p className="text-sm text-muted-foreground">
        Usage unavailable. This does not mean your allowance is empty.
      </p>
    );
  return (
    <div className="space-y-2 text-sm">
      {account.measurementStatus !== "live" && (
        <p>Last reported usage · {account.measurementStatus}</p>
      )}
      {account.windows.map((window) => (
        <div key={window.id}>
          <div className="flex flex-wrap justify-between gap-x-3">
            <span>
              {window.label}
              {window.durationMinutes
                ? ` · ${formatWindow(window.durationMinutes)}`
                : ""}
            </span>
            <span>{Math.round(100 - window.usedPercent)}% left</span>
          </div>
          <progress
            aria-label={`${window.label} remaining`}
            value={100 - window.usedPercent}
            max={100}
            className="h-1.5 w-full accent-primary"
          />
          {window.resetsAt !== null && (
            <p className="text-xs text-muted-foreground">
              Resets {new Date(window.resetsAt * 1000).toLocaleString()}
            </p>
          )}
        </div>
      ))}
      {subscriptionExhausted(account, Date.now() / 1000) && (
        <p role="status">
          Allowance used up. Wait for the reset or choose another connection.
        </p>
      )}
      {account.capturedAt !== null && (
        <p className="text-xs text-muted-foreground">
          Checked {new Date(account.capturedAt * 1000).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function formatWindow(minutes: number) {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  return minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
}

function SubscriptionInstallProgress({
  runtimeId,
  active,
}: {
  runtimeId: string;
  active: boolean;
}) {
  const line = useInstallOutputLine(runtimeId, active);
  return active ? (
    <p role="status" className="text-sm text-muted-foreground">
      {line || "Downloading and installing the provider app…"}
    </p>
  ) : null;
}
