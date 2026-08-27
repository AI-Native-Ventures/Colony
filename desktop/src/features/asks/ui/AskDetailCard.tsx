import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type { AskAnswerInput } from "@/features/asks/answerAsk";
import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { readAsk } from "@/features/asks/lib/askEvent";
import { readAskOptions } from "@/features/asks/lib/askOptions";
import {
  classifyAskRouting,
  effectiveFilerPubkey,
} from "@/features/asks/lib/askRouting";
import { AskDeadlineNote } from "@/features/asks/ui/AskDeadlineNote";
import { AskOptionList } from "@/features/asks/ui/AskOptionList";
import { useAskState } from "@/features/asks/useAskStates";
import { useReportingLineLookup } from "@/features/agents/reportingLine";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_ASK } from "@/shared/constants/kinds";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

type AskDetailCardProps = {
  ask: OpenAsk;
  onAnswer: (answer: AskAnswerInput) => Promise<void>;
  isSubmitting: boolean;
};

/**
 * How an ask reached the person reading it: who it is addressed to, whether
 * that was the filer's manager by default or somebody's explicit choice, and
 * when the relay promoted it up the ladder, that it moved and from whom.
 *
 * Everything here reads the event stream itself -- the `p` tag, and the
 * `prior`/`filer` pair only the relay's promotions carry. The deadline is a
 * separate read: it lives on the relay-signed ask-state head (kind 30200),
 * see `AskDeadlineNote`.
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

/**
 * The card the founder answers an ask from.
 *
 * `ask_broker` already accepts an owner answering by replying in the thread;
 * this is the other half it was written against, so a founder does not have
 * to find the thread to unblock somebody.
 *
 * Two shapes, decided by the ask's own content. An ask that states `options`
 * is a pick-one: the choices render with their consequences and the free-text
 * box drops to an optional rationale. An ask with no options keeps the
 * free-text answer box as the only input, exactly as before.
 */
export function AskDetailCard({
  ask,
  onAnswer,
  isSubmitting,
}: AskDetailCardProps): React.JSX.Element {
  const [decision, setDecision] = React.useState("");
  const [rationale, setRationale] = React.useState("");
  const [selectedOption, setSelectedOption] = React.useState<string | null>(
    null,
  );
  const askState = useAskState(ask.id);

  const { options } = React.useMemo(
    () => readAskOptions(ask.rawContent),
    [ask.rawContent],
  );
  const hasOptions = options.length > 0;

  // Selection belongs to one ask. Moving to another must not carry a stale
  // pick across, which would otherwise let a click on "Answer and unblock"
  // publish the previous ask's option against this one. Reset during render
  // (React's documented "adjusting state when a prop changes" pattern) rather
  // than in an effect, so the new ask never paints for a frame wearing the
  // previous one's answer.
  const [answeringAskId, setAnsweringAskId] = React.useState(ask.id);
  if (answeringAskId !== ask.id) {
    setAnsweringAskId(ask.id);
    setSelectedOption(null);
    setDecision("");
    setRationale("");
  }

  const canSubmit = hasOptions
    ? selectedOption !== null && !isSubmitting
    : decision.trim().length > 0 && !isSubmitting;

  const submit = () => {
    void onAnswer({
      decision: hasOptions ? (selectedOption ?? "") : decision.trim(),
      optionLabel: hasOptions ? selectedOption : null,
      rationale: rationale.trim(),
    });
  };

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
        <AskDeadlineNote
          askCreatedAt={ask.createdAt}
          error={askState.error}
          isLoading={askState.isLoading}
          state={askState.state}
        />
      </div>

      {hasOptions ? (
        <AskOptionList
          disabled={isSubmitting}
          onSelect={setSelectedOption}
          options={options}
          selectedLabel={selectedOption}
        />
      ) : (
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
      )}

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
        onClick={submit}
        type="button"
      >
        {isSubmitting ? "Sending…" : "Answer and unblock"}
      </button>
    </div>
  );
}
