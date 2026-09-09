import { verifyEvent } from "nostr-tools/pure";
import {
  canonicalCompanyJson,
  COMMUNITY_PROFILE_ID,
  type CompanyProfile,
} from "@/features/company/contracts";
import type {
  CompanyActionOutcome,
  CompanyReceipt,
} from "@/features/company/workRepository";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_COMPANY_ACTION,
  KIND_COMPANY_PROFILE,
} from "@/shared/constants/kinds";
import {
  canStartFirstJobSuggestion,
  firstJobSuggestionTag,
  parseFirstJobSuggestion,
  type FirstJobSuggestion,
} from "./firstJobSuggestion";
import {
  firstJobScopeKey,
  snapshotFirstJobScope,
  type FirstJobScope,
} from "./firstJobStart";
import {
  BUSINESS_SUMMARY_MAX_LENGTH,
  businessTextLength,
} from "./businessContextLimits";

/** A stable UUID claim for this owner/community/root; retries on another device share it. */
export async function firstJobBusinessRequestId(
  scope: FirstJobScope,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `colony:first-job-business:v1:${firstJobScopeKey(scope)}`,
      ),
    ),
  );
  digest[6] = ((digest[6] ?? 0) & 15) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 63) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The first-job card can link to business details without parsing error copy. */
export class FirstJobBusinessRepair extends Error {
  readonly code = "first-job-business-repair";
}

function verified(event: RelayEvent): boolean {
  // Reconstruct public fields: spreading a previously verified nostr event also
  // copies its cached verification symbol, which can hide a modified signature.
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
    sig: event.sig ?? "",
  });
}

/** The relay's unconfigured predicate deliberately excludes name and budgets. */
export function isUnconfiguredFirstJobBusiness(
  profile: CompanyProfile,
): boolean {
  return (
    profile.summary.trim() === "" &&
    profile.services.length === 0 &&
    profile.customerSegments.length === 0 &&
    profile.website === null
  );
}

/** Authenticate the original setup root before using its public business answers. */
export function validateFirstJobSuggestionRoot(
  scope: FirstJobScope,
  payload: FirstJobSuggestion,
  root: RelayEvent | null,
): void {
  const parsed = parseFirstJobSuggestion([firstJobSuggestionTag(payload)]);
  if (
    !parsed ||
    !root ||
    root.id !== scope.threadRootId ||
    payload.requestId !== scope.requestId ||
    canonicalCompanyJson(parseFirstJobSuggestion(root.tags)) !==
      canonicalCompanyJson(parsed) ||
    !canStartFirstJobSuggestion(
      { ...root, signerPubkey: root.pubkey },
      scope,
    ) ||
    !verified(root)
  ) {
    throw new Error(
      "This setup could not be verified. Reopen its original Welcome thread and try again.",
    );
  }
}

/** Relay-authored profile plus its compare-and-set event identity. */
export type FirstJobBusinessHead = {
  profile: CompanyProfile;
  headEventId: string;
};
/** One signed public action, retained before it can reach the relay. */
export type FirstJobBusinessAttempt = {
  payload: FirstJobSuggestion;
  relayPubkey: string;
  expectedHeadEventId: string;
  profile: CompanyProfile;
  action: RelayEvent;
};

