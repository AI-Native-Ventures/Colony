import {
  attachManagedAgentToChannel,
  type AttachManagedAgentToChannelInput,
  type AttachManagedAgentToChannelResult,
} from "@/features/agents/channelAgents";
import {
  canonicalRelayUrl,
  findManagedAgentRuntime,
} from "@/features/agents/managedAgentRuntimeStatus";
import {
  ensureRelayObserverSubscription,
  getAgentObserverSnapshot,
} from "@/features/agents/observerRelayStore";
import type {
  ManagedAgent,
  ManagedAgentRuntimeStatus,
} from "@/shared/api/types";
import {
  listManagedAgentRuntimes,
  startManagedAgentRuntime,
} from "@/shared/api/tauriManagedAgents";
import { normalizePubkey } from "@/shared/lib/pubkey";

const HEX_64 = /^[0-9a-f]{64}$/;
const READY_WAIT_MS = 15_000;
const READY_POLL_MS = 200;
const READY_TIMEOUT =
  "The website coordinator is still getting ready. Try again in a moment.";

type AttachWebsiteCoordinator = (
  channelId: string,
  input: AttachManagedAgentToChannelInput,
) => Promise<AttachManagedAgentToChannelResult>;

type StartWebsiteCoordinatorRuntime = (
  pubkey: string,
  relayUrl: string,
  expectedOwnerPubkey: string,
) => Promise<ManagedAgentRuntimeStatus>;

type ListWebsiteRuntimeStatuses = () => Promise<ManagedAgentRuntimeStatus[]>;

type EnsureWebsiteCoordinatorObserver = (pubkey: string) => Promise<void>;

type WebsiteCoordinatorReadinessInput = {
  communityId: string;
  relayUrl: string;
  ownerPubkey: string;
  channelId: string;
  coordinatorPubkey: string;
  loadManagedAgents: () => Promise<ManagedAgent[]>;
  /** Read the persisted active community so a switch during an await is caught. */
  getActiveCommunityId: () => string | null;
  ensureObserver?: EnsureWebsiteCoordinatorObserver;
  attachAgent?: AttachWebsiteCoordinator;
  startRuntime?: StartWebsiteCoordinatorRuntime;
  listRuntimeStatuses?: ListWebsiteRuntimeStatuses;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
};

function normalizeIdentity(value: string, label: string): string {
  const normalized = normalizePubkey(value);
  if (!HEX_64.test(normalized)) {
    throw new Error(`The website ${label} identity is invalid.`);
  }
  return normalized;
}

function assertCurrentCommunity(input: WebsiteCoordinatorReadinessInput): void {
  if (input.getActiveCommunityId() !== input.communityId) {
    throw new Error(
      "The community changed while preparing the website coordinator. Refresh and try again.",
    );
  }
}

function validateRuntime(
  runtime: ManagedAgentRuntimeStatus,
  pubkey: string,
  relayUrl: string,
): void {
  if (
    normalizePubkey(runtime.pubkey) !== pubkey ||
    canonicalRelayUrl(runtime.relayUrl) !== relayUrl ||
    !runtime.localSetup ||
    !Number.isInteger(runtime.pid) ||
    (runtime.pid ?? 0) <= 0 ||
    runtime.error ||
    runtime.lifecycle === "failed" ||
    runtime.lifecycle === "stopped"
  ) {
    throw new Error(
      runtime.error ||
        "The website coordinator could not start for this community. Try again.",
    );
  }
}

/**
 * Prepare the pinned Website coordinator before publishing an addressed start.
 *
 * Membership is attached first. Local pairs are then started through the
 * explicit relay/owner-fenced runtime command and polled until ACP reaches its
 * startup subscription boundary (`listening`) or completes its model wake
 * (`ready`). A fresh pair discovers the attached channel during startup; an
 * already-running pair receives the membership notification and timestamped
 * replay path. The relay action must not be sent while the pair is merely a
 * spawned process.
 */
