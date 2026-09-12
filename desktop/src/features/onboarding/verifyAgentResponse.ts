import type { RelayEvent } from "@/shared/api/types";
import { relayClient } from "@/shared/api/relayClient";
import {
  createChannel,
  getChannels,
  getChannelMembers,
  updateChannel,
} from "@/shared/api/tauriChannels";
import { getAgentConfigSurface } from "@/shared/api/tauri";
import {
  getGlobalAgentConfig,
  type GlobalAgentConfigScope,
} from "@/shared/api/tauriGlobalAgentConfig";
import { startManagedAgentRuntime } from "@/shared/api/tauriManagedAgents";
import {
  subscribeToAgentObserverFrames,
  sendAgentObserverControl,
} from "@/shared/api/observerRelay";
import { decryptObserverEvent } from "@/shared/api/tauriObserver";
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";
import { ensureWelcomeChannel } from "./welcome";
import { ensureWelcomeTeam } from "./welcomeGuide";
import { assertFirstJobScope } from "./firstJobScope";
import { responseProof, type ProofFrame } from "./responseProof";

export type AgentResponseProof = {
  agentPubkey: string;
  scope: GlobalAgentConfigScope;
  reply: string;
  assertValid: () => Promise<void>;
};
/** Runs the actual managed agent and waits for its matching successful reply. */
export async function verifyAgentResponse(
  scope: GlobalAgentConfigScope,
  signal: AbortSignal,
  progress: (text: string) => void,
): Promise<AgentResponseProof> {
  const subscriptions: (() => void)[] = [];
  const deadline = AbortSignal.timeout(120_000);
  const aborted = AbortSignal.any([signal, deadline]);
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    aborted.throwIfAborted();
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new Error(
            signal.aborted
              ? "Connection test cancelled."
              : "Your agent did not reply within two minutes. Try again or choose another connection.",
          ),
        );
      aborted.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      aborted.removeEventListener("abort", abort);
    }
  }
  async function subscribe(operation: Promise<() => void>) {
    await bounded(
      operation.then((close) => {
        if (aborted.aborted) close();
        else subscriptions.push(close);
      }),
    );
  }
  let agentPubkey: string | undefined;
  let turnId: string | null = null;
  let channelId: string | undefined;
  const check = async () => {
    aborted.throwIfAborted();
    await bounded(assertFirstJobScope(scope));
    aborted.throwIfAborted();
  };
  const config = JSON.stringify(await bounded(getGlobalAgentConfig()));
  const assertValid = async () => {
    await assertFirstJobScope(scope);
    if (JSON.stringify(await getGlobalAgentConfig()) !== config)
      throw new Error(
        "Your connection changed. Test it again before continuing.",
      );
  };
  try {
    await check();
    progress("Starting your agent…");
    const channel = await bounded(
      ensureWelcomeChannel({
        createChannel,
        getChannels: () => getChannels(null).then((p) => p.channels ?? []),
        getChannelMembers,
        updateChannel,
      }),
    );
    channelId = channel.id;
    await check();
    const {
      agents: [agent],
    } = await bounded(ensureWelcomeTeam(channel.id, scope.relayUrl));
    agentPubkey = agent.pubkey;
    await check();
    const surface = await bounded(getAgentConfigSurface(agent.pubkey));
    const selected = JSON.parse(config) as {
      preferred_runtime?: string;
      model?: string;
    };
    if (
      surface.runtimeId !== (selected.preferred_runtime || "buzz-agent") ||
      (selected.model && surface.normalized.model?.value !== selected.model)
    )
      throw new Error(
        "Your teammate uses different settings. Update its connection and test again.",
      );
    const values = (config: typeof surface.normalized) =>
      JSON.stringify({
        model: config.model?.value,
        provider: config.provider?.value,
        effort: config.thinkingEffort?.value,
      });
    const before = values(surface.normalized);
    const validate = async () => {
      await assertValid();
      const current = await getAgentConfigSurface(agent.pubkey);
      if (
        current.runtimeId !== surface.runtimeId ||
        values(current.normalized) !== before
      )
        throw new Error(
          "Your agent settings changed. Test the connection again.",
        );
    };
    let requestId = "";
    const pending: ProofFrame[] = [];
    let proof: ReturnType<typeof responseProof> | undefined;
    let successful = false;
    let reply = "";
    const nonce = crypto.randomUUID();
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const result = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Attach immediately so failures during setup cannot become unhandled rejections.
    void result.catch(() => {});
    const onAbort = () =>
      reject(
        new Error(
          signal.aborted
            ? "Connection test cancelled."
            : "Your agent did not reply within two minutes. Try again or choose another connection.",
        ),
      );
    aborted.addEventListener("abort", onAbort, { once: true });
    subscriptions.push(() => aborted.removeEventListener("abort", onAbort));
    const accept = (frame: ProofFrame) => {
      if (!proof) {
        if (pending.length < 1000) pending.push(frame);
        return;
      }
      if (
        frame.kind === "turn_started" &&
        (
          frame.payload as { triggeringEventIds?: string[] }
        )?.triggeringEventIds?.includes(requestId)
      )
        turnId = frame.turnId;
      if (
        frame.turnId === turnId &&
        ["turn_completed", "turn_error", "agent_panic"].includes(frame.kind)
      )
        turnId = null;
      const state = proof.accept(frame);
      if (state === "failed")
        reject(
          new Error(
            "This configuration isn't working yet. Your agent could not complete the reply. Reconnect or choose another option.",
          ),
        );
      successful ||= state === "success";
      if (successful && reply) resolve();
    };
    let observerQueue = Promise.resolve();
    await subscribe(
      subscribeToAgentObserverFrames(scope.ownerPubkey, (event) => {
        if (
          event.pubkey !== agent.pubkey ||
          !event.tags.some((t) => t[0] === "agent" && t[1] === agent.pubkey)
        )
          return;
        observerQueue = observerQueue
          .then(() => decryptObserverEvent(event))
          .then((frame) => {
            if (!aborted.aborted) {
              const parsed = frame as ProofFrame;
              const batch = (parsed.payload as { events?: ProofFrame[] })
                ?.events;
              for (const inner of parsed.kind === "batch" &&
              Array.isArray(batch)
                ? batch
                : [parsed])
                accept(inner);
            }
          })
          .catch(() =>
            reject(
              new Error(
                "We could not verify your agent's response. Try again.",
              ),
            ),
          );
      }),
    );
    const earlyMessages: RelayEvent[] = [];
    const acceptMessage = (event: RelayEvent) => {
      if (event.pubkey !== agent.pubkey) return;
      if (!requestId) {
        if (earlyMessages.length < 100) earlyMessages.push(event);
        return;
      }
      if (!event.tags.some((t) => t[0] === "e" && t[1] === requestId)) return;
      if (!event.content.trim() || !event.content.includes(nonce)) return;
      reply = event.content.replace(nonce, "").trim() || "Your agent replied.";
      if (successful) resolve();
    };
    await subscribe(
      relayClient.subscribeLive(
        {
          kinds: [9, 40002],
          "#h": [channel.id],
          authors: [agent.pubkey],
          limit: 0,
        },
        acceptMessage,
      ),
    );
    await check();
    await bounded(
      startManagedAgentRuntime(agent.pubkey, scope.relayUrl, scope.ownerPubkey),
    );
    await check();
    progress("Waiting for a reply…");
    const sent = await bounded(
      sendChannelMessage({
        channelId: channel.id,
        mentionPubkeys: [agent.pubkey],
        content: `Colony connection test. Reply in this thread with a short greeting and this verification code: ${nonce}. Do not use tools or start any other work.`,
        clientTags: [["client", "colony:onboarding-response-test"]],
      }),
    );
    requestId = sent.eventId;
    proof = responseProof(requestId, channel.id);
    for (const frame of pending) accept(frame);
    for (const event of earlyMessages) acceptMessage(event);
    await result;
    await check();
    await bounded(validate());
    return { agentPubkey: agent.pubkey, scope, reply, assertValid: validate };
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    if (aborted.aborted && agentPubkey && turnId)
      void sendAgentObserverControl(agentPubkey, {
        type: "cancel_turn",
        channelId,
      }).catch(() => {});
  }
}