/** Reject damaged or substituted persisted actions, including their profile CAS. */
export function isFirstJobBusinessAttempt(
  value: unknown,
): value is FirstJobBusinessAttempt {
  try {
    const item = value as FirstJobBusinessAttempt;
    const payload = parseFirstJobSuggestion([
      firstJobSuggestionTag(item.payload),
    ]);
    const action = item.action;
    const body = JSON.parse(action.content);
    const target = `${KIND_COMPANY_PROFILE}:${item.relayPubkey}:${COMMUNITY_PROFILE_ID}`;
    const tuple = action.tags.filter((tag) => tag[0] === "company-action");
    return (
      !!payload &&
      /^[a-f0-9]{64}$/.test(item.relayPubkey) &&
      /^[a-f0-9]{64}$/.test(item.expectedHeadEventId) &&
      action.kind === KIND_COMPANY_ACTION &&
      action.pubkey === payload.ownerPubkey &&
      action.tags.length === 3 &&
      tuple.length === 1 &&
      tuple[0]?.[1] === "1" &&
      tuple[0]?.[2] === "update" &&
      tuple[0]?.[3] === body.requestId &&
      tuple[0]?.[4] === body.idempotencyKey &&
      action.tags.some(
        (tag) =>
          tag.length === 2 && tag[0] === "p" && tag[1] === item.relayPubkey,
      ) &&
      action.tags.some(
        (tag) => tag.length === 2 && tag[0] === "a" && tag[1] === target,
      ) &&
      body.schema === "colony.company-action/v1" &&
      body.operation === "update" &&
      body.target === target &&
      body.expectedHead === item.expectedHeadEventId &&
      Array.isArray(body.expectedReferences) &&
      body.expectedReferences.length === 0 &&
      body.payload?.kind === "company" &&
      canonicalCompanyJson(body.payload.record) ===
        canonicalCompanyJson(item.profile) &&
      verified(action)
    );
  } catch {
    return false;
  }
}

/** Existing scoped signing, company receipts and durable first-job storage seams. */
export type FirstJobBusinessDependencies = {
  assertCurrent(scope: FirstJobScope): Promise<void>;
  assertRoot(scope: FirstJobScope, payload: FirstJobSuggestion): Promise<void>;
  withLock<T>(scope: FirstJobScope, work: () => Promise<T>): Promise<T>;
  read(scope: FirstJobScope): FirstJobBusinessAttempt | null;
  write(scope: FirstJobScope, attempt: FirstJobBusinessAttempt): void;
  relaySelf(scope: FirstJobScope): Promise<string>;
  loadHead(
    scope: FirstJobScope,
    relayPubkey: string,
  ): Promise<FirstJobBusinessHead>;
  sign(
    scope: FirstJobScope,
    input: {
      profile: CompanyProfile;
      expectedHeadEventId: string;
      relayPubkey: string;
      requestId: string;
    },
  ): Promise<RelayEvent>;
  readReceipt(
    scope: FirstJobScope,
    attempt: FirstJobBusinessAttempt,
  ): Promise<CompanyReceipt | null>;
  submit(
    scope: FirstJobScope,
    attempt: FirstJobBusinessAttempt,
  ): Promise<CompanyActionOutcome>;
  now(): number;
  requestId(scope: FirstJobScope): Promise<string>;
  delay(ms: number): Promise<void>;
};