export async function ensureWebsiteCoordinatorReady(
  input: WebsiteCoordinatorReadinessInput,
): Promise<void> {
  const coordinatorPubkey = normalizeIdentity(
    input.coordinatorPubkey,
    "coordinator",
  );
  const ownerPubkey = normalizeIdentity(input.ownerPubkey, "owner");
  const relayUrl = canonicalRelayUrl(input.relayUrl);
  if (!relayUrl) {
    throw new Error("The website community connection is invalid.");
  }
  assertCurrentCommunity(input);

  const managedAgents = await input.loadManagedAgents();
  assertCurrentCommunity(input);
  const coordinator = managedAgents.find(
    (agent) =>
      normalizePubkey(agent.pubkey) === coordinatorPubkey &&
      canonicalRelayUrl(agent.relayUrl) === relayUrl,
  );
  if (!coordinator) {
    throw new Error(
      "The website coordinator is unavailable for this community. Refresh and try again.",
    );
  }

  if (coordinator.backend.type === "local") {
    const ensureObserver =
      input.ensureObserver ??
      (async (pubkey: string) => {
        await ensureRelayObserverSubscription();
        const snapshot = getAgentObserverSnapshot(pubkey);
        if (snapshot.connectionState !== "open") {
          throw new Error(
            snapshot.errorMessage ||
              "The website coordinator connection is not ready. Try again.",
          );
        }
      });
    await ensureObserver(coordinatorPubkey);
    assertCurrentCommunity(input);
  }

  const attach = input.attachAgent ?? attachManagedAgentToChannel;
  const attached = await attach(input.channelId, {
    agent: coordinator,
    role: "bot",
    // Provider deployment has no local lifecycle row to poll. Keep its
    // existing deployment boundary, while local pairs use the explicit
    // relay/owner-fenced command below.
    ensureRunning: coordinator.backend.type === "provider",
  });
  assertCurrentCommunity(input);

  if (coordinator.backend.type === "provider") {
    if (
      attached.agent.status !== "deployed" &&
      attached.agent.status !== "running"
    ) {
      throw new Error(
        "The remote website coordinator is not deployed for this community. Try again.",
      );
    }
    return;
  }

  const startRuntime = input.startRuntime ?? startManagedAgentRuntime;
  const started = await startRuntime(
    coordinatorPubkey,
    input.relayUrl,
    ownerPubkey,
  );
  assertCurrentCommunity(input);
  validateRuntime(started, coordinatorPubkey, relayUrl);
  const expectedPid = started.pid;

  const now = input.now ?? Date.now;
  const delay =
    input.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));
  const listStatuses = input.listRuntimeStatuses ?? listManagedAgentRuntimes;
  const deadline = now() + READY_WAIT_MS;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    while (!cancelled) {
      assertCurrentCommunity(input);
      const statuses = await listStatuses();
      assertCurrentCommunity(input);
      if (cancelled) return;
      const runtime = findManagedAgentRuntime(
        statuses,
        coordinatorPubkey,
        input.relayUrl,
      );
      if (runtime) {
        validateRuntime(runtime, coordinatorPubkey, relayUrl);
        if (runtime.pid !== expectedPid) {
          throw new Error(
            "The website coordinator changed while starting. Try again.",
          );
        }
        // Listening marks the ACP startup subscription boundary; it does not
        // independently prove that this target channel was accepted. A fresh
        // pair discovers the membership during startup, while an already
        // running pair uses ACP's membership notification/replay path. Waiting
        // for ready would unnecessarily wake a paid model before BeginWork.
        if (
          runtime.lifecycle === "listening" ||
          runtime.lifecycle === "ready"
        ) {
          return;
        }
      }
      if (now() >= deadline) throw new Error(READY_TIMEOUT);
      await delay(Math.min(READY_POLL_MS, deadline - now()));
    }
  };

  try {
    await Promise.race([
      poll(),
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(READY_TIMEOUT)),
          READY_WAIT_MS,
        );
      }),
    ]);
  } finally {
    cancelled = true;
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
  assertCurrentCommunity(input);
}
