/**
 * The claim verifier: what stands behind each assertion, checked live.
 *
 * The record model (`contracts.ts`, mirroring `buzz-core/src/content.rs`)
 * already expresses where a claim's evidence lives and the hash of the source
 * text at verification time. Nothing ever fetched it. This module is the
 * missing implementation:
 *
 * - `page` sources are fetched and compared now, in this process. The app is a
 *   browser, so this is a local HTTP request: no credits, no inference, no
 *   cost to Colony or the customer.
 * - `repo` sources are fetch-verifiable in principle and **manual at launch**:
 *   the typed source is recorded, nothing fetches it yet.
 * - `owner` sources verify by signature AND authorship against the named
 *   event, never by fetch. Reading the named event back proves the signature
 *   (the relay stores only signature-valid events); checking its signer
 *   against the workspace's owner pubkeys proves it was the owner who said
 *   so, not an agent signing its own sign-off. The same line
 *   `content.rs` draws between post and decision: the author of a card must
 *   not be able to write its own approval.
 * - `derived` claims never auto-pass, honouring `ClaimKind`'s contract in
 *   `buzz-core`. A derived claim needs a person, whatever its source says.
 *
 * Staleness is not failure. A source whose text no longer hashes to
 * `source_hash` makes the claim STALE: it was true when checked and the ground
 * has since moved. That is a different customer message from "unverified",
 * and it gets a different state here.
 *
 * Strictness is the customer's setting (brand kit kind 30198,
 * `rules.claim_strictness`, default strict). Under strict an unverified or
 * stale claim stops the render before it happens; under advisory the card
 * renders and the failing claims surface as warnings on the day detail. This
 * module computes verdicts and the gate outcome; it never reads the setting
 * itself, so the caller decides what a fail does.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { RelayEvent } from "@/shared/api/types";

import type { ClaimSource, ContentClaim } from "./contracts";
import { bareSha256 } from "./contracts";

/** How harshly the claim gate treats a claim it cannot confirm. */
export type ClaimStrictness = "strict" | "advisory";

/**
 * The five states a claim can be in, checked against its source right now.
 *
 * `verified` carries the moment of the check so the UI can say "verified 2h
 * ago" rather than a bare tick. `manual` means a person is the evidence: repo
 * sources at launch, and every derived claim forever.
 */
export type ClaimVerdict =
  | { state: "verified"; checkedAt: number; sourceHash: string }
  | { state: "stale"; reason: string }
  | { state: "unverified"; reason: string }
  | { state: "manual"; reason: string }
  | { state: "owner-signed"; event: string };

/** The states a strict gate lets through. */
export function verdictPassesGate(verdict: ClaimVerdict): boolean {
  return (
    verdict.state === "verified" ||
    verdict.state === "owner-signed" ||
    verdict.state === "manual"
  );
}

/** Everything the verifier needs from the outside world. */
export type VerifierDependencies = {
  /** GET a claim's page URL and return the raw HTML. Throws on failure. */
  fetchPageHtml: (url: string) => Promise<string>;
  /**
   * Read one event back from the relay by id, or null when it cannot be
   * found. The relay only stores signature-valid events, so a hit proves the
   * event is signed; authorship is checked separately against `isOwnerPubkey`.
   */
  fetchEventById: (eventId: string) => Promise<RelayEvent | null>;
  /**
   * Whether a pubkey is a workspace owner. Sourced from the community's
   * membership snapshot (`communityOwners.ts`), never from anything on the
   * claim. An empty or still-loading set must answer false for everyone:
   * fail closed.
   */
  isOwnerPubkey: (pubkey: string) => boolean;
  /** Now, in milliseconds. Injectable so tests pin time. */
  now?: () => number;
  /**
   * DOMParser for selector isolation. Injectable because the node test
   * runner has no DOM one; the app passes nothing and gets the webview's.
   */
  parser?: DOMParser;
};

/** Collapse every whitespace run to one space and trim the ends. */
export function normalizeSourceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** SHA-256 of the normalized source text, bare lowercase hex. */
export function hashSourceText(text: string): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(normalizeSourceText(text))),
  );
}

/**
 * Isolate the supporting text out of a fetched page.
 *
 * With a selector, the first matching element's text is the source. Without
 * one, the whole page's visible text is. `parser` is injectable because the
 * node test runner has no `DOMParser`; the app passes nothing and gets the
 * webview's own.
 *
 * A selector that matches nothing is an error rather than an empty string:
 * an empty source would hash to the empty hash and read as "source changed",
 * which would tell the customer the ground moved when really the page did.
 */
export function isolateSourceText(
  html: string,
  selector: string | null,
  parser: DOMParser = defaultParser(),
): string {
  const document = parser.parseFromString(html, "text/html");
  if (!selector) {
    return document.body?.textContent ?? "";
  }
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`selector matched nothing: ${selector}`);
  }
  return element.textContent ?? "";
}

function defaultParser(): DOMParser {
  const found = globalThis.DOMParser;
  if (!found) {
    throw new Error("no DOMParser available; inject one");
  }
  return new found();
}

