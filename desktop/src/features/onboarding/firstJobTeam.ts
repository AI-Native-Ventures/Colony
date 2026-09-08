import { verifyEvent } from "nostr-tools/pure";
import { commandsMatch } from "@/features/agents/agentReuse";
import { ownerPubkeysFromMembers } from "@/features/agents/communityOwners";
import { collectEmployeeHeads } from "@/features/agents/employeeHeads";
import {
  newestOwnerAuthoredHeadEvent,
  parseManagedAgentHead,
} from "@/features/agents/managedAgentHeads";
import { canonicalRelayUrl } from "@/features/agents/managedAgentRuntimeStatus";
import {
  ensureRelayObserverSubscription,
  getAgentObserverSnapshot,
} from "@/features/agents/observerRelayStore";
import { relayClient } from "@/shared/api/relayClient";
import { listRelayMembers } from "@/shared/api/relayMembers";
import {
  discoverAcpRuntimes,
  getChannelMembers,
  listManagedAgents,
} from "@/shared/api/tauri";
import {
  listManagedAgentRuntimes,
  startManagedAgentRuntime,
} from "@/shared/api/tauriManagedAgents";
import { listPersonas } from "@/shared/api/tauriPersonas";
import type {
  AcpRuntimeCatalogEntry,
  AgentPersona,
  ChannelMember,
  ManagedAgent,
  ManagedAgentRuntimeStatus,
  RelayEvent,
  RelayMember,
} from "@/shared/api/types";
import { KIND_EMPLOYEE, KIND_MANAGED_AGENT } from "@/shared/constants/kinds";
import { STARTER_PERSONA_IDS } from "@/shared/constants/starterPersonas";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { assertFirstJobScope } from "./firstJobScope";
import {
  snapshotFirstJobScope,
  type FirstJobScope,
  type FirstJobTeam,
} from "./firstJobStart";

const READY_WAIT_MS = 15_000;
const READY_POLL_MS = 200;
const READY_TIMEOUT =
  "Your teammates are still getting ready. Try again in a moment.";

/** Read existing staffing; this adapter never hires, grants access or adds members. */
export type FirstJobTeamDependencies = {
  assertCurrent(scope: FirstJobScope): Promise<void>;
  listAgents(): Promise<ManagedAgent[]>;
  listPersonas(): Promise<AgentPersona[]>;
  listRuntimes(): Promise<AcpRuntimeCatalogEntry[]>;
  listMembers(channelId: string): Promise<ChannelMember[]>;
  listOwners(): Promise<RelayMember[]>;
  readHeads(): Promise<RelayEvent[]>;
  ensureObserver(pubkey: string): Promise<void>;
  listRuntimeStatuses(): Promise<ManagedAgentRuntimeStatus[]>;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  startRuntime(
    pubkey: string,
    relayUrl: string,
    expectedOwnerPubkey: string,
  ): Promise<ManagedAgentRuntimeStatus>;
};

function verified(event: RelayEvent): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      sig: event.sig,
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags,
      content: event.content,
    });
  } catch {
    return false;
  }
}

