import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * How an open ask reached its current audience.
 *
 * Phase 2a made `buzz asks raise` default to the filer's manager, so an ask
 * addressed to that manager was not someone's explicit choice; and when a
 * deadline passes unanswered, the relay promotes the ask up the ladder by
 * signing a successor (new audience, `prior` tag naming the original,
 * `filer` tag carrying the original filer). None of that was visible to the
 * owner -- these helpers classify what the event stream already says.
 */

export type AskRouting =
  | {
      /** The relay filed a successor for this need at a higher rung. */
      kind: "promoted";
      priorAskId: string;
    }
  | {
      /** Addressed to the filer's resolved manager: the default route. */
      kind: "auto";
      audiencePubkey: string;
    }
  | {
      /** Addressed to anyone else: somebody chose this audience. */
      kind: "explicit";
      audiencePubkey: string;
    };

/**
 * The agent actually waiting on the answer. Across a promotion the ask
 * event itself is relay-signed, so `filerPubkey` names the relay; the
 * original filer rides in the `filer` tag.
 */
export function effectiveFilerPubkey(
  ask: Pick<OpenAsk, "filerPubkey" | "originalFilerPubkey">,
): string {
  return ask.originalFilerPubkey ?? ask.filerPubkey;
}

/**
 * Classify how an ask reached its audience, given the filer's manager as
 * the reporting-line records resolve it (null while unresolved or when the
 * filer reports to nobody). Promotion provenance wins over everything: a
 * promoted ask is by definition relay-routed, whatever it addresses.
 */
export function classifyAskRouting(
  ask: Pick<OpenAsk, "audiencePubkey" | "priorAskId"> & {
    originalFilerPubkey?: string | null;
    filerPubkey?: string;
  },
  filerManagerPubkey: string | null,
): AskRouting | null {
  if (ask.priorAskId) return { kind: "promoted", priorAskId: ask.priorAskId };
  if (!ask.audiencePubkey) return null;
  const audience = normalizePubkey(ask.audiencePubkey);
  if (
    filerManagerPubkey !== null &&
    normalizePubkey(filerManagerPubkey) === audience
  ) {
    return { kind: "auto", audiencePubkey: audience };
  }
  return { kind: "explicit", audiencePubkey: audience };
}

/** One short phrase for list surfaces; null says nothing worth a slot. */
export function askRoutingSummary(routing: AskRouting | null): string | null {
  switch (routing?.kind) {
    case "promoted":
      return "Promoted up the ladder";
    case "auto":
      return "Auto-routed to the filer's manager";
    case "explicit":
      return "Addressed directly";
    default:
      return null;
  }
}
