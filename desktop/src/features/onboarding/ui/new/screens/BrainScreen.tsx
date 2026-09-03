// desktop/src/features/onboarding/ui/new/screens/BrainScreen.tsx
import { useEffect, useMemo, useState } from "react";

import {
  useAcpAuthMethodsQuery,
  useAcpRuntimesQuery,
  useConnectAcpRuntimeMutation,
  useInstallAcpRuntimeMutation,
} from "@/features/agents/hooks";
import { getOnboardingAuthMethods } from "@/features/onboarding/ui/onboardingRuntimeSelection";
import { RuntimeIcon } from "@/features/onboarding/ui/RuntimeIcon";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import type { SubscriptionScan } from "@/shared/api/tauriSubscriptions";
import { getInstallErrorMessage } from "@/shared/lib/installError";
import { Button } from "@/shared/ui/button";
import { brainsFromRuntimes, type BrainCandidate } from "../../../flow/track";
import {
  COLONY_BRAIN_ID,
  defaultBrainId,
  defaultReason,
  isOpenRouterKey,
  laneForBrain,
  NO_SUBSCRIPTIONS_COPY,
  OPENROUTER_BRAIN_ID,
  subscriptionTiles,
} from "./brainLanes";

type Props = {
  /** Every brain Colony knows about, as probing last saw them. */
  brains: BrainCandidate[];
  /** Result of `scan_agent_subscriptions`, or null while it is still running. */
  scan?: SubscriptionScan | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onContinue: () => void;
  /** The OpenRouter key, when the flow holds it for the continue handler. */
  openRouterKey?: string;
  onOpenRouterKeyChange?: (key: string) => void;
};

/**
 * What each status says to someone who has never installed a developer tool.
 * Never the runtime's own vocabulary, never an instruction they cannot follow
 * from this screen.
 */
const STATUS_COPY: Record<BrainCandidate["status"], string> = {
  ready: "Ready to go",
  "needs-login": "Found, sign in with your subscription",
  "not-installed": "Not on this computer yet",
};

/**
 * A catalog entry for a brain the runtimes query has not handed back yet.
 *
 * `RuntimeIcon` keys its logo off the id alone, so the snapshot probing
 * handed down is enough to paint the first frame with the right mark rather
 * than a placeholder that swaps a moment later.
 */
function iconRuntime(
  id: string,
  label: string,
  runtime: AcpRuntimeCatalogEntry | undefined,
): AcpRuntimeCatalogEntry {
  return runtime ?? ({ id, label } as AcpRuntimeCatalogEntry);
}

/** How long to keep polling the catalog after a sign-in is handed to a browser. */
const SIGN_IN_POLL_MS = 2_000;
const SIGN_IN_TIMEOUT_MS = 120_000;

/**
 * Screen 5a: the one place a founder says who pays for the thinking.
 *
 * It used to be one grid of every harness Colony knows about, which answered
 * "what is on this computer" instead. Those are different questions, and the
 * owner's is the second one: it should find the subscriptions they already
 * pay for, show what is left on each, and offer the two ways of paying that
 * do not need one. So the column is three named sections rather than one
 * list, and all three are always on screen: someone who has never heard of
 * OpenRouter cannot tell these are alternatives to one another if any of them
 * is hidden behind a disclosure.
 *
 * The subscriptions section is live: a sign-in started from the strip under
 * the grid changes its tile, which is why the tiles read the runtimes query
 * as well as the one-shot scan.
 */