/** Select an existing pair for explicit thread delegation, without reparenting either agent. */
export function createFirstJobTeamAdapter(deps: FirstJobTeamDependencies) {
  async function availableTeams(scope: FirstJobScope): Promise<FirstJobTeam[]> {
    await deps.assertCurrent(scope);
    const [agents, personas, runtimes, members, owners, rawHeads] =
      await Promise.all([
        deps.listAgents(),
        deps.listPersonas(),
        deps.listRuntimes(),
        deps.listMembers(scope.channelId),
        deps.listOwners(),
        deps.readHeads(),
      ]);
    await deps.assertCurrent(scope);
    const ownerPubkeys = ownerPubkeysFromMembers(owners);
    if (!ownerPubkeys.has(scope.ownerPubkey)) return [];
    const relay = canonicalRelayUrl(scope.relayUrl);
    if (!relay) throw new Error("The business connection is invalid.");
    const memberPubkeys = new Set(
      members
        .filter((member) => member.isAgent)
        .map((member) => normalizePubkey(member.pubkey)),
    );
    const activePersonas = new Set(
      personas
        .filter((persona) => persona.isActive)
        .map((persona) => persona.id),
    );
    const heads = rawHeads.filter(verified);
    const employees = collectEmployeeHeads(heads);
    const employeesByPubkey = new Map(
      employees.map((head) => [head.pubkey, head]),
    );
    const employeesByRole = new Map(employees.map((head) => [head.role, head]));
    const approved = agents
      .flatMap((agent) => {
        const pubkey = normalizePubkey(agent.pubkey);
        if (
          !/^[a-f0-9]{64}$/.test(pubkey) ||
          canonicalRelayUrl(agent.relayUrl) !== relay ||
          !memberPubkeys.has(pubkey) ||
          agent.backend.type !== "local" ||
          agent.respondTo !== "owner-only" ||
          !agent.personaId ||
          !activePersonas.has(agent.personaId) ||
          agent.personaOrphaned ||
          !runtimes.some(
            (runtime) =>
              runtime.availability === "available" &&
              runtime.command !== null &&
              commandsMatch(agent.agentCommand, runtime.command),
          )
        )
          return [];
        const event = newestOwnerAuthoredHeadEvent(heads, ownerPubkeys, pubkey);
        if (!event || normalizePubkey(event.pubkey) !== scope.ownerPubkey)
          return [];
        const head = parseManagedAgentHead(event);
        if (!head?.tierRank) return [];
        // Relay employee records override managed tiers; a conflicting rank cannot
        // be bypassed by picking only the owner-authored head's convenient value.
        const rank =
          employeesByPubkey.get(pubkey)?.rank ??
          (head.roleId ? employeesByRole.get(head.roleId)?.rank : null) ??
          head.tierRank;
        return rank === head.tierRank
          ? [{ pubkey, personaId: agent.personaId, rank }]
          : [];
      })
      .sort((left, right) => left.pubkey.localeCompare(right.pubkey));
    const scouts = approved.filter(
      (agent) =>
        agent.personaId === STARTER_PERSONA_IDS.fizz &&
        agent.rank === "executive",
    );
    const workers = approved.filter((agent) => agent.rank === "worker");
    // This is direct messaging inside the owner's job thread. Typed asks retain
    // their existing worker → leader → executive route; no manager tag is changed.
    return scouts.flatMap((scout) =>
      workers
        .filter((worker) => worker.pubkey !== scout.pubkey)
        .map((worker) => ({
          scoutPubkey: scout.pubkey,
          workerPubkey: worker.pubkey,
        })),
    );
  }

  return {
    async ensureFirstJobTeam(
      input: FirstJobScope,
      preferredTeam?: FirstJobTeam,
    ): Promise<FirstJobTeam | null> {
      const preferred = preferredTeam
        ? Object.freeze({ ...preferredTeam })
        : null;
      const teams = await availableTeams(snapshotFirstJobScope(input));
      return (
        (preferred
          ? teams.find(
              (pair) =>
                pair.scoutPubkey === preferred.scoutPubkey &&
                pair.workerPubkey === preferred.workerPubkey,
            )
          : teams[0]) ?? null
      );
    },
    async startFirstJobTeam(
      input: FirstJobScope,
      inputTeam: FirstJobTeam,
    ): Promise<void> {
      const scope = snapshotFirstJobScope(input);
      const team = Object.freeze({ ...inputTeam });
      await deps.assertCurrent(scope);
      await deps.ensureObserver(team.scoutPubkey);
      await deps.assertCurrent(scope);
      const started: ManagedAgentRuntimeStatus[] = [];
      for (const pubkey of [team.workerPubkey, team.scoutPubkey]) {
        const available = await availableTeams(scope);
        if (
          !available.some(
            (pair) =>
              pair.scoutPubkey === team.scoutPubkey &&
              pair.workerPubkey === team.workerPubkey,
          )
        ) {
          throw new Error(
            "The approved teammates for this job are no longer available. Review your team and try again.",
          );
        }
        await deps.assertCurrent(scope);
        const runtime = await deps.startRuntime(
          pubkey,
          scope.relayUrl,
          scope.ownerPubkey,
        );
        await deps.assertCurrent(scope);
        if (
          runtime.pubkey !== pubkey ||
          canonicalRelayUrl(runtime.relayUrl) !==
            canonicalRelayUrl(scope.relayUrl) ||
          !runtime.localSetup ||
          !Number.isInteger(runtime.pid) ||
          (runtime.pid ?? 0) <= 0 ||
          runtime.error ||
          runtime.lifecycle === "failed" ||
          runtime.lifecycle === "stopped"
        )
          throw new Error(
            runtime.error ||
              "This teammate could not start for the selected business. Try again.",
          );
        started.push(runtime);
      }
      const now = deps.now ?? Date.now;
      const delay =
        deps.delay ??
        ((ms: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const deadline = now() + READY_WAIT_MS;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        while (!cancelled) {
          await deps.assertCurrent(scope);
          const statuses = await deps.listRuntimeStatuses();
          await deps.assertCurrent(scope);
          if (cancelled) return;
          let ready = true;
          for (const captured of started) {
            const runtime = statuses.find(
              (status) =>
                status.pubkey === captured.pubkey &&
                status.relayUrl === captured.relayUrl,
            );
            if (!runtime) {
              ready = false;
              continue;
            }
            if (
              !runtime.localSetup ||
              runtime.error ||
              runtime.lifecycle === "failed" ||
              runtime.lifecycle === "stopped" ||
              !Number.isInteger(runtime.pid) ||
              (runtime.pid ?? 0) <= 0
            )
              throw new Error(
                runtime.error ||
                  "This teammate could not start for the selected business. Try again.",
              );
            if (runtime.pid !== captured.pid)
              throw new Error(
                "This teammate changed while starting. Try again.",
              );
            // Listening has subscriptions queued without waking the paid model.
            ready &&=
              runtime.lifecycle === "listening" ||
              runtime.lifecycle === "ready";
          }
          if (ready) return;
          if (now() >= deadline) throw new Error(READY_TIMEOUT);
          await delay(Math.min(READY_POLL_MS, deadline - now()));
        }
      };
      try {
        await Promise.race([
          poll(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(READY_TIMEOUT)),
              READY_WAIT_MS,
            );
          }),
        ]);
      } finally {
        cancelled = true;
        clearTimeout(timer);
      }
      await deps.assertCurrent(scope);
    },
  };
}

const adapter = createFirstJobTeamAdapter({
  assertCurrent: assertFirstJobScope,
  listAgents: listManagedAgents,
  listPersonas,
  listRuntimes: discoverAcpRuntimes,
  listMembers: getChannelMembers,
  listOwners: listRelayMembers,
  readHeads: () =>
    relayClient.fetchEvents({
      kinds: [KIND_MANAGED_AGENT, KIND_EMPLOYEE],
      limit: 500,
    }),
  ensureObserver: async (pubkey) => {
    await ensureRelayObserverSubscription();
    const state = getAgentObserverSnapshot(pubkey);
    if (state.connectionState !== "open")
      throw new Error(
        state.errorMessage ||
          "The teammate connection is not ready. Try again.",
      );
  },
  listRuntimeStatuses: listManagedAgentRuntimes,
  startRuntime: (pubkey, relayUrl, ownerPubkey) =>
    startManagedAgentRuntime(pubkey, relayUrl, ownerPubkey),
});

/** Return existing approved teammates, or null when staffing is unavailable. */
export const ensureFirstJobTeam = adapter.ensureFirstJobTeam;
/** Start the selected existing pair on the captured community and owner. */
export const startFirstJobTeam = adapter.startFirstJobTeam;
