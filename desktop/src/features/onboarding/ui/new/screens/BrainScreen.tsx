// desktop/src/features/onboarding/ui/new/screens/BrainScreen.tsx
import { useEffect, useMemo, useState } from "react";

import {
  useAcpAuthMethodsQuery,
  useAcpRuntimesQuery,
  useConnectAcpRuntimeMutation,
  useInstallAcpRuntimeMutation,
} from "@/features/agents/hooks";
import { getOnboardingAuthMethods } from "@/features/onboarding/ui/onboardingRuntimeSelection";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { getInstallErrorMessage } from "@/shared/lib/installError";
import { Button } from "@/shared/ui/button";
import { brainsFromRuntimes, type BrainCandidate } from "../../../flow/track";

type Props = {
  /** Every brain Colony knows about, as probing last saw them. */
  brains: BrainCandidate[];
  selected: string | null;
  onSelect: (id: string) => void;
  onContinue: () => void;
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

/** How long to keep polling the catalog after a sign-in is handed to a browser. */
const SIGN_IN_POLL_MS = 2_000;
const SIGN_IN_TIMEOUT_MS = 120_000;

/**
 * Screen 5a: the one place a founder says who does the thinking.
 *
 * It used to be a picker over what was already ready, with the machine flow's
 * "Find the brains on this computer" and "Choose the brain your agents think
 * with" screens in front of it asking the same thing in developer vocabulary.
 * Those are gone, so the installing and signing in they owned happen here,
 * against the row someone actually wants rather than against a grid of every
 * harness Colony knows.
 *
 * The list is live: an install or a sign-in changes a row's status under the
 * cursor, which is the whole reason it derives from the runtimes query rather
 * than rendering the snapshot probing handed down.
 */
export function BrainScreen({ brains, selected, onSelect, onContinue }: Props) {
  const runtimesQuery = useAcpRuntimesQuery();
  // Probing's snapshot paints the first frame; the query owns every frame
  // after it, so an install lands without a round trip through the flow.
  const live = useMemo(
    () =>
      runtimesQuery.data ? brainsFromRuntimes(runtimesQuery.data) : brains,
    [brains, runtimesQuery.data],
  );
  const byId = useMemo(
    () => new Map(runtimesQuery.data?.map((r) => [r.id, r]) ?? []),
    [runtimesQuery.data],
  );

  const selectedIsReady = live.some(
    (brain) => brain.id === selected && brain.status === "ready",
  );
  const anyReady = live.some((brain) => brain.status === "ready");

  // A row someone just made ready is the row they were reaching for. Selecting
  // it saves a click that otherwise reads as the install not having worked.
  const [claimed, setClaimed] = useState<string | null>(null);
  useEffect(() => {
    if (!claimed) return;
    const row = live.find((brain) => brain.id === claimed);
    if (row?.status === "ready") {
      onSelect(claimed);
      setClaimed(null);
    }
  }, [claimed, live, onSelect]);

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Pick who does the <em>thinking</em>.
        </h1>
        <p className="onb-sub">
          {anyReady
            ? "Your agents need a brain to think with. Colony runs one for you, or sign in with a subscription you already pay for, like Claude Code or Codex."
            : "Your agents need a brain to think with. Colony can set one up for you."}
        </p>
      </div>
      <div className="onb-options" role="listbox" aria-label="Your agents">
        {live.map((brain) => (
          <BrainRow
            brain={brain}
            key={brain.id}
            onClaim={setClaimed}
            onSelect={onSelect}
            runtime={byId.get(brain.id)}
            selected={selected === brain.id}
          />
        ))}
      </div>
      <div className="onb-actions">
        <Button
          data-testid="onboarding-brain-continue"
          disabled={!selectedIsReady}
          onClick={onContinue}
          size="lg"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function BrainRow({
  brain,
  onClaim,
  onSelect,
  runtime,
  selected,
}: {
  brain: BrainCandidate;
  onClaim: (id: string) => void;
  onSelect: (id: string) => void;
  runtime: AcpRuntimeCatalogEntry | undefined;
  selected: boolean;
}) {
  const ready = brain.status === "ready";

  return (
    <div className="onb-option-row" data-status={brain.status}>
      <button
        aria-selected={selected}
        className="onb-option"
        data-selected={selected}
        data-status={brain.status}
        data-testid={`onboarding-brain-${brain.id}`}
        // Everything is listed so the set reads as a choice, but only a brain
        // that can actually think is selectable. The action beside an
        // unselectable row is what turns it into one.
        disabled={!ready}
        onClick={() => onSelect(brain.id)}
        role="option"
        type="button"
      >
        <span className="onb-pulse" />
        <span>
          <span className="onb-option__title">{brain.label}</span>
          <span className="onb-option__meta">{STATUS_COPY[brain.status]}</span>
        </span>
      </button>
      {ready ? null : (
        <BrainRowAction brain={brain} onClaim={onClaim} runtime={runtime} />
      )}
    </div>
  );
}

/**
 * The install or sign-in beside a row that cannot think yet.
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
