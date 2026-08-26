import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { readAsk } from "@/features/asks/lib/askEvent";
import {
  askStatesFromEvents,
  describeAskExpiry,
} from "@/features/asks/lib/askState";
import {
  classifyAskRouting,
  effectiveFilerPubkey,
} from "@/features/asks/lib/askRouting";
import { useReportingLineLookup } from "@/features/agents/reportingLine";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { relayClient } from "@/shared/api/relayClient";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import { KIND_ASK, KIND_ASK_STATE } from "@/shared/constants/kinds";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

type AskDetailCardProps = {
  ask: OpenAsk;
  onAnswer: (decision: string, rationale: string) => Promise<void>;
  isSubmitting: boolean;
};

/**
 * How an ask reached the person reading it: who it is addressed to, whether
 * that was the filer's manager by default or somebody's explicit choice, and
 * when the relay promoted it up the ladder, that it moved and from whom.
 *
 * Everything here reads the event stream itself -- the `p` tag, and the
 * `prior`/`filer` pair only the relay's promotions carry. Deadlines are
 * deliberately absent: they live in the relay's asks table alone today.
 */
function AskRoutingNote({ ask }: { ask: OpenAsk }): React.JSX.Element | null {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const { isSettled, lookup } = useReportingLineLookup(communityId);
  const routing = classifyAskRouting(
    ask,
    // An unsettled payroll must not read as "explicit choice": hold the
    // auto-vs-explicit judgment until the reporting-line reads finish.
    isSettled ? lookup(effectiveFilerPubkey(ask)).managerPubkey : null,
  );

  const priorAskId = routing?.kind === "promoted" ? routing.priorAskId : null;
  const priorQuery = useQuery({
    enabled: priorAskId !== null,
    queryKey: ["open-ask-prior", communityId, priorAskId],
    queryFn: async () => {
      const events = await relayClient.fetchEvents({
        ids: priorAskId ? [priorAskId] : [],
        kinds: [KIND_ASK],
        limit: 1,
      });
      return events[0] ?? null;
    },
    staleTime: 30_000,
  });
  const priorAsk = priorQuery.data ? readAsk(priorQuery.data) : null;

  const labelPubkeys = [ask.audiencePubkey, priorAsk?.audiencePubkey].flatMap(
    (pubkey) => (pubkey ? [pubkey] : []),
  );
  const labelsQuery = useUsersBatchQuery(labelPubkeys, {
    enabled: labelPubkeys.length > 0,
  });
  const labelFor = (pubkey: string) =>
    labelsQuery.data?.profiles[normalizePubkey(pubkey)]?.displayName?.trim() ||
    truncatePubkey(normalizePubkey(pubkey));

  if (!routing) return null;

  return (
    <div
      className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-4 text-muted-foreground"
      data-testid="ask-routing"
    >
      {routing.kind === "promoted" ? (
        <span data-testid="ask-routing-promoted">
          Promoted up the ladder by the relay
          {priorAsk?.audiencePubkey
            ? ` · was addressed to ${labelFor(priorAsk.audiencePubkey)}`
            : ""}
        </span>
      ) : null}
      {routing.kind === "auto" ? (
        <span data-testid="ask-routing-auto">
          Auto-routed to {labelFor(routing.audiencePubkey)}, the filer's manager
        </span>
      ) : null}
      {routing.kind === "explicit" ? (
        <span data-testid="ask-routing-explicit">
          Addressed directly to {labelFor(routing.audiencePubkey)}
        </span>
      ) : null}
    </div>
  );
}

/** Wall-clock seconds, re-read on a coarse tick so a countdown does not stall. */
function useNowSeconds(intervalMs = 30_000): number {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1_000));
  React.useEffect(() => {
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1_000)),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * What the relay will do about this ask when its deadline passes, read from
 * the relay-signed ask-state head (kind 30200).
 *
 * This exists mainly for the asks it CANNOT decide. NIP-IQ's hard list
 * forbids a default answer on `spend`, `hiring`, `legal` and the rest, so a
 * fan-out approval expires to a re-arm: the relay pushes the deadline out and
 * waits again, indefinitely. That is the correct behaviour and it is not
 * going to change, which is exactly why it has to be on screen — otherwise a
 * campaign sits parked behind an ask the owner assumes will time out into a
 * decision, and nothing anywhere says it will not.
 *
 * Renders nothing at all when the head is missing, unreadable, or not signed
 * by this relay: an absent countdown is honest, an invented one is not.
 */
function AskExpiryNote({ ask }: { ask: OpenAsk }): React.JSX.Element | null {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const relaySelfPubkey = useRelaySelfQuery().data;
  const nowSeconds = useNowSeconds();

  const stateQuery = useQuery({
    enabled: communityId !== "",
    queryKey: ["ask-state-head", communityId, ask.id],
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_ASK_STATE],
        "#d": [ask.id],
        limit: 4,
      }),
    staleTime: 15_000,
  });

  const state = React.useMemo(
    () =>
      askStatesFromEvents(stateQuery.data ?? [], relaySelfPubkey).get(ask.id) ??
      null,
    [ask.id, relaySelfPubkey, stateQuery.data],
  );
  if (state === null) return null;

  const sentence = describeAskExpiry(state, ask.createdAt, nowSeconds);
  if (sentence === null) return null;

  return (
    <p
      className="text-xs leading-4 text-muted-foreground"
      data-testid="ask-expiry-note"
    >
      {sentence}
    </p>
  );
}

/**
 * The card the founder answers an ask from.
 *
 * `ask_broker` already accepts an owner answering by replying in the thread;
 * this is the other half it was written against, so a founder does not have
 * to find the thread to unblock somebody.
 */
export function AskDetailCard({
  ask,
  onAnswer,
  isSubmitting,
}: AskDetailCardProps): React.JSX.Element {
  const [decision, setDecision] = React.useState("");
  const [rationale, setRationale] = React.useState("");
  const canSubmit = decision.trim().length > 0 && !isSubmitting;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="ask-detail-card">
      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
          Ask · {ask.askType}
        </span>
        <h2 className="text-base font-medium text-foreground">
          {ask.headline}
        </h2>
        {ask.costOfDelay ? (
          <p className="text-sm text-muted-foreground">
            Waiting costs: {ask.costOfDelay}
          </p>
        ) : null}
        <AskRoutingNote ask={ask} />
        <AskExpiryNote ask={ask} />
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Your answer</span>
        <textarea
          className="min-h-24 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="ask-answer-decision"
          onChange={(event) => setDecision(event.target.value)}
          placeholder="What you decided."
          value={decision}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Why (optional)</span>
        <textarea
          className="min-h-16 rounded-md border border-border bg-background p-2 text-sm outline-none"
          data-testid="ask-answer-rationale"
          onChange={(event) => setRationale(event.target.value)}
          placeholder="Reasoning the agent should carry forward."
          value={rationale}
        />
      </label>

      <button
        className="self-start rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        data-testid="ask-answer-submit"
        disabled={!canSubmit}
        onClick={() => void onAnswer(decision.trim(), rationale.trim())}
        type="button"
      >
        {isSubmitting ? "Sending…" : "Answer and unblock"}
      </button>
    </div>
  );
}