/** Verify one claim against its source, right now. */
export async function verifyClaim(
  claim: ContentClaim,
  dependencies: VerifierDependencies,
): Promise<ClaimVerdict> {
  const source = claim.source;
  if (!source) {
    return {
      reason:
        "Nothing backs this claim. Do not publish it until something does.",
      state: "unverified",
    };
  }

  // ClaimKind's contract in buzz-core: derived never auto-passes. Whatever
  // the source shows, the published words are not the source's words, so a
  // person has to stand behind the rewording.
  if (claim.kind === "derived") {
    return {
      reason:
        "Derived claims never auto-pass. A person must confirm the rewording is fair.",
      state: "manual",
    };
  }

  if (source.type === "owner") {
    const event = await dependencies.fetchEventById(source.event);
    if (!event) {
      return {
        reason: `The signed event backing this claim could not be read (${source.event.slice(0, 12)}…).`,
        state: "unverified",
      };
    }
    if (!dependencies.isOwnerPubkey(event.pubkey)) {
      return {
        reason:
          "This claim points at a signed event, but its signer is not a workspace owner. An agent signed its own sign-off; that is a forged attribution, not a source.",
        state: "unverified",
      };
    }
    return { event: source.event, state: "owner-signed" };
  }

  if (source.type === "repo") {
    return {
      reason:
        "Repo sources are recorded, not fetched, at launch. Verified by hand when the source was registered.",
      state: "manual",
    };
  }

  return verifyPageClaim(claim, source, dependencies);
}

async function verifyPageClaim(
  claim: ContentClaim,
  source: Extract<ClaimSource, { type: "page" }>,
  dependencies: VerifierDependencies,
): Promise<ClaimVerdict> {
  let html: string;
  try {
    html = await dependencies.fetchPageHtml(source.url);
  } catch (error) {
    return {
      reason: `The source page could not be fetched: ${errorMessage(error)}`,
      state: "unverified",
    };
  }

  let sourceText: string;
  try {
    sourceText = isolateSourceText(html, source.selector, dependencies.parser);
  } catch (error) {
    return {
      reason: `The source page no longer matches: ${errorMessage(error)}`,
      state: "stale",
    };
  }

  if (!claim.sourceHash) {
    return {
      reason:
        "The page is reachable, but this claim has never been verified: no source hash was recorded.",
      state: "unverified",
    };
  }

  const fetchedHash = hashSourceText(sourceText);
  if (fetchedHash === bareSha256(claim.sourceHash)) {
    return {
      checkedAt: (dependencies.now ?? Date.now)(),
      sourceHash: fetchedHash,
      state: "verified",
    };
  }
  return {
    reason:
      "The source changed after this claim was verified. It was true when checked; the ground has moved.",
    state: "stale",
  };
}

/** Verify every claim on a post, keyed by claim id. */
export async function verifyClaims(
  claims: ContentClaim[],
  dependencies: VerifierDependencies,
): Promise<Record<string, ClaimVerdict>> {
  const entries = await Promise.all(
    claims.map(
      async (claim) =>
        [claim.id, await verifyClaim(claim, dependencies)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** What the claim gate adds up to for one post. */
export type ClaimGateOutcome = {
  /** `fail` blocks the render; `pass` lets it happen. */
  status: "pass" | "fail";
  /** Claim ids that failed, when strict. */
  blocked: string[];
  /** Human sentences for every claim that did not clear, any mode. */
  warnings: string[];
};

/**
 * The pre-render claim gate.
 *
 * Strict (the default): any unverified or stale claim stops the render before
 * it happens. Advisory: the render proceeds and the failures ride along as
 * warnings for the day detail. Manual and owner-signed claims pass in both
 * modes: the first is evidence recorded by a person, the second is the
 * owner's own signature.
 */
export function evaluateClaimGate(
  claims: ContentClaim[],
  verdicts: Record<string, ClaimVerdict>,
  strictness: ClaimStrictness,
): ClaimGateOutcome {
  const blocked: string[] = [];
  const warnings: string[] = [];
  for (const claim of claims) {
    const verdict = verdicts[claim.id];
    if (verdict && verdictPassesGate(verdict)) {
      continue;
    }
    const reason =
      verdict?.state === "stale" || verdict?.state === "unverified"
        ? verdict.reason
        : "This claim has not been checked against its source.";
    warnings.push(`"${claim.asserts}": ${reason}`);
    blocked.push(claim.id);
  }
  return {
    blocked,
    status: strictness === "strict" && blocked.length > 0 ? "fail" : "pass",
    warnings,
  };
}

/**
 * The gate report entry for the claims gate, shaped for `GateResult`.
 *
 * Ticket 5's render pipeline calls `verifyClaims` then `evaluateClaimGate`
 * before rendering anything, and attaches this to the report. Under advisory
 * a failing claim set still renders, so the gate reports `pass` with the
 * warnings carried in `detail` where the day detail can show them.
 */
export function claimGateResult(outcome: ClaimGateOutcome): {
  bar: number;
  detail: string;
  id: "claims";
  measured: unknown;
  status: "pass" | "fail";
} {
  return {
    bar: outcome.blocked.length === 0 ? 0 : outcome.blocked.length,
    detail:
      outcome.warnings.length > 0
        ? outcome.warnings.join(" ")
        : "Every claim checked against its source.",
    id: "claims",
    measured: {
      blocked: outcome.blocked,
      warnings: outcome.warnings,
    },
    status: outcome.status,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
