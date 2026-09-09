import { createCompanyRepository } from "@/features/company/companyRepository";
import {
  createCompanyActionBroker,
  parseCompanyReceipt,
} from "@/features/company/workRepository";
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { signCommunityProfileUpdate } from "@/shared/api/companyProfileEdit";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_COMPANY_RECEIPT } from "@/shared/constants/kinds";
import { createFirstJobBrowserStore } from "./firstJobBrowserStore";
import {
  createFirstJobBusinessContext,
  firstJobBusinessRequestId,
  isFirstJobBusinessAttempt,
  validateFirstJobSuggestionRoot,
} from "./firstJobBusinessContextController";
import { assertFirstJobScope } from "./firstJobScope";
import { snapshotFirstJobScope, type FirstJobScope } from "./firstJobStart";
import {
  firstJobSuggestionTag,
  parseFirstJobSuggestion,
  type FirstJobSuggestion,
} from "./firstJobSuggestion";

const store = createFirstJobBrowserStore(
  "business-context",
  isFirstJobBusinessAttempt,
);
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function current<T>(
  scope: FirstJobScope,
  operation: () => Promise<T>,
): Promise<T> {
  await assertFirstJobScope(scope);
  const result = await operation();
  await assertFirstJobScope(scope);
  return result;
}

/** Shared authority check for profile retention and explicit team approval. */
export async function assertFirstJobSuggestionRoot(
  input: FirstJobScope,
  payload: FirstJobSuggestion,
): Promise<void> {
  const scope = snapshotFirstJobScope(input);
  const details = parseFirstJobSuggestion([firstJobSuggestionTag(payload)]);
  if (!details)
    throw new Error(
      "This setup could not be verified. Reopen its original Welcome thread.",
    );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const root = await current(scope, () =>
      relayClient.fetchFirstEvent({
        ids: [scope.threadRootId],
        kinds: [9],
        authors: [scope.ownerPubkey],
        "#h": [scope.channelId],
        limit: 1,
      }),
    );
    if (root || attempt === 4) {
      validateFirstJobSuggestionRoot(scope, details, root);
      return;
    }
    await current(scope, () => delay(150 * 2 ** attempt));
  }
}

/** Retain reviewed setup through the ordinary signed company action and receipt path. */
export const ensureFirstJobBusinessContext = createFirstJobBusinessContext({
  assertCurrent: assertFirstJobScope,
  assertRoot: assertFirstJobSuggestionRoot,
  withLock: store.withLock,
  read: store.read,
  write: store.write,
  async relaySelf(scope) {
    const key = await current(scope, getRelaySelf);
    if (!key)
      throw new Error("Your business connection is not ready. Try again.");
    return key;
  },
  async loadHead(scope, relayPubkey) {
    const repository = createCompanyRepository({
      relaySelf: () => current(scope, async () => relayPubkey),
      fetchEvents: (filter) =>
        current(scope, () => relayClient.fetchEvents(filter)),
    });
    const result = await current(scope, () =>
      repository.getActiveCompanyHead(),
    );
    if (!result.ok)
      throw new Error(
        "Your company profile could not be read. Your setup is saved; try again.",
      );
    return result.value;
  },
  async sign(scope, input) {
    return JSON.parse(
      await signCommunityProfileUpdate({
        ...input,
        expectedOwnerPubkey: scope.ownerPubkey,
        expectedRelayUrl: scope.relayUrl,
      }),
    ) as RelayEvent;
  },
  async readReceipt(scope, attempt) {
    const action = attempt.action;
    const event = await current(scope, () =>
      relayClient.fetchFirstEvent({
        kinds: [KIND_COMPANY_RECEIPT],
        authors: [attempt.relayPubkey],
        "#e": [action.id],
        limit: 1,
      }),
    );
    const receipt =
      event && parseCompanyReceipt(event, attempt.relayPubkey, action.id);
    const tuple = action.tags.find((tag) => tag[0] === "company-action");
    const recipients = event?.tags.filter((tag) => tag[0] === "p");
    return receipt &&
      receipt.requestId === tuple?.[3]?.toLowerCase() &&
      receipt.idempotencyKey === tuple?.[4]?.toLowerCase() &&
      receipt.target === action.tags.find((tag) => tag[0] === "a")?.[1] &&
      recipients?.length === 1 &&
      recipients[0]?.[1] === scope.ownerPubkey
      ? receipt
      : null;
  },
  submit(scope, attempt) {
    return createCompanyActionBroker({
      relaySelf: () => current(scope, async () => attempt.relayPubkey),
      publish: (event) =>
        current(scope, () =>
          relayClient.publishEvent(
            event,
            "Your business update is awaiting confirmation. Retry the saved update.",
            "Your business details could not be saved. Try again.",
            scope.relayUrl,
          ),
        ),
      fetchFirstEvent: (filter) =>
        current(scope, () => relayClient.fetchFirstEvent(filter)),
    }).submit(JSON.stringify(attempt.action));
  },
  now: Date.now,
  requestId: firstJobBusinessRequestId,
  delay,
});