/** Keep canonical business context without changing a configured or concurrent winner. */
export function createFirstJobBusinessContext(
  deps: FirstJobBusinessDependencies,
) {
  return async (
    inputScope: FirstJobScope,
    inputPayload: FirstJobSuggestion,
  ): Promise<void> => {
    const scope = snapshotFirstJobScope(inputScope);
    const payload = parseFirstJobSuggestion([
      firstJobSuggestionTag(inputPayload),
    ]);
    if (
      !payload ||
      payload.ownerPubkey !== scope.ownerPubkey ||
      payload.relayUrl !== scope.relayUrl ||
      payload.channelId !== scope.channelId ||
      payload.requestId !== scope.requestId
    )
      throw new Error(
        "The business details belong to another setup. Reopen the original thread.",
      );
    const current = async <T>(operation: () => Promise<T>) => {
      await deps.assertCurrent(scope);
      const result = await operation();
      await deps.assertCurrent(scope);
      return result;
    };
    await current(() => deps.assertRoot(scope, payload));
    await deps.withLock(scope, async () => {
      await deps.assertCurrent(scope);
      let attempt = deps.read(scope);
      if (
        attempt &&
        (!isFirstJobBusinessAttempt(attempt) ||
          canonicalCompanyJson(attempt.payload) !==
            canonicalCompanyJson(payload))
      )
        throw new Error(
          "The saved business setup does not match this thread. Review Company settings before continuing.",
        );
      const requestId = await current(() => deps.requestId(scope));
      if (
        attempt &&
        attempt.action.tags.find((tag) => tag[0] === "company-action")?.[3] !==
          requestId
      )
        throw new Error(
          "This saved business update belongs to another thread. Reopen the original setup.",
        );
      const relayPubkey = await current(() => deps.relaySelf(scope));
      if (attempt && attempt.relayPubkey !== relayPubkey)
        throw new Error(
          "This business connection changed. Reopen the original business to continue.",
        );
      let head = await current(() => deps.loadHead(scope, relayPubkey));
      // The existing owner/agent profile always wins, including one written
      // while a previous attempt's receipt was lost.
      if (!isUnconfiguredFirstJobBusiness(head.profile)) return;
      if (!attempt) {
        if (
          businessTextLength(payload.business.trim()) >
          BUSINESS_SUMMARY_MAX_LENGTH
        )
          throw new FirstJobBusinessRepair(
            "This saved description is too long. Open Settings → Company and save a shorter business summary, then return here to start this job.",
          );
        if (!payload.business.trim() && !payload.website)
          throw new FirstJobBusinessRepair(
            "Open Settings → Company and describe your business, then return here to start this job.",
          );
        const label = new URL(scope.relayUrl).hostname.split(".")[0] || "";
        const characters = Array.from(label);
        const defaultName = characters.length
          ? `${characters[0]?.toUpperCase()}${characters.slice(1).join("")}`
          : "Workspace";
        const untouchedName =
          head.profile.updatedAt === head.profile.createdAt &&
          head.profile.tradingName === defaultName;
        const profile: CompanyProfile = {
          ...head.profile,
          tradingName: untouchedName
            ? payload.businessName.trim()
            : head.profile.tradingName,
          summary: payload.business.trim(),
          website: payload.website || null,
          updatedAt: Math.max(
            head.profile.updatedAt,
            Math.floor(deps.now() / 1000),
          ),
        };
        const action = await current(() =>
          deps.sign(scope, {
            profile,
            expectedHeadEventId: head.headEventId,
            relayPubkey,
            requestId,
          }),
        );
        attempt = {
          payload,
          relayPubkey,
          expectedHeadEventId: head.headEventId,
          profile,
          action,
        };
        if (!isFirstJobBusinessAttempt(attempt))
          throw new Error(
            "The business update could not be verified. Nothing was sent.",
          );
        // Storage failure stops here: there is no uncertain publication to lose.
        deps.write(scope, attempt);
      }
      const saved = attempt;
      let receipt = await current(() => deps.readReceipt(scope, saved));
      if (!receipt) {
        try {
          await current(() => deps.submit(scope, saved));
        } catch (error) {
          receipt = await current(() => deps.readReceipt(scope, saved));
          if (!receipt) throw error;
        }
        receipt ??= await current(() => deps.readReceipt(scope, saved));
      }
      // A broker publish/OK or unsigned local status is never proof of a save.
      if (!receipt)
        throw new Error(
          "Your business update is awaiting confirmation. Try again to check the same saved update.",
        );
      for (let retry = 0; retry < 5; retry += 1) {
        head = await current(() => deps.loadHead(scope, relayPubkey));
        if (!isUnconfiguredFirstJobBusiness(head.profile)) return;
        if (head.headEventId !== saved.expectedHeadEventId) break;
        if (receipt.outcome !== "applied") break;
        if (retry < 4) await current(() => deps.delay(150 * 2 ** retry));
      }
      // Never rebase a stale whole-profile snapshot. A newer but still empty
      // profile may contain owner edits to names or cost centres.
      if (receipt.outcome === "applied")
        throw new Error(
          "Your business update was received but is not visible yet. Try again to check it.",
        );
      throw new FirstJobBusinessRepair(
        "Your company details changed before setup finished. Open Settings → Company and review them, then return to this job.",
      );
    });
  };
}
