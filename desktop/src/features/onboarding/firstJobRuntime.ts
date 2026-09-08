import { verifyEvent } from "nostr-tools/pure";
import { openUrl } from "@/shared/api/nativeBridge";
import { relayClient } from "@/shared/api/relayClient";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";
import { getColonyCreditsAccount } from "@/shared/api/tauriProvisionedCredits";
import { ensureBuiltInFounderConfig } from "./automaticAgentSetup";
import { createFirstJobBrowserStore } from "./firstJobBrowserStore";
import {
  createFirstJobCredits,
  isFirstJobCheckoutAttempt,
} from "./firstJobCredits";
import {
  assertFirstJobMessageScope,
  createFirstJobDispatcher,
  isFirstJobDispatchAttempt,
} from "./firstJobDispatch";
import { assertFirstJobRetryCanReachReceiver } from "./firstJobDelivery";
import {
  checkFirstJobBusiness,
  firstJobNativeActions,
} from "./firstJobNativeActions";
import { assertFirstJobScope } from "./firstJobScope";
import {
  createFirstJobStarter,
  snapshotFirstJobScope,
  type FirstJobScope,
} from "./firstJobStart";
import { ensureFirstJobTeam, startFirstJobTeam } from "./firstJobTeam";
import { createWiredPaymentsService } from "./lib/wiredPaymentsService";

const draftStore = createFirstJobBrowserStore(
  "draft",
  (value): value is string => typeof value === "string" && value.length <= 4000,
);
const attemptStore = createFirstJobBrowserStore(
  "dispatch",
  isFirstJobDispatchAttempt,
);
const checkoutStore = createFirstJobBrowserStore(
  "checkout",
  isFirstJobCheckoutAttempt,
);

/** Read exact spendable credits; unreadable funding is never reported as zero. */
export async function readFirstJobAvailableCredits(
  scope: FirstJobScope,
): Promise<bigint> {
  await assertFirstJobScope(scope);
  const account = await getColonyCreditsAccount();
  await assertFirstJobScope(scope);
  if (
    account.currency !== "USD" ||
    typeof account.available_balance_nanousd !== "string" ||
    !/^-?\d{1,40}$/.test(account.available_balance_nanousd)
  ) {
    throw new Error("Your available credits could not be read. Try again.");
  }
  return BigInt(account.available_balance_nanousd);
}

/** Connect the small onboarding controls to existing native, payment and task services. */
export function createFirstJobRuntime(inputScope: FirstJobScope) {
  const scope = snapshotFirstJobScope(inputScope);
  const dispatch = createFirstJobDispatcher({
    ...firstJobNativeActions,
    assertCurrent: assertFirstJobScope,
    withLock: (captured, work) => attemptStore.withLock(captured, work),
    read: attemptStore.read,
    write: attemptStore.write,
    startTeam: startFirstJobTeam,
  });
  const start = createFirstJobStarter({
    assertCurrent: assertFirstJobScope,
    async ensureConfig(captured) {
      await ensureBuiltInFounderConfig({
        saveConfig: async (config) => {
          await assertFirstJobScope(captured);
          const saved = await setGlobalAgentConfig(config);
          await assertFirstJobScope(captured);
          return saved;
        },
      });
      await assertFirstJobScope(captured);
      const config = await getGlobalAgentConfig();
      await assertFirstJobScope(captured);
      return { credentialMode: config.credential_mode };
    },
    readAvailableCredits: readFirstJobAvailableCredits,
    checkBusiness: checkFirstJobBusiness,
    ensureTeam: (captured) =>
      ensureFirstJobTeam(captured, attemptStore.read(captured)?.team),
    dispatchOnce: dispatch,
  });
  const credits = createFirstJobCredits({
    payments: createWiredPaymentsService(scope),
    assertCurrent: assertFirstJobScope,
    readAvailableCredits: readFirstJobAvailableCredits,
    openUrl,
    readAttempt: async (captured) => checkoutStore.read(captured),
    writeAttempt: async (captured, value) =>
      checkoutStore.write(captured, value),
    withAttemptLock: (captured, work) => checkoutStore.withLock(captured, work),
  });

  return {
    scope,
    draftStore,
    attemptStore,
    checkoutStore,
    credits,
    /** Confirm a lost receipt before requesting more credits or invoking a worker. */
    async checkExistingRequest(): Promise<{
      eventId: string;
      taskId: string;
    } | null> {
      return attemptStore.withLock(scope, async () => {
        await assertFirstJobScope(scope);
        const attempt = attemptStore.read(scope);
        if (!attempt?.message || !attempt.work) return null;
        const { message, work } = attempt;
        assertFirstJobMessageScope(message, scope, attempt.team, work);
        if (!attempt.acknowledged) {
          const found = await relayClient.fetchFirstEvent({
            ids: [message.id],
            kinds: [9],
            authors: [scope.ownerPubkey],
            "#h": [scope.channelId],
            limit: 1,
          });
          await assertFirstJobScope(scope);
          if (!found) return null;
          if (
            found.id !== message.id ||
            found.pubkey !== scope.ownerPubkey ||
            found.content !== message.content ||
            found.created_at !== message.created_at ||
            JSON.stringify(found.tags) !== JSON.stringify(message.tags) ||
            !verifyEvent({
              id: found.id,
              pubkey: found.pubkey,
              kind: found.kind,
              content: found.content,
              tags: found.tags,
              created_at: found.created_at,
              sig: found.sig ?? "",
            })
          ) {
            throw new Error(
              "The saved request has not been confirmed. No new instruction has been sent.",
            );
          }
          attemptStore.write(scope, { ...attempt, acknowledged: true });
        }
        return { eventId: message.id, taskId: work.taskId };
      });
    },
    async start(content: string) {
      await assertFirstJobScope(scope);
      const attempt = attemptStore.read(scope);
      if (!attempt?.acknowledged)
        assertFirstJobRetryCanReachReceiver(
          attempt?.message,
          Math.floor(Date.now() / 1000),
        );
      return start(scope, content);
    },
  };
}

export type FirstJobRuntime = ReturnType<typeof createFirstJobRuntime>;