export function BrainScreen({
  brains,
  scan = null,
  selected,
  onSelect,
  onContinue,
  openRouterKey,
  onOpenRouterKeyChange,
}: Props) {
  const runtimesQuery = useAcpRuntimesQuery();
  // Probing's snapshot paints the first frame; the query owns every frame
  // after it, so a sign-in lands without a round trip through the flow.
  const live = useMemo(
    () =>
      runtimesQuery.data ? brainsFromRuntimes(runtimesQuery.data) : brains,
    [brains, runtimesQuery.data],
  );
  const byId = useMemo(
    () => new Map(runtimesQuery.data?.map((r) => [r.id, r]) ?? []),
    [runtimesQuery.data],
  );
  const tiles = useMemo(() => subscriptionTiles(scan, live), [scan, live]);

  const [localKey, setLocalKey] = useState("");
  const key = openRouterKey ?? localKey;
  const handleKeyChange = (next: string) => {
    setLocalKey(next);
    onOpenRouterKeyChange?.(next);
  };

  const chosen = selected ?? defaultBrainId(scan);
  const lane = laneForBrain(chosen);
  const chosenTile = tiles.find((tile) => tile.id === chosen) ?? null;
  const colonyLabel =
    live.find((brain) => brain.id === COLONY_BRAIN_ID)?.label ?? "Colony Agent";

  // A subscription someone just signed into is the one they were reaching for.
  // Selecting it saves a click that otherwise reads as the sign-in not having
  // worked.
  const [claimed, setClaimed] = useState<string | null>(null);
  useEffect(() => {
    if (!claimed) return;
    const row = live.find((brain) => brain.id === claimed);
    if (row?.status === "ready") {
      onSelect(claimed);
      setClaimed(null);
    }
  }, [claimed, live, onSelect]);

  const canContinue =
    lane === "colony"
      ? true
      : lane === "openrouter"
        ? isOpenRouterKey(key)
        : chosenTile?.status === "ready";

  const claimedBrain = live.find((brain) => brain.id === chosen) ?? null;

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Pick who does the <em>thinking</em>.
        </h1>
        <p className="onb-sub">{defaultReason(scan)}</p>
      </div>
      <div aria-label="Your agents" className="onb-lanes" role="listbox">
        <section
          aria-label="Your subscriptions"
          className="onb-lane"
          data-testid="onboarding-brain-lane-subscription"
        >
          <div className="onb-label">Your subscriptions</div>
          {tiles.length > 0 ? (
            <div className="onb-options onb-options--tiles">
              {tiles.map((tile) => (
                <BrainTile
                  id={tile.id}
                  key={tile.id}
                  label={tile.label}
                  onSelect={onSelect}
                  pill={tile.pill}
                  runtime={byId.get(tile.id)}
                  selected={chosen === tile.id}
                  status={tile.status}
                />
              ))}
            </div>
          ) : (
            <p className="onb-note">{NO_SUBSCRIPTIONS_COPY}</p>
          )}
        </section>

        <section
          aria-label="Colony Agent"
          className="onb-lane"
          data-testid="onboarding-brain-lane-colony"
        >
          <div className="onb-label">Colony Agent</div>
          <div className="onb-options onb-options--tiles">
            <BrainTile
              id={COLONY_BRAIN_ID}
              label={colonyLabel}
              onSelect={onSelect}
              pill="Pay with credits"
              runtime={byId.get(COLONY_BRAIN_ID)}
              selected={chosen === COLONY_BRAIN_ID}
              status="ready"
            />
          </div>
        </section>

        <section
          aria-label="OpenRouter"
          className="onb-lane"
          data-testid="onboarding-brain-lane-openrouter"
        >
          <div className="onb-label">OpenRouter</div>
          <div className="onb-options onb-options--tiles">
            <BrainTile
              id={OPENROUTER_BRAIN_ID}
              label="OpenRouter"
              onSelect={onSelect}
              pill="Your own key"
              runtime={byId.get(OPENROUTER_BRAIN_ID)}
              selected={chosen === OPENROUTER_BRAIN_ID}
              status="ready"
            />
          </div>
        </section>
      </div>

      {lane === "openrouter" ? (
        // The key belongs under the grid for the same reason the sign-in does:
        // it is the one thing left to do, and it belongs to the pick rather
        // than to every tile on screen.
        <div className="onb-option-strip" data-status="needs-key">
          <label className="onb-field onb-field--key">
            <span className="onb-label">OpenRouter API key</span>
            <input
              autoComplete="off"
              data-testid="onboarding-openrouter-key"
              onChange={(event) => handleKeyChange(event.target.value)}
              placeholder="sk-or-..."
              spellCheck={false}
              type="password"
              value={key}
            />
            <span className="onb-note">
              Billed by OpenRouter. Colony never sees your card.
            </span>
          </label>
        </div>
      ) : chosenTile?.status === "needs-login" ? (
        // One strip under the grid rather than an action inside every tile:
        // only the one belonging to the pick is ever the next thing to do.
        <div className="onb-option-strip" data-status="needs-login">
          <p className="onb-option__meta">{STATUS_COPY["needs-login"]}</p>
          {claimedBrain ? (
            <BrainRowAction
              brain={claimedBrain}
              key={claimedBrain.id}
              onClaim={setClaimed}
              runtime={byId.get(claimedBrain.id)}
            />
          ) : null}
        </div>
      ) : null}

      <div className="onb-actions">
        <Button
          data-testid="onboarding-brain-continue"
          disabled={!canContinue}
          onClick={onContinue}
          size="lg"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function BrainTile({
  id,
  label,
  onSelect,
  pill,
  runtime,
  selected,
  status,
}: {
  id: string;
  label: string;
  onSelect: (id: string) => void;
  pill: string;
  runtime: AcpRuntimeCatalogEntry | undefined;
  selected: boolean;
  status: "ready" | "needs-login";
}) {
  return (
    <button
      aria-selected={selected}
      className="onb-option onb-option--tile"
      data-selected={selected}
      data-status={status}
      data-testid={`onboarding-brain-${id}`}
      // Every tile picks, including one that cannot think yet: picking it is
      // how someone asks for the sign-in that makes it usable, and Continue
      // stays shut until the pick is actually ready.
      onClick={() => onSelect(id)}
      role="option"
      type="button"
    >
      <RuntimeIcon
        className="onb-option__logo"
        runtime={iconRuntime(id, label, runtime)}
      />
      <span className="onb-option__title">{label}</span>
      <span className="onb-option__pill">{pill}</span>
    </button>
  );
}

/**
 * The sign-in under a grid whose pick cannot think yet.
 *
 * Each row owns its own mutation instance: react-query v5 fires per-mutate
 * callbacks only for the latest `mutate()` on a shared instance, so two
 * concurrent installs on one instance silently drop the first one's result.
 */
function BrainRowAction({
  brain,
  onClaim,
  runtime,
}: {
  brain: BrainCandidate;
  onClaim: (id: string) => void;
  runtime: AcpRuntimeCatalogEntry | undefined;
}) {
  const installMutation = useInstallAcpRuntimeMutation();
  const connectMutation = useConnectAcpRuntimeMutation();
  const runtimesQuery = useAcpRuntimesQuery();
  const needsLogin = brain.status === "needs-login";
  const methodsQuery = useAcpAuthMethodsQuery(brain.id, {
    enabled: needsLogin,
  });
  const [error, setError] = useState<string | null>(null);
  const [isWaitingForSignIn, setIsWaitingForSignIn] = useState(false);
  const [didSignInCheckTimeOut, setDidSignInCheckTimeOut] = useState(false);

  // Sign-in completes in a browser, so nothing calls back into the app. The
  // catalog is polled until it reports the runtime signed in, then stops;
  // without the timeout an abandoned sign-in polls until the flow unmounts.
  useEffect(() => {
    if (!isWaitingForSignIn) return;
    const interval = window.setInterval(() => {
      void runtimesQuery.refetch();
    }, SIGN_IN_POLL_MS);
    const timeout = window.setTimeout(() => {
      setIsWaitingForSignIn(false);
      setDidSignInCheckTimeOut(true);
    }, SIGN_IN_TIMEOUT_MS);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [isWaitingForSignIn, runtimesQuery.refetch]);

  useEffect(() => {
    if (isWaitingForSignIn && !needsLogin) setIsWaitingForSignIn(false);
  }, [isWaitingForSignIn, needsLogin]);

  const authMethod =
    getOnboardingAuthMethods(runtime, methodsQuery.data?.methods ?? [])[0] ??
    null;

  function handleInstall() {
    setError(null);
    onClaim(brain.id);
    installMutation.mutate(brain.id, {
      onSuccess: (result) => {
        if (!result.success) setError(getInstallErrorMessage(result));
      },
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : "Install failed.");
      },
    });
  }

  function handleSignIn() {
    setError(null);
    if (didSignInCheckTimeOut) {
      setDidSignInCheckTimeOut(false);
      setIsWaitingForSignIn(true);
      void runtimesQuery.refetch();
      return;
    }
    if (!authMethod) {
      void methodsQuery.refetch();
      return;
    }
    onClaim(brain.id);
    connectMutation.mutate(
      { methodId: authMethod.id, runtimeId: brain.id },
      {
        onSuccess: () => setIsWaitingForSignIn(true),
        onError: (cause) => {
          setError(
            cause instanceof Error ? cause.message : "Sign-in failed to start.",
          );
        },
      },
    );
  }

  const busy = installMutation.isPending || connectMutation.isPending;
  const label = needsLogin
    ? isWaitingForSignIn
      ? "Checking…"
      : didSignInCheckTimeOut
        ? "Check again"
        : "Sign in"
    : installMutation.isPending
      ? "Installing…"
      : "Install";

  return (
    <div className="onb-option-action">
      <button
        className="onb-quiet-action"
        data-testid={`onboarding-brain-action-${brain.id}`}
        disabled={busy}
        onClick={needsLogin ? handleSignIn : handleInstall}
        type="button"
      >
        {label}
      </button>
      {error ? (
        <p
          className="onb-note-warn"
          data-testid={`onboarding-brain-error-${brain.id}`}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
