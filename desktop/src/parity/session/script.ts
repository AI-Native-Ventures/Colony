/**
 * The scripted parity session: breadth across the 263-command native surface,
 * a live relay subscription with real push traffic, and the event names the
 * recorder must observe (or explicitly declare unreachable).
 *
 * Every step records through the bridge (via the API layer where one exists,
 * via `invokeTauri` otherwise). Replayability is declared per step:
 * - reads and deterministic error paths replay in the same session;
 * - fixture-named creates replay with a fresh name (fixtureArgs);
 * - steps that target an object created during the record phase are declared
 *   non-replayable with a reason — the report shows them as skipped, never
 *   silently dropped.
 */

import { NativeChannel } from "@/shared/api/nativeBridge";
import { CHANNEL_EVENT_KINDS } from "@/shared/constants/kinds";
import type { SessionContext } from "@/parity/session/context";
import { invokeTauri } from "@/shared/api/tauri";
import {
  getIdentity,
  getNsec,
  importIdentity,
  persistCurrentIdentity,
} from "@/shared/api/tauriIdentity";
import {
  getDefaultRelayUrl,
  autoConnectDefaultRelayEnabled,
  isSharedIdentity,
  getRelayWsUrl,
  getRelayHttpUrl,
  leaveChannel,
  addChannelMembers,
  removeChannelMember,
  changeChannelMemberRole,
  getPresence,
  getHomeFeed,
  searchMessages,
  getEventById,
  getThreadReplies,
  sendChannelMessage,
  uploadMediaBytes,
  editMessage,
  addReaction,
  removeReaction,
  deleteMessage,
  signRelayEvent,
  createAuthEvent,
  listRelayMembers,
  getMyRelayMembership,
  addRelayMember,
  removeRelayMember,
  changeRelayMemberRole,
  listRelayAgents,
  listManagedAgents,
  getManagedAgentLog,
  discoverGitBashPrerequisite,
  saveCustomHarness,
  deleteCustomHarness,
  installAcpRuntime,
  discoverManagedAgentPrereqs,
  getAgentModels,
  getAgentConfigSurface,
  putAgentSessionConfig,
  getRuntimeFileConfig,
  getBakedBuildEnvKeys,
  getBakedBuildEnv,
  updateManagedAgent,
  discoverBackendProviders,
  probeBackendProvider,
  nip44EncryptToSelf,
  startPairing,
  confirmPairingSas,
  cancelPairing,
  applyCommunity,
  validateReposDir,
  isAutoUpdateSupported,
} from "@/shared/api/tauri";
import {
  getProfile,
  updateProfile,
  updateProfileAtRelay,
  getUserProfile,
  getUsersBatch,
  searchUsers,
} from "@/shared/api/tauriProfiles";
import {
  getChannels,
  createChannel,
  ensureStarterChannels,
  openDm,
  hideDm,
  getChannelDetails,
  updateChannel,
  setChannelTopic,
  setChannelPurpose,
  archiveChannel,
  unarchiveChannel,
  deleteChannel,
  getChannelMessagesBefore,
  getChannelMembers,
  joinChannel,
} from "@/shared/api/tauriChannels";
import { getCanvas, setCanvas } from "@/shared/api/tauri";
import {
  listChannelTemplates,
  createChannelTemplate,
  updateChannelTemplate,
  deleteChannelTemplate,
  duplicateChannelTemplate,
} from "@/shared/api/tauriChannelTemplates";
import {
  listPersonas,
  createPersona,
  updatePersona,
  deletePersona,
  setPersonaActive,
  setPersonaShared,
  encodeAgentSnapshotForSend,
  previewAgentSnapshotImport,
  confirmAgentSnapshotImport,
  reconcileInboundPersonaEvent,
} from "@/shared/api/tauriPersonas";
import {
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  encodeTeamSnapshotForSend,
  previewTeamSnapshotImport,
  confirmTeamSnapshotImport,
} from "@/shared/api/tauriTeams";
import {
  getChannelWorkflows,
  getChannelsWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getWorkflowRuns,
  getRunApprovals,
  triggerWorkflow,
  grantApproval,
  denyApproval,
} from "@/shared/api/tauriWorkflows";
import {
  getNoteReactions,
  getNote,
  getUserNotes,
  publishNote,
  getContactList,
  setContactList,
  getLikedNotes,
  getGlobalNotes,
  getNotesTimeline,
} from "@/shared/api/social";
import {
  createSaveSubscription,
  listSaveSubscriptions,
  deleteSaveSubscription,
  mergeSaveSubscriptionKinds,
  removeSaveSubscriptionKind,
  archiveEvents,
  readArchivedObserverEventsForChannel,
  indexObserverChannelId,
  readUnindexedObserverRows,
  readArchivedEvents,
  observerArchiveDefaultEnabled,
  agentMetricArchiveDefaultEnabled,
} from "@/shared/api/tauriArchive";
import { getAgentMemory } from "@/shared/api/tauriEngrams";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";
import {
  startManagedAgentRuntime,
  stopManagedAgentRuntime,
  restartManagedAgentRuntime,
  putManagedAgentRuntimeLifecycle,
  reconcileManagedAgentRuntimes,
  listManagedAgentRuntimes,
  setManagedAgentAutoRestart,
  setManagedAgentStartOnAppLaunch,
} from "@/shared/api/tauriManagedAgents";
import {
  discoverAcpAuthMethods,
  connectAcpRuntime,
} from "@/shared/api/tauriAgentAuth";
import {
  meshStartNode,
  meshStopNode,
  meshNodeStatus,
  meshServingUsage,
  meshInstalledModels,
  meshModelCatalog,
} from "@/shared/api/tauriMesh";
import { advanceInitiative, ensureChatTask } from "@/shared/api/initiative";
import {
  executeCompanyBlueprint,
  completeCompanyBlueprint,
} from "@/shared/api/companyBlueprint";
import { fetchBlockData } from "@/shared/api/blockData";
import { getChannelWindowEvents } from "@/shared/api/channelWindow";
import { getForumPosts, getForumThread } from "@/shared/api/forum";
import { executeAgentProposal } from "@/shared/api/agentProposals";
import {
  getGitIdentity,
  getProjectRepoSnapshot,
  getProjectRepoDiff,
  getProjectLocalRepoDiff,
  getProjectLocalRepoSnapshot,
  listProjectLocalRepositories,
  getProjectRepoSyncStatus,
  openProjectTerminal,
  openProjectMergeRecoveryTerminal,
  pushProjectLocalRepository,
  pullProjectLocalRepository,
  cloneProjectRepository,
  createProjectRemoteBranch,
  deleteProjectRemoteBranch,
  mergeProjectPullRequest,
  signProjectPullRequestReviewRequest,
  signProjectPullRequestStatus,
  publishProjectPullRequestMergedStatus,
} from "@/shared/api/projectGit";
import {
  fetchMediaBytes,
  copyTextToSystemClipboard,
  fetchSnapshotBytes,
} from "@/shared/api/tauriMedia";
import {
  buildObserverControlEvent,
  decryptObserverEvent,
} from "@/shared/api/tauriObserver";
import {
  resolveOaOwner,
  unarchiveIdentity,
  listArchivedIdentities,
} from "@/shared/api/tauriIdentityArchive";
import { getOsIdleSeconds } from "@/shared/api/osIdle";
import { sendManagedAgentChannelMessage } from "@/shared/api/tauriManagedAgentMessages";
import { hasManagedAgentChannelMessageMarker } from "@/shared/api/tauriManagedAgentMessageMarkers";
import {
  saveDiscoveryCredential,
  getDiscoveryCredentialStatus,
  deleteDiscoveryCredential,
} from "@/shared/api/discoveryCredentials";
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { loadLedgerReport } from "@/features/ledger/report";
import { publishPrice } from "@/features/ledger/prices";
import { submitCorrection } from "@/features/ledger/corrections";
import { performSidebarDefaultHaptic } from "@/shared/lib/haptics";
import { performTitleBarDoubleClickAction } from "@/shared/lib/titleBarActions";
import { sendDesktopNotification } from "@/features/notifications/lib/desktop";

export type SessionStep = {
  id: string;
  /** Native command this step exercises (for trace correlation). */
  command: string;
  run: (ctx: SessionContext) => Promise<unknown>;
  replayable: boolean;
  notReplayableReason?: string;
  fixtureArgs?: string[];
  jsonArgs?: Array<{ path: string; rewrite: Record<string, string> }>;
  capture?: (ctx: SessionContext, result: unknown) => void;
};

const BOGUS_UUID = "00000000-0000-0000-0000-000000000000";
const BOGUS_PUBKEY = "0".repeat(64);
const BOGUS_REPO = "/nonexistent/parity-oracle-repo";
const BOGUS_CLONE_URL = "https://localhost/nonexistent/parity-oracle.git";

function step(
  id: string,
  command: string,
  run: (ctx: SessionContext) => Promise<unknown>,
  options: {
    replayable?: boolean;
    reason?: string;
    fixtureArgs?: string[];
    jsonArgs?: Array<{ path: string; rewrite: Record<string, string> }>;
    capture?: (ctx: SessionContext, result: unknown) => void;
  } = {},
): SessionStep {
  return {
    id,
    command,
    run,
    replayable: options.replayable ?? true,
    notReplayableReason: options.reason,
    fixtureArgs: options.fixtureArgs,
    jsonArgs: options.jsonArgs,
    capture: options.capture,
  };
}

const WORKFLOW_YAML = (name: string) => `name: ${name}
description: parity oracle fixture workflow
enabled: true
trigger:
  on: message_posted
  filter: parity-oracle
steps:
  - id: reply
    action: send_message
    text: parity-oracle workflow reply
`;

export const SESSION_STEPS: SessionStep[] = [
  // ── identity ──────────────────────────────────────────────────────────────
  step("identity-get", "get_identity", () => getIdentity(), {
    capture: (ctx, r) => {
      const identity = r as { pubkey: string };
      ctx.identityPubkey = identity.pubkey;
    },
  }),
  step("identity-nsec", "get_nsec", () => getNsec()),
  step("identity-persist", "persist_current_identity", () =>
    persistCurrentIdentity(),
  ),
  step("identity-import-invalid", "import_identity", () =>
    importIdentity("nsec1invalidparityoracle"),
  ),
  step("identity-relay-ws", "get_relay_ws_url", () => getRelayWsUrl(), {
    capture: (ctx, r) => {
      ctx.relayWsUrl = r as string;
    },
  }),
  step("identity-relay-http", "get_relay_http_url", () => getRelayHttpUrl(), {
    capture: (ctx, r) => {
      ctx.relayHttpUrl = r as string;
    },
  }),
  step("identity-relay-default", "get_default_relay_url", () =>
    getDefaultRelayUrl(),
  ),
  step("identity-shared", "is_shared_identity", () => isSharedIdentity()),
  step("identity-auto-connect", "auto_connect_default_relay_enabled", () =>
    autoConnectDefaultRelayEnabled(),
  ),
  step("identity-media-proxy-port", "get_media_proxy_port", () =>
    invokeTauri("get_media_proxy_port"),
  ),
  step("identity-sign-event", "sign_event", (ctx) =>
    signRelayEvent({
      kind: 1,
      content: ctx.fixture("sig-event"),
      tags: [["parity-oracle", "1"]],
    }),
  ),
  step("identity-auth-event", "create_auth_event", () =>
    createAuthEvent({
      challenge: "parity-oracle-challenge",
      relayUrl: "ws://localhost:3000",
    }),
  ),
  step("identity-nip44-encrypt", "nip44_encrypt_to_self", () =>
    nip44EncryptToSelf("parity oracle plaintext"),
  ),

  // ── profile ───────────────────────────────────────────────────────────────
  // Update before read-back: the profile PERSISTS on the relay, so a read
  // that precedes the session's own update observes pre-write state during
  // record (null profile) that replay can never reproduce (the record phase
  // already wrote it). Update-then-read-back makes both phases observe the
  // same post-write state.
  step("profile-update", "update_profile", (ctx) =>
    updateProfile({ displayName: ctx.fixture("display-name") }),
  ),
  step("profile-get", "get_profile", () => getProfile()),
  step("profile-get-user", "get_user_profile", (ctx) =>
    getUserProfile(ctx.identityPubkey),
  ),
  step("profile-users-batch", "get_users_batch", (ctx) =>
    getUsersBatch([ctx.identityPubkey, BOGUS_PUBKEY]),
  ),
  step("profile-search", "search_users", () => searchUsers("parity"), {
    replayable: false,
    reason:
      "the relay's user table accumulates the record phase's agent; the user list differs between record and replay",
  }),
  step("profile-update-at-relay", "update_profile_at_relay", (ctx) =>
    updateProfileAtRelay({
      relayUrl: ctx.relayWsUrl,
      expectedPubkey: ctx.identityPubkey,
      expectedAvatarUrl: null,
      avatarUrl: "",
    }),
  ),

  // ── workspace ─────────────────────────────────────────────────────────────
  // Successful apply: connects this desktop to the local relay, opens the
  // app's relay subscriptions (the push path the recorder must observe), and
  // persists the community so replay boots into the same state. Idempotent —
  // a later apply with the same relay is a no-op save.
  step("workspace-apply", "apply_workspace", (ctx) =>
    applyCommunity(ctx.relayWsUrl, undefined, undefined, undefined, false),
  ),

  // ── channels ──────────────────────────────────────────────────────────────
  step("channels-list", "get_channels", () => getChannels(), {
    replayable: false,
    reason:
      "the record-phase fixture channel is deleted by teardown before replay and the replay's own channel is created after; the channel table differs by design",
  }),
  step(
    "channels-starter",
    "ensure_starter_channels",
    () => ensureStarterChannels(),
    {
      replayable: false,
      reason:
        "see get_channels: the fixture channel lifecycle differs between record and replay",
    },
  ),
  step(
    "channels-create",
    "create_channel",
    (ctx) =>
      createChannel({
        name: ctx.fixture("channel"),
        channelType: "stream",
        visibility: "open",
        description: "parity oracle fixture channel",
      }),
    {
      fixtureArgs: ["name"],
      capture: (ctx, r) => {
        ctx.channelId = (r as { id: string }).id;
      },
    },
  ),
  step("channels-details", "get_channel_details", (ctx) =>
    getChannelDetails(ctx.channelId),
  ),
  step("channels-members", "get_channel_members", (ctx) =>
    getChannelMembers(ctx.channelId),
  ),
  step("channels-join", "join_channel", (ctx) => joinChannel(ctx.channelId)),
  step("channels-leave", "leave_channel", (ctx) => leaveChannel(ctx.channelId)),
  step("channels-topic", "set_channel_topic", (ctx) =>
    setChannelTopic({ channelId: ctx.channelId, topic: "parity oracle topic" }),
  ),
  step("channels-purpose", "set_channel_purpose", (ctx) =>
    setChannelPurpose({
      channelId: ctx.channelId,
      purpose: "parity oracle purpose",
    }),
  ),
  step("channels-update", "update_channel", (ctx) =>
    updateChannel({
      channelId: ctx.channelId,
      name: `${ctx.fixture("channel")}-renamed`,
      visibility: "open",
    }),
  ),
  step("channels-archive", "archive_channel", (ctx) =>
    archiveChannel(ctx.channelId),
  ),
  step("channels-unarchive", "unarchive_channel", (ctx) =>
    unarchiveChannel(ctx.channelId),
  ),
  // ── live relay subscription (push traffic) ────────────────────────────────
  // A second WebSocket to the local relay, its Channel created AFTER the
  // recorder attached, so every relay push the script's REQ receives is
  // recorded. The REQ retargets to the live channel on replay (jsonArgs),
  // and the ws id is remapped by the harness (wsIdMap).
  step(
    "relay-sub-connect",
    "plugin:websocket|connect",
    (ctx) => {
      // A handler is REQUIRED: the shim's Channel wrapper records from the
      // constructor callback, and without one the base Channel never wires an
      // onmessage handler, so relay pushes would be delivered to nothing and
      // the trace would record zero pushes. The handler also captures the
      // NIP-42 AUTH challenge so the auth step can sign it.
      const onMessage = new NativeChannel<unknown>((message) => {
        if (typeof message === "object" && message !== null) {
          const wire = message as { type?: unknown; data?: unknown };
          if (wire.type === "Text" && typeof wire.data === "string") {
            try {
              const parsed = JSON.parse(wire.data) as unknown;
              if (
                Array.isArray(parsed) &&
                parsed[0] === "AUTH" &&
                typeof parsed[1] === "string"
              ) {
                ctx.authChallenge = parsed[1];
              }
            } catch {
              // Not a wire array; not the challenge.
            }
          }
        }
      });
      return invokeTauri("plugin:websocket|connect", {
        url: ctx.relayWsUrl,
        onMessage,
        config: {},
      });
    },
    {
      capture: (ctx, r) => {
        ctx.relayWsId = r as number;
      },
    },
  ),
  step("relay-sub-auth", "plugin:websocket|send", async (ctx) => {
    // The relay closes unauthenticated connections after AUTH_TIMEOUT (5s,
    // connection.rs) and rejects REQs with "auth-required", so the script
    // answers the NIP-42 challenge: wait for it, sign it, send AUTH. On
    // replay the harness re-signs from the live challenge instead of
    // replaying the recorded (stale) event.
    const challenge = await waitForAuthChallenge(ctx);
    const event = await createAuthEvent({
      challenge,
      relayUrl: ctx.relayWsUrl,
    });
    return invokeTauri("plugin:websocket|send", {
      id: ctx.relayWsId,
      message: { type: "Text", data: JSON.stringify(["AUTH", event]) },
    });
  }),
  step(
    "relay-sub-req",
    "plugin:websocket|send",
    (ctx) => {
      const subId = `live-${crypto.randomUUID()}`;
      ctx.relaySubId = subId;
      const filter = {
        kinds: CHANNEL_EVENT_KINDS,
        "#h": [ctx.channelId],
        limit: 50,
      };
      return invokeTauri("plugin:websocket|send", {
        id: ctx.relayWsId,
        message: { type: "Text", data: JSON.stringify(["REQ", subId, filter]) },
      });
    },
    {
      jsonArgs: [{ path: "message.data", rewrite: { "2.#h.0": "channelId" } }],
    },
  ),
  step("channels-delete-bogus", "delete_channel", () =>
    deleteChannel(BOGUS_UUID),
  ),
  step("channels-open-dm-bogus", "open_dm", () =>
    openDm({ pubkeys: [BOGUS_PUBKEY] }),
  ),
  step("channels-hide-dm-bogus", "hide_dm", () => hideDm(BOGUS_UUID)),

  // ── messages ──────────────────────────────────────────────────────────────
  step(
    "messages-send",
    "send_channel_message",
    (ctx) =>
      sendChannelMessage(
        ctx.channelId,
        `parity-oracle probe message ${ctx.runId}`,
      ),
    {
      capture: (ctx, r) => {
        const result = r as { eventId: string; createdAt: number };
        ctx.messageId = result.eventId;
        ctx.messageCreatedAt = result.createdAt;
      },
    },
  ),
  step("messages-get-event", "get_event", (ctx) => getEventById(ctx.messageId)),
  step("messages-thread-replies", "get_thread_replies", (ctx) =>
    getThreadReplies(ctx.messageId, ctx.channelId, { limit: 20 }),
  ),
  step(
    "messages-search",
    "search_messages",
    () => searchMessages({ q: "parity-oracle", limit: 20 }),
    {
      replayable: false,
      reason:
        "the relay search index accumulates events from prior sessions; hit sets differ run to run",
    },
  ),
  // Replay targets the LIVE message (capture rewrite), so add+remove are
  // idempotent across record and replay — and their relay events are part
  // of the push traffic both sides must carry.
  step("messages-reaction-add", "add_reaction", (ctx) =>
    addReaction(ctx.messageId, "✅"),
  ),
  step("messages-reaction-remove", "remove_reaction", (ctx) =>
    removeReaction(ctx.messageId, "✅"),
  ),
  step("messages-edit", "edit_message", (ctx) =>
    editMessage(
      ctx.channelId,
      ctx.messageId,
      `parity-oracle edited ${ctx.runId}`,
    ),
  ),
  // The cursor is `messageCreatedAt + 1`: `until` is inclusive with an
  // event-id tiebreak, so a cursor inside the message's own second draws a
  // different page on each run depending on which same-second event ids sort
  // around the message id. A cursor one second past the message includes the
  // whole second deterministically on both sides.
  step("messages-before", "get_channel_messages_before", (ctx) =>
    getChannelMessagesBefore(
      ctx.channelId,
      { createdAt: ctx.messageCreatedAt + 1, eventId: ctx.messageId },
      10,
    ),
  ),
  step("messages-feed", "get_feed", () => getHomeFeed({ limit: 20 })),
  step("messages-forum-posts", "get_forum_posts", (ctx) =>
    getForumPosts(ctx.channelId, 20),
  ),
  step("messages-forum-thread", "get_forum_thread", (ctx) =>
    getForumThread(ctx.channelId, ctx.messageId),
  ),
  // Replay targets the LIVE message, so record and replay both end with
  // the fixture channel empty — get_channel_window sees the same events on
  // both sides.
  step("messages-delete", "delete_message", (ctx) =>
    deleteMessage(ctx.channelId, ctx.messageId),
  ),

  // ── social ────────────────────────────────────────────────────────────────
  step(
    "social-timeline",
    "get_notes_timeline",
    (ctx) => getNotesTimeline([ctx.identityPubkey], 10),
    {
      replayable: false,
      reason:
        "notes persist on the relay; the timeline accumulates across runs",
    },
  ),
  step("social-global-notes", "get_global_notes", () => getGlobalNotes(), {
    replayable: false,
    reason:
      "notes persist on the relay; the global feed accumulates across runs",
  }),
  step("social-liked-notes", "get_liked_notes", (ctx) =>
    getLikedNotes(ctx.identityPubkey),
  ),
  step("social-note-bogus", "get_note", () => getNote(BOGUS_UUID)),
  step("social-note-reactions-bogus", "get_note_reactions", () =>
    getNoteReactions([BOGUS_UUID]),
  ),
  step("social-contact-list", "get_contact_list", (ctx) =>
    getContactList(ctx.identityPubkey),
  ),
  step("social-set-contact-list", "set_contact_list", () => setContactList([])),
  step("social-publish-note", "publish_note", (ctx) =>
    publishNote(`parity-oracle note ${ctx.runId}`),
  ),
  step(
    "social-user-notes",
    "get_user_notes",
    (ctx) => getUserNotes(ctx.identityPubkey, { limit: 10 }),
    {
      replayable: false,
      reason:
        "notes persist on the relay; the user's note list accumulates across runs",
    },
  ),

  // ── presence ──────────────────────────────────────────────────────────────
  step("presence-get", "get_presence", (ctx) =>
    getPresence([ctx.identityPubkey]),
  ),

  // ── relay members ─────────────────────────────────────────────────────────
  step("relay-members-mine", "get_my_relay_membership", () =>
    getMyRelayMembership(),
  ),
  step("relay-members-list", "list_relay_members", () => listRelayMembers()),
  step("relay-members-requires", "relay_requires_membership", () =>
    invokeTauri<boolean>("relay_requires_membership"),
  ),
  step("relay-members-add-bogus", "add_relay_member", () =>
    addRelayMember(BOGUS_PUBKEY, "member"),
  ),
  step("relay-members-remove-bogus", "remove_relay_member", () =>
    removeRelayMember(BOGUS_PUBKEY),
  ),
  step("relay-members-change-role-bogus", "change_relay_member_role", () =>
    changeRelayMemberRole(BOGUS_PUBKEY, "admin"),
  ),

  // ── huddle / audio ────────────────────────────────────────────────────────
  step("huddle-agents", "get_huddle_agent_pubkeys", () =>
    invokeTauri("get_huddle_agent_pubkeys"),
  ),
  step("huddle-confirm-idle", "confirm_huddle_active", () =>
    invokeTauri("confirm_huddle_active"),
  ),
  step("huddle-voice-mode", "get_voice_input_mode", () =>
    invokeTauri("get_voice_input_mode"),
  ),
  step("huddle-set-voice-mode", "set_voice_input_mode", () =>
    invokeTauri("set_voice_input_mode", { mode: "push_to_talk" }),
  ),
  step("huddle-set-voice-mode-back", "set_voice_input_mode", () =>
    invokeTauri("set_voice_input_mode", { mode: "voice_activity" }),
  ),
  step("huddle-tts-on", "set_tts_enabled", () =>
    invokeTauri("set_tts_enabled", { enabled: true }),
  ),
  step("huddle-tts-off", "set_tts_enabled", () =>
    invokeTauri("set_tts_enabled", { enabled: false }),
  ),
  // The state snapshot comes AFTER the setters so record and replay observe
  // the same deterministic state (voice_activity, tts off) instead of
  // whatever the previous run left behind.
  step("huddle-state", "get_huddle_state", () =>
    invokeTauri("get_huddle_state"),
  ),
  step("huddle-pipeline-hotstart", "check_pipeline_hotstart", () =>
    invokeTauri("check_pipeline_hotstart"),
  ),
  step("huddle-model-status", "get_model_status", () =>
    invokeTauri("get_model_status"),
  ),
  step("huddle-speak", "speak_agent_message", () =>
    invokeTauri("speak_agent_message", { text: "parity oracle tts probe" }),
  ),
  step("huddle-add-agent-bogus", "add_agent_to_huddle", () =>
    invokeTauri("add_agent_to_huddle", { agentPubkey: BOGUS_PUBKEY }),
  ),
  step("huddle-audio-device-bogus", "set_audio_output_device", () =>
    invokeTauri("set_audio_output_device", {
      name: "parity-oracle-bogus-device",
    }),
  ),
  // Get AFTER the set: the selection is in-memory, so the snapshot is the
  // deterministic fixture value on both record and replay.
  step("huddle-audio-device", "get_audio_output_device", () =>
    invokeTauri("get_audio_output_device"),
  ),
  step("huddle-audio-devices", "list_audio_output_devices", () =>
    invokeTauri("list_audio_output_devices"),
  ),
  step("huddle-transcription-off", "set_huddle_transcription_enabled", () =>
    invokeTauri("set_huddle_transcription_enabled", { enabled: false }),
  ),

  // ── pairing ───────────────────────────────────────────────────────────────
  step("pairing-confirm-without-session", "confirm_pairing_sas", () =>
    confirmPairingSas(),
  ),
  step("pairing-start", "start_pairing", () => startPairing()),
  step("pairing-cancel", "cancel_pairing", () => cancelPairing()),

  // ── prevent sleep ─────────────────────────────────────────────────────────
  step("prevent-sleep-on", "set_prevent_sleep_active", () =>
    invokeTauri("set_prevent_sleep_active", { active: true }),
  ),
  step("prevent-sleep-off", "set_prevent_sleep_active", () =>
    invokeTauri("set_prevent_sleep_active", { active: false }),
  ),

  // ── archive / save subscriptions ──────────────────────────────────────────
  step("archive-observer-default", "observer_archive_default_enabled", () =>
    observerArchiveDefaultEnabled(),
  ),
  step(
    "archive-agent-metric-default",
    "agent_metric_archive_default_enabled",
    () => agentMetricArchiveDefaultEnabled(),
  ),
  step("archive-create-sub", "create_save_subscription", (ctx) =>
    createSaveSubscription("channel_h", ctx.channelId, [9, 40002]),
  ),
  step("archive-merge-kinds", "merge_save_subscription_kinds", () =>
    mergeSaveSubscriptionKinds(45001),
  ),
  step("archive-remove-kind", "remove_save_subscription_kind", () =>
    removeSaveSubscriptionKind(9),
  ),
  // Listed AFTER the mutations so both record and replay observe the same
  // post-mutation row state; on replay the create targets the LIVE channel
  // (REPLAY_CAPTURES arg rewrite), so the list matches row for row.
  step("archive-list-subs", "list_save_subscriptions", () =>
    listSaveSubscriptions(),
  ),
  step("archive-delete-sub-bogus", "delete_save_subscription", () =>
    deleteSaveSubscription("channel_h", BOGUS_UUID),
  ),
  step("archive-events-empty", "archive_events", () => archiveEvents([])),
  step("archive-read", "read_archived_events", (ctx) =>
    readArchivedEvents("channel_h", ctx.channelId, { limit: 20 }),
  ),
  step(
    "archive-read-observer",
    "read_archived_observer_events_for_channel",
    (ctx) => readArchivedObserverEventsForChannel(ctx.channelId),
  ),
  step("archive-index-observer", "index_observer_channel_id", () =>
    indexObserverChannelId([
      { eventId: BOGUS_UUID, channelId: null, createdAt: 0 },
    ]),
  ),
  step("archive-unindexed", "read_unindexed_observer_rows", () =>
    readUnindexedObserverRows(),
  ),

  // ── engrams ───────────────────────────────────────────────────────────────
  step("engrams-memory", "get_agent_memory", (ctx) =>
    getAgentMemory(ctx.identityPubkey),
  ),

  // ── workflows ─────────────────────────────────────────────────────────────
  step("workflows-channel", "get_channel_workflows", (ctx) =>
    getChannelWorkflows(ctx.channelId),
  ),
  step("workflows-channels", "get_channels_workflows", (ctx) =>
    getChannelsWorkflows([ctx.channelId]),
  ),
  // NOTE: no fixtureArgs on the YAML — the definition embeds the fixture
  // name inside a larger document, and replay must re-invoke the recorded
  // YAML verbatim (a whole-string replacement would yield invalid YAML).
  step(
    "workflows-create",
    "create_workflow",
    (ctx) =>
      createWorkflow(ctx.channelId, WORKFLOW_YAML(ctx.fixture("workflow"))),
    {
      capture: (ctx, r) => {
        ctx.workflowId = (r as { workflow: { id: string } }).workflow.id;
      },
    },
  ),
  step("workflows-get", "get_workflow", (ctx) => getWorkflow(ctx.workflowId)),
  step("workflows-update", "update_workflow", (ctx) =>
    updateWorkflow(ctx.workflowId, WORKFLOW_YAML(ctx.fixture("workflow"))),
  ),
  step("workflows-runs", "get_workflow_runs", (ctx) =>
    getWorkflowRuns(ctx.workflowId),
  ),
  step("workflows-approvals", "get_run_approvals", (ctx) =>
    getRunApprovals(ctx.workflowId, BOGUS_UUID),
  ),
  step("workflows-trigger", "trigger_workflow", (ctx) =>
    triggerWorkflow(ctx.workflowId),
  ),
  step("workflows-grant-bogus", "grant_approval", () =>
    grantApproval(BOGUS_UUID, "parity-oracle"),
  ),
  step("workflows-deny-bogus", "deny_approval", () => denyApproval(BOGUS_UUID)),
  step(
    "workflows-delete",
    "delete_workflow",
    (ctx) => deleteWorkflow(ctx.workflowId),
    {
      replayable: false,
      reason: "deletes the workflow created in the record phase",
    },
  ),

  // ── teams ─────────────────────────────────────────────────────────────────
  step("teams-list", "list_teams", () => listTeams()),
  step(
    "teams-create",
    "create_team",
    (ctx) =>
      createTeam({
        name: ctx.fixture("team"),
        description: "parity oracle fixture team",
        instructions: "no-op",
        personaIds: [],
      }),
    {
      fixtureArgs: ["input.name"],
      capture: (ctx, r) => {
        ctx.teamId = (r as { id: string }).id;
      },
    },
  ),
  step("teams-update", "update_team", (ctx) =>
    updateTeam({
      id: ctx.teamId,
      name: ctx.fixture("team"),
      description: "parity oracle fixture team updated",
      instructions: "no-op",
      personaIds: [],
    }),
  ),
  step("teams-encode", "encode_team_snapshot_for_send", (ctx) =>
    encodeTeamSnapshotForSend(ctx.teamId, "none", "json"),
  ),
  step("teams-delete-bogus", "delete_team", () => deleteTeam(BOGUS_UUID)),
  step("teams-preview-bogus", "preview_team_snapshot_import", () =>
    previewTeamSnapshotImport([], "parity-oracle-team.json"),
  ),
  step("teams-confirm-bogus", "confirm_team_snapshot_import", () =>
    confirmTeamSnapshotImport({ fileBytes: [], keepAllowlist: false }),
  ),

  // ── personas ──────────────────────────────────────────────────────────────
  step("personas-list", "list_personas", () => listPersonas(), {
    replayable: false,
    reason:
      "execute_agent_proposal creates a persona during the record phase that persists into replay",
  }),
  step(
    "personas-create",
    "create_persona",
    (ctx) =>
      createPersona({
        displayName: ctx.fixture("persona"),
        roleId: "parity-oracle",
        roleTitle: "Parity Oracle Fixture",
        systemPrompt: "You are a parity oracle fixture.",
        namePool: [],
      }),
    {
      fixtureArgs: ["input.displayName"],
      capture: (ctx, r) => {
        ctx.personaId = (r as { id: string }).id;
      },
    },
  ),
  step("personas-update", "update_persona", (ctx) =>
    updatePersona({
      id: ctx.personaId,
      displayName: ctx.fixture("persona"),
      roleId: "parity-oracle",
      roleTitle: "Parity Oracle Fixture",
      systemPrompt: "You are a parity oracle fixture.",
      namePool: [],
    }),
  ),
  step("personas-active", "set_persona_active", (ctx) =>
    setPersonaActive(ctx.personaId, true),
  ),
  step("personas-shared", "set_persona_shared", (ctx) =>
    setPersonaShared(ctx.personaId, false),
  ),
  step("personas-encode", "encode_agent_snapshot_for_send", (ctx) =>
    encodeAgentSnapshotForSend(ctx.personaId, "none", "json"),
  ),
  step("personas-delete-bogus", "delete_persona", () =>
    deletePersona(BOGUS_UUID),
  ),
  step("personas-preview-bogus", "preview_agent_snapshot_import", () =>
    previewAgentSnapshotImport([], "parity-oracle-agent.json"),
  ),
  step("personas-confirm-bogus", "confirm_agent_snapshot_import", () =>
    confirmAgentSnapshotImport({ fileBytes: [], keepAllowlist: false }),
  ),
  step("personas-inbound", "reconcile_inbound_persona_event", (ctx) =>
    signRelayEvent({
      kind: 30175,
      content: JSON.stringify({
        display_name: ctx.fixture("inbound-persona"),
        role_id: "parity-oracle",
        role_title: "Parity Oracle Inbound",
      }),
      tags: [["d", ctx.fixture("inbound-dtag")]],
    }).then((event) =>
      reconcileInboundPersonaEvent(JSON.stringify(event), ctx.relayWsUrl),
    ),
  ),

  // ── channel templates ─────────────────────────────────────────────────────
  step("templates-list", "list_channel_templates", () =>
    listChannelTemplates(),
  ),
  step(
    "templates-create",
    "create_channel_template",
    (ctx) =>
      createChannelTemplate({
        name: ctx.fixture("template"),
        description: "parity oracle fixture template",
        channelType: "stream",
        visibility: "open",
        canvasTemplate: "",
        agents: { personas: [], teams: [] },
      }),
    {
      fixtureArgs: ["input.name"],
      capture: (ctx, r) => {
        ctx.templateId = (r as { id: string }).id;
      },
    },
  ),
  step("templates-update", "update_channel_template", (ctx) =>
    updateChannelTemplate({
      id: ctx.templateId,
      name: ctx.fixture("template"),
      description: "parity oracle fixture template updated",
      channelType: "stream",
      visibility: "open",
      canvasTemplate: "",
      agents: { personas: [], teams: [] },
    }),
  ),
  step(
    "templates-duplicate",
    "duplicate_channel_template",
    (ctx) => duplicateChannelTemplate(ctx.templateId),
    {
      capture: (ctx, r) => {
        ctx.duplicateTemplateId = (r as { id: string }).id;
      },
    },
  ),
  step("templates-delete-bogus", "delete_channel_template", () =>
    deleteChannelTemplate(BOGUS_UUID),
  ),

  // ── canvas / channel window / block data ──────────────────────────────────
  step("canvas-get", "get_canvas", (ctx) => getCanvas(ctx.channelId)),
  step("canvas-set", "set_canvas", (ctx) =>
    setCanvas({
      channelId: ctx.channelId,
      content: `parity-oracle canvas ${ctx.runId}`,
    }),
  ),
  step("channel-window", "get_channel_window", (ctx) =>
    getChannelWindowEvents(ctx.channelId, null, 20),
  ),
  // Member lifecycle ops run AFTER the last channel-history read. The relay
  // materializes each membership mutation as a 40099 system message
  // asynchronously, and that materialization is racy — it may or may not
  // land before the next read. With the ops after `get_channel_window`, no
  // compared read can ever observe the materialized events, and the push
  // path still sees them on both sides (the subscription stays open).
  step("channels-add-members-bogus", "add_channel_members", (ctx) =>
    addChannelMembers({ channelId: ctx.channelId, pubkeys: [BOGUS_PUBKEY] }),
  ),
  step("channels-remove-member-bogus", "remove_channel_member", (ctx) =>
    removeChannelMember(ctx.channelId, BOGUS_PUBKEY),
  ),
  step("channels-change-role-bogus", "change_channel_member_role", (ctx) =>
    changeChannelMemberRole(ctx.channelId, BOGUS_PUBKEY, "admin"),
  ),
  step("block-data-bogus", "fetch_block_data", () =>
    fetchBlockData({
      url: "https://localhost/nonexistent/parity-oracle.json",
      mime: "application/json",
      sha256: "0".repeat(64),
      byteSize: 0,
    }),
  ),

  // ── link preview / media ──────────────────────────────────────────────────
  step("link-preview", "fetch_link_preview_title", () =>
    invokeTauri("fetch_link_preview_title", { href: "https://example.com" }),
  ),
  step("media-upload-bytes", "upload_media_bytes", (ctx) =>
    uploadMediaBytes(
      Array.from(TINY_PNG),
      "parity-oracle.png",
      ctx.fixture("upload-progress"),
    ),
  ),
  step("media-fetch-bogus", "fetch_media_bytes", () =>
    fetchMediaBytes("https://localhost/nonexistent/parity-oracle.bin"),
  ),
  step("media-fetch-snapshot-bogus", "fetch_snapshot_bytes", () =>
    fetchSnapshotBytes({
      url: "https://localhost/nonexistent/parity-oracle.bin",
      filename: "parity-oracle.bin",
      expectedSha256: "0".repeat(64),
      expectedSize: 0,
    }),
  ),
  step("media-copy-text", "copy_text_to_clipboard", () =>
    copyTextToSystemClipboard("parity oracle clipboard probe"),
  ),
  step("media-download-bogus", "download_file", () =>
    invokeTauri("download_file", {
      url: "https://localhost/nonexistent/parity-oracle.bin",
    }),
  ),
  step("media-download-image-bogus", "download_image", () =>
    invokeTauri("download_image", {
      url: "https://localhost/nonexistent/parity-oracle.png",
    }),
  ),
  step("media-copy-image-bogus", "copy_image_to_clipboard", () =>
    invokeTauri("copy_image_to_clipboard", {
      url: "https://localhost/nonexistent/parity-oracle.png",
    }),
  ),
  step("media-upload-url-bogus", "upload_media", () =>
    invokeTauri("upload_media", {
      url: "https://localhost/nonexistent/parity-oracle.bin",
    }),
  ),

  // ── workspace ─────────────────────────────────────────────────────────────
  step("workspace-active", "get_active_workspace", () =>
    invokeTauri("get_active_workspace"),
  ),
  step("workspace-validate-empty", "validate_repos_dir", () =>
    validateReposDir(""),
  ),
  step("workspace-validate-bad", "validate_repos_dir", () =>
    validateReposDir(BOGUS_REPO),
  ),
  step("workspace-apply-bad-repos", "apply_workspace", (ctx) =>
    applyCommunity(ctx.relayWsUrl, undefined, undefined, BOGUS_REPO, false),
  ),
  step("workspace-icon-bogus", "fetch_workspace_icon", () =>
    invokeTauri("fetch_workspace_icon", { workspaceId: BOGUS_UUID }),
  ),

  // ── project git ───────────────────────────────────────────────────────────
  step("git-identity", "get_git_identity", () => getGitIdentity()),
  step("git-list-local", "list_project_local_repositories", () =>
    listProjectLocalRepositories({ reposDir: null }),
  ),
  step("git-local-snapshot-bogus", "get_project_local_repo_snapshot", () =>
    getProjectLocalRepoSnapshot({
      reposDir: BOGUS_REPO,
      projectDtag: BOGUS_UUID,
    }),
  ),
  step("git-repo-snapshot-bogus", "get_project_repo_snapshot", () =>
    getProjectRepoSnapshot({ cloneUrl: BOGUS_CLONE_URL }),
  ),
  step("git-sync-status-bogus", "get_project_repo_sync_status", () =>
    getProjectRepoSyncStatus({
      projectDtag: BOGUS_UUID,
      cloneUrl: BOGUS_CLONE_URL,
    }),
  ),
  step("git-local-diff-bogus", "get_project_local_repo_diff", () =>
    getProjectLocalRepoDiff({ reposDir: BOGUS_REPO, projectDtag: BOGUS_UUID }),
  ),
  step("git-repo-diff-bogus", "get_project_repo_diff", () =>
    getProjectRepoDiff({ cloneUrl: BOGUS_CLONE_URL }),
  ),
  step("git-pull-bogus", "pull_project_local_repository", () =>
    pullProjectLocalRepository({
      projectDtag: BOGUS_UUID,
      cloneUrl: BOGUS_CLONE_URL,
    }),
  ),
  step("git-push-bogus", "push_project_local_repository", () =>
    pushProjectLocalRepository({
      projectDtag: BOGUS_UUID,
      cloneUrl: BOGUS_CLONE_URL,
    }),
  ),
  step("git-clone-bogus", "clone_project_repository", () =>
    cloneProjectRepository({
      projectDtag: BOGUS_UUID,
      cloneUrl: "https://localhost/nonexistent/parity-oracle.git",
    }),
  ),
  step("git-create-branch-bogus", "create_project_remote_branch", () =>
    createProjectRemoteBranch({
      cloneUrl: "https://localhost/nonexistent/parity-oracle.git",
      sourceBranch: "main",
      expectedCommit: "0".repeat(40),
      newBranch: "parity-oracle",
    }),
  ),
  step("git-delete-branch-bogus", "delete_project_remote_branch", () =>
    deleteProjectRemoteBranch({
      cloneUrl: "https://localhost/nonexistent/parity-oracle.git",
      branch: "parity-oracle",
      expectedCommit: "0".repeat(40),
    }),
  ),
  step("git-merge-pr-bogus", "merge_project_pull_request", () =>
    mergeProjectPullRequest({
      targetCloneUrl: BOGUS_CLONE_URL,
      sourceCloneUrl: BOGUS_CLONE_URL,
      targetOwner: BOGUS_PUBKEY,
      repoAddress: "parity-oracle",
      pullRequestId: BOGUS_UUID,
      pullRequestAuthor: BOGUS_PUBKEY,
      statusCreatedAt: 0,
      targetBranch: "main",
      sourceBranch: "parity-oracle",
      expectedCommit: "0".repeat(40),
    }),
  ),
  step(
    "git-publish-merged-bogus",
    "publish_project_pull_request_merged_status",
    () =>
      publishProjectPullRequestMergedStatus({
        targetOwner: BOGUS_PUBKEY,
        statusEvent: "0".repeat(64),
      }),
  ),
  step(
    "git-sign-review-bogus",
    "sign_project_pull_request_review_request",
    () =>
      signProjectPullRequestReviewRequest({
        targetOwner: BOGUS_PUBKEY,
        repoAddress: "parity-oracle",
        pullRequestId: BOGUS_UUID,
        reviewers: [BOGUS_PUBKEY],
        reviewerLabel: "parity-oracle",
      }),
  ),
  step("git-sign-status-bogus", "sign_project_pull_request_status", () =>
    signProjectPullRequestStatus({
      targetOwner: BOGUS_PUBKEY,
      repoAddress: "parity-oracle",
      pullRequestId: BOGUS_UUID,
      pullRequestAuthor: BOGUS_PUBKEY,
      status: "open",
      createdAt: 0,
    }),
  ),
  step("git-open-terminal-bogus", "open_project_terminal", () =>
    openProjectTerminal({ projectDtag: BOGUS_UUID, cloneUrl: BOGUS_CLONE_URL }),
  ),
  step(
    "git-open-merge-terminal-bogus",
    "open_project_merge_recovery_terminal",
    () =>
      openProjectMergeRecoveryTerminal({
        projectDtag: BOGUS_UUID,
        targetCloneUrl: BOGUS_CLONE_URL,
        sourceCloneUrl: BOGUS_CLONE_URL,
        targetBranch: "main",
        sourceBranch: "parity-oracle",
        expectedCommit: "0".repeat(40),
      }),
  ),

  // ── ledger / initiative / company blueprint / colony ──────────────────────
  step("ledger-report", "ledger_report", () => loadLedgerReport()),
  step("ledger-add-price", "ledger_add_price", (ctx) =>
    publishPrice({
      model: ctx.fixture("model"),
      inputPerMtok: "1.0",
      cacheReadPerMtok: "0.5",
      cacheWrite5mPerMtok: "1.0",
      cacheWrite1hPerMtok: "1.0",
      outputPerMtok: "2.0",
      effectiveFrom: new Date().toISOString(),
      note: "parity oracle fixture",
    }),
  ),
  step("ledger-correct-bogus", "ledger_correct", () =>
    submitCorrection({
      usageRecordEventId: BOGUS_UUID,
      companyId: BOGUS_UUID,
      costCentreId: BOGUS_UUID,
      owningTeamId: BOGUS_UUID,
      commercialPurpose: "internalProduct",
      clientOrganizationId: null,
      taskId: null,
      reason: "parity oracle",
    }),
  ),
  step("initiative-chat-task", "ensure_chat_task", (ctx) =>
    ensureChatTask({
      companyHead: BOGUS_UUID,
      channelId: ctx.channelId,
      sendId: ctx.messageId,
      agentPubkey: ctx.identityPubkey,
      title: "parity oracle task",
      clientOrganizationId: null,
      relayPubkey: BOGUS_PUBKEY,
    }),
  ),
  step("initiative-advance-bogus", "advance_initiative", () =>
    advanceInitiative({
      companyHead: BOGUS_UUID,
      initiativeHead: BOGUS_UUID,
      relayPubkey: BOGUS_PUBKEY,
      intent: "start",
    }),
  ),
  step("blueprint-execute-bogus", "execute_company_blueprint", () =>
    executeCompanyBlueprint({
      blueprint: "parity-oracle-bogus",
      requestId: BOGUS_UUID,
      communityScope: BOGUS_UUID,
      expectedHash: "0".repeat(64),
      relayPubkey: BOGUS_PUBKEY,
      channelId: BOGUS_UUID,
    }),
  ),
  step("blueprint-complete-bogus", "complete_company_blueprint", () =>
    completeCompanyBlueprint({
      requestId: BOGUS_UUID,
      communityScope: BOGUS_UUID,
      companyEventId: BOGUS_UUID,
    }),
  ),
  step("colony-check-name", "colony_check_community_name", (ctx) =>
    invokeTauri("colony_check_community_name", {
      name: ctx.fixture("community"),
    }),
  ),
  step(
    "colony-create",
    "colony_create_community",
    (ctx) =>
      invokeTauri("colony_create_community", {
        name: ctx.fixture("community"),
      }),
    { fixtureArgs: ["name"] },
  ),
  step("colony-list", "colony_list_my_communities", () =>
    invokeTauri("colony_list_my_communities"),
  ),

  // ── deep link / legacy / observer / identity archive ──────────────────────
  step("deep-link-take-pending", "take_pending_community_deep_link", () =>
    invokeTauri("take_pending_community_deep_link"),
  ),
  step("deep-link-ack-pending", "acknowledge_pending_community_deep_link", () =>
    invokeTauri("acknowledge_pending_community_deep_link"),
  ),
  step("legacy-storage", "get_legacy_workspace_storage", () =>
    invokeTauri("get_legacy_workspace_storage"),
  ),
  step("observer-control-bogus", "build_observer_control_event", () =>
    buildObserverControlEvent({
      agentPubkey: BOGUS_PUBKEY,
      payload: { action: "parity-oracle" },
    }),
  ),
  step("observer-decrypt-bogus", "decrypt_observer_event", () =>
    decryptObserverEvent({
      id: BOGUS_UUID,
      pubkey: BOGUS_PUBKEY,
      created_at: 0,
      kind: 4,
      tags: [],
      content: "parity-oracle",
      sig: "0".repeat(128),
    }),
  ),
  step("identity-archive-self", "get_relay_self", () => getRelaySelf()),
  step(
    "identity-archive-list",
    "list_archived_identities",
    () => listArchivedIdentities(),
    {
      replayable: false,
      reason:
        "relay-owned 13535 snapshot; changes asynchronously outside the session",
    },
  ),
  step("identity-archive-owner-bogus", "resolve_oa_owner", () =>
    resolveOaOwner(BOGUS_PUBKEY),
  ),
  step("identity-archive-unarchive-bogus", "unarchive_identity", () =>
    unarchiveIdentity({
      targetPubkey: BOGUS_PUBKEY,
      content: "parity-oracle",
      reason: "parity oracle",
    }),
  ),

  // ── agent config / models / discovery / runtime ───────────────────────────
  step("agent-config-surface", "get_agent_config_surface", (ctx) =>
    getAgentConfigSurface(ctx.identityPubkey),
  ),
  step("agent-config-baked-keys", "get_baked_build_env_keys", () =>
    getBakedBuildEnvKeys(),
  ),
  step("agent-config-baked", "get_baked_build_env", () => getBakedBuildEnv()),
  step("agent-config-runtime-file", "get_runtime_file_config", () =>
    getRuntimeFileConfig("parity-oracle"),
  ),
  step("agent-config-session", "put_agent_session_config", (ctx) =>
    putAgentSessionConfig(ctx.identityPubkey, { parityOracle: "fixture" }),
  ),
  step("agent-global-config-get", "get_global_agent_config", () =>
    getGlobalAgentConfig(),
  ),
  step("agent-global-config-set", "set_global_agent_config", () =>
    setGlobalAgentConfig({
      env_vars: {},
      provider: null,
      model: null,
      preferred_runtime: null,
      credential_mode: "byok",
    }),
  ),
  step("agent-models-discover", "discover_agent_models", () =>
    invokeTauri("discover_agent_models"),
  ),
  step("agent-models-get", "get_agent_models", (ctx) =>
    getAgentModels(ctx.identityPubkey),
  ),
  step("agent-update-bogus", "update_managed_agent", () =>
    updateManagedAgent({ pubkey: BOGUS_PUBKEY, name: "parity-oracle" }),
  ),
  step("agent-list", "list_managed_agents", () => listManagedAgents(), {
    replayable: false,
    reason:
      "the record phase's execute_agent_proposal spawns a managed agent that persists into replay",
  }),
  step("agent-log-bogus", "get_managed_agent_log", () =>
    getManagedAgentLog(BOGUS_PUBKEY, 10),
  ),
  step(
    "agent-send-message-bogus",
    "send_managed_agent_channel_message",
    (ctx) =>
      sendManagedAgentChannelMessage({
        agentPubkey: BOGUS_PUBKEY,
        channelId: ctx.channelId,
        content: "parity-oracle",
      }),
  ),
  step(
    "agent-message-marker",
    "has_managed_agent_channel_message_marker",
    (ctx) =>
      hasManagedAgentChannelMessageMarker({
        channelId: ctx.channelId,
        marker: "parity-oracle",
        agentPubkey: BOGUS_PUBKEY,
        markerScope: "channel",
      }),
  ),
  step("runtime-list", "list_managed_agent_runtimes", () =>
    listManagedAgentRuntimes(),
  ),
  step("runtime-put-bogus", "put_managed_agent_runtime_lifecycle", () =>
    putManagedAgentRuntimeLifecycle(BOGUS_PUBKEY, {
      relayUrl: "ws://localhost:3000",
      lifecycle: "stopped",
    }),
  ),
  step("runtime-reconcile", "reconcile_managed_agent_runtimes", () =>
    reconcileManagedAgentRuntimes([]),
  ),
  step("runtime-start-bogus", "start_managed_agent_runtime", () =>
    startManagedAgentRuntime(BOGUS_PUBKEY, "ws://localhost:3000"),
  ),
  step("runtime-stop-bogus", "stop_managed_agent_runtime", () =>
    stopManagedAgentRuntime(BOGUS_PUBKEY, "ws://localhost:3000"),
  ),
  step("runtime-restart-bogus", "restart_managed_agent_runtime", () =>
    restartManagedAgentRuntime(BOGUS_PUBKEY, "ws://localhost:3000"),
  ),
  step("agent-settings-profiles", "set_agent_managed_profiles", () =>
    invokeTauri("set_agent_managed_profiles", { enabled: false }),
  ),
  step("agent-settings-restart-bogus", "set_managed_agent_auto_restart", () =>
    setManagedAgentAutoRestart(BOGUS_PUBKEY, false),
  ),
  step(
    "agent-settings-launch-bogus",
    "set_managed_agent_start_on_app_launch",
    () => setManagedAgentStartOnAppLaunch(BOGUS_PUBKEY, false),
  ),
  step("agent-auth-methods-bogus", "discover_acp_auth_methods", () =>
    discoverAcpAuthMethods("parity-oracle-bogus-runtime"),
  ),
  step("agent-auth-connect-bogus", "connect_acp_runtime", () =>
    connectAcpRuntime("parity-oracle-bogus-runtime", "parity-oracle"),
  ),
  step(
    "agent-proposal-bogus",
    "execute_agent_proposal",
    (ctx) =>
      executeAgentProposal(
        {
          requestId: BOGUS_UUID,
          definition: {
            displayName: "Parity Oracle",
            systemPrompt: "no-op",
          },
          runOn: { type: "local" },
        },
        ctx.relayWsUrl,
      ),
    {
      replayable: false,
      reason:
        "spawns a real managed agent; the record phase's agent persists into replay and the proposal would report recovered=true instead of a fresh create",
    },
  ),
  step("agent-providers-discover", "discover_backend_providers", () =>
    discoverBackendProviders(),
  ),
  step("agent-providers-probe-bogus", "probe_backend_provider", () =>
    probeBackendProvider("/nonexistent/parity-oracle-binary"),
  ),
  step("agent-discovery-acp-providers", "discover_acp_providers", () =>
    invokeTauri("discover_acp_providers"),
  ),
  step("agent-discovery-prereqs", "discover_managed_agent_prereqs", () =>
    discoverManagedAgentPrereqs({}),
  ),
  step("agent-discovery-git-bash", "discover_git_bash_prerequisite", () =>
    discoverGitBashPrerequisite(),
  ),
  step("agent-discovery-relay-agents", "list_relay_agents", () =>
    listRelayAgents(),
  ),
  step(
    "agent-discovery-save-harness",
    "save_custom_harness",
    (ctx) =>
      saveCustomHarness({
        id: "",
        label: ctx.fixture("harness"),
        command: "parity-oracle",
        args: [],
        env: {},
      }),
    { fixtureArgs: ["label"] },
  ),
  step("agent-discovery-delete-harness-bogus", "delete_custom_harness", () =>
    deleteCustomHarness(BOGUS_UUID),
  ),
  step("agent-discovery-install-bogus", "install_acp_runtime", () =>
    installAcpRuntime("parity-oracle-bogus"),
  ),

  // ── mesh ──────────────────────────────────────────────────────────────────
  step("mesh-catalog", "mesh_model_catalog", () => meshModelCatalog()),
  step("mesh-status", "mesh_node_status", () => meshNodeStatus()),
  step("mesh-serving-usage", "mesh_serving_usage", () => meshServingUsage()),
  step("mesh-installed", "mesh_installed_models", () => meshInstalledModels()),
  step("mesh-start-bogus", "mesh_start_node", () =>
    meshStartNode({ mode: "serve", modelId: "parity-oracle-bogus" }),
  ),
  step("mesh-stop", "mesh_stop_node", () => meshStopNode()),

  // ── notifications / window / updater / misc ───────────────────────────────
  step("notify-show", "show_native_notification", () =>
    sendDesktopNotification({
      title: "Parity Oracle",
      body: "scripted session notification",
    }),
  ),
  step("os-idle", "get_os_idle_seconds", () => getOsIdleSeconds(), {
    replayable: false,
    reason: "wall-clock value; not comparable across runs",
  }),
  step("updater-supported", "is_auto_update_supported", () =>
    isAutoUpdateSupported(),
  ),
  step("haptic", "perform_sidebar_default_haptic", async () => {
    performSidebarDefaultHaptic();
  }),
  step("title-bar-double-click", "title_bar_double_click", () =>
    performTitleBarDoubleClickAction(),
  ),
  step("vibrancy", "set_window_vibrancy", () =>
    invokeTauri("set_window_vibrancy", { enabled: false, material: null }),
  ),
  step("relay-reconnect-hook", "relay_reconnect_hook", () =>
    invokeTauri("relay_reconnect_hook"),
  ),
  step("relay-reconnect-configured", "relay_reconnect_hook_configured", () =>
    invokeTauri("relay_reconnect_hook_configured"),
  ),
  step("discovery-credentials-status", "get_discovery_credential_status", () =>
    getDiscoveryCredentialStatus("outscraper"),
  ),
  step("discovery-credentials-save", "save_discovery_credential", () =>
    saveDiscoveryCredential("outscraper", "parity-oracle-fixture-key"),
  ),
  step(
    "discovery-credentials-delete-bogus",
    "delete_discovery_credential",
    () => deleteDiscoveryCredential("outscraper"),
  ),
  step("discovery-export-leads", "save_leads_csv", () =>
    invokeTauri("save_leads_csv", {
      csv: "pubkey,name\n0000000000000000000000000000000000000000000000000000000000000000,Parity Oracle",
      filename: "parity-oracle-leads.csv",
    }),
  ),
  step("qr-save", "save_png_data_url", () =>
    invokeTauri("save_png_data_url", {
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      filename: "parity-oracle-qr.png",
    }),
  ),

  // ── teardown (record phase only) ──────────────────────────────────────────
  // Close the script's own relay subscription BEFORE the cleanup writes, so
  // the cleanup events never reach the recorded push path. Skipped on
  // replay: the replayed REQ was already closed by the replayed CLOSE.
  step("relay-sub-close", "plugin:websocket|send", (ctx) =>
    invokeTauri("plugin:websocket|send", {
      id: ctx.relayWsId,
      message: {
        type: "Text",
        data: JSON.stringify(["CLOSE", ctx.relaySubId]),
      },
    }),
  ),

  // Fixture cleanup: delete the entities THIS record phase created so the
  // next run (and the replay that follows this one) starts from the same
  // relay state. Skipped on replay — replay's own fixtures are the "same
  // state" the next run's record and replay both observe.
  step(
    "cleanup-delete-channel",
    "delete_channel",
    (ctx) => deleteChannel(ctx.channelId),
    { replayable: false, reason: "deletes the record-phase fixture channel" },
  ),
  // The fixture save subscription is an app-local SQLite row (archive store),
  // keyed by the fixture channel's UUID; nothing else removes it. Without
  // this cleanup the record run's row survives into the replay phase, so the
  // replay's `list_save_subscriptions` always sees one extra row and the
  // canonicalized lists can never match.
  step(
    "cleanup-delete-save-sub",
    "delete_save_subscription",
    (ctx) => deleteSaveSubscription("channel_h", ctx.channelId),
    {
      replayable: false,
      reason:
        "deletes the record-phase fixture save subscription (app-local SQLite row); the replay's own subscription row is the state the next record phase observes",
    },
  ),
  step("cleanup-delete-team", "delete_team", (ctx) => deleteTeam(ctx.teamId), {
    replayable: false,
    reason: "deletes the record-phase fixture team",
  }),
  step(
    "cleanup-delete-persona",
    "delete_persona",
    (ctx) => deletePersona(ctx.personaId),
    { replayable: false, reason: "deletes the record-phase fixture persona" },
  ),
  step(
    "cleanup-delete-template",
    "delete_channel_template",
    (ctx) => deleteChannelTemplate(ctx.templateId),
    { replayable: false, reason: "deletes the record-phase fixture template" },
  ),
  step(
    "cleanup-delete-duplicate-template",
    "delete_channel_template",
    (ctx) => deleteChannelTemplate(ctx.duplicateTemplateId),
    {
      replayable: false,
      reason:
        "deletes the duplicate created by the record-phase duplicate step",
    },
  ),
];

/** 4x4 solid RGBA PNG (75 bytes) — decodes cleanly through the app's image
 * sanitizer, so upload_media_bytes exercises the success path and the
 * media-upload-progress event fires (the earlier 1x1 fixture failed the
 * image crate decode and only ever produced the error path). */
const TINY_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0,
  0, 0, 4, 8, 6, 0, 0, 0, 169, 241, 158, 126, 0, 0, 0, 18, 73, 68, 65, 84, 120,
  156, 99, 56, 161, 161, 241, 31, 25, 51, 144, 46, 0, 0, 108, 56, 33, 113, 75,
  94, 215, 28, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

/** Replay options for the harness, keyed by native command name. */
type ScriptTableEntry = {
  fixtureArgs?: string[];
  freshArgs?: string[];
  notReplayableReason?: string;
  result?: Record<string, string>;
  args?: Record<string, string>;
  jsonArgs?: Array<{ path: string; rewrite: Record<string, string> }>;
  offsetArgs?: Array<{ path: string; ctxKey: string; offset: number }>;
  skipIf?: (record: { command: string; args?: unknown }) => string | null;
  matchArgs?: (record: { command: string; args?: unknown }) => boolean;
};

function websocketWireVerb(record: {
  command: string;
  args?: unknown;
}): string | null {
  const data = (record.args as { message?: { data?: unknown } } | undefined)
    ?.message?.data;
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string"
      ? parsed[0]
      : null;
  } catch {
    return null;
  }
}

/**
 * Replay options for the harness, keyed by native command name. Commands
 * used by several session steps with different rewrites (the websocket
 * sends) hold an ARRAY of option sets, discriminated by the wire verb;
 * replay picks the first set whose matcher accepts the record.
 */
export function scriptTable(): Record<
  string,
  ScriptTableEntry | ScriptTableEntry[]
> {
  const table: Record<string, ScriptTableEntry | ScriptTableEntry[]> = {};
  const add = (command: string, entry: ScriptTableEntry) => {
    const existing = table[command];
    if (Array.isArray(existing)) {
      existing.push(entry);
    } else if (existing) {
      table[command] = [existing, entry];
    } else {
      table[command] = entry;
    }
  };
  for (const s of SESSION_STEPS) {
    if (s.replayable) {
      add(s.command, {
        fixtureArgs: s.fixtureArgs,
        jsonArgs: s.jsonArgs,
        ...REPLAY_CAPTURES[s.command],
      });
    } else {
      add(s.command, { notReplayableReason: s.notReplayableReason });
    }
  }
  // `plugin:websocket|send` carries three distinct step rewrites that a
  // command-keyed table would clobber (the last step won): the REQ's
  // channel retarget, the AUTH handshake (intercepted by the harness), and
  // the CLOSE. Discriminate by wire verb.
  const wsSends: ScriptTableEntry[] = [];
  const reqEntry = {
    matchArgs: (record: { command: string; args?: unknown }) =>
      websocketWireVerb(record) === "REQ",
    jsonArgs: [{ path: "message.data", rewrite: { "2.#h.0": "channelId" } }],
  };
  const authEntry = {
    matchArgs: (record: { command: string; args?: unknown }) =>
      websocketWireVerb(record) === "AUTH",
  };
  const closeEntry = {
    matchArgs: (record: { command: string; args?: unknown }) =>
      websocketWireVerb(record) === "CLOSE",
  };
  wsSends.push(reqEntry, authEntry, closeEntry);
  table["plugin:websocket|send"] = wsSends;
  return table;
}

/**
 * Correlation captures for replay, keyed by command name. `result` records a
 * context key from the ok-result; `args` rewrites an arg path from a context
 * key captured earlier. Commands that target an object created earlier in the
 * session (channel, message, workflow, team, template, persona, identity)
 * declare their dependencies here so replay follows the live object instead
 * of the stale recorded id. `"$"` is the whole value.
 */
export const REPLAY_CAPTURES: Record<
  string,
  {
    result?: Record<string, string>;
    args?: Record<string, string>;
    freshArgs?: string[];
    offsetArgs?: Array<{ path: string; ctxKey: string; offset: number }>;
    skipIf?: (record: { command: string; args?: unknown }) => string | null;
  }
> = {
  get_identity: { result: { identityPubkey: "pubkey" } },
  get_relay_ws_url: { result: { relayWsUrl: "$" } },
  get_relay_http_url: { result: { relayHttpUrl: "$" } },
  create_channel: { result: { channelId: "id" } },
  // Raw bridge result is snake_case: `event_id`, not `eventId`. The script's
  // own captures go through the camelCase API layer; the replay harness
  // reads the RAW result, so the capture path must match the wire shape.
  // The record-phase fixture channel is deleted by teardown before replay
  // runs, so replay must retarget the send to the LIVE channel or the relay
  // rejects it ("restricted: not a channel member") and the whole message
  // chain cascades.
  send_channel_message: {
    result: { messageId: "event_id", messageCreatedAt: "created_at" },
    args: { channelId: "channelId" },
  },
  create_workflow: {
    result: { workflowId: "id" },
    args: { channelId: "channelId" },
  },
  create_team: { result: { teamId: "id" } },
  create_channel_template: { result: { templateId: "id" } },
  create_persona: { result: { personaId: "id" } },

  get_user_profile: { args: { identityPubkey: "pubkey" } },
  get_users_batch: { args: { identityPubkey: "pubkeys.0" } },
  update_profile_at_relay: {
    args: { relayWsUrl: "relayUrl", identityPubkey: "expectedPubkey" },
  },
  get_channel_details: { args: { channelId: "channelId" } },
  get_channel_members: { args: { channelId: "channelId" } },
  join_channel: { args: { channelId: "channelId" } },
  leave_channel: { args: { channelId: "channelId" } },
  set_channel_topic: { args: { channelId: "channelId" } },
  set_channel_purpose: { args: { channelId: "channelId" } },
  update_channel: { args: { channelId: "input.channelId" } },
  get_channels_workflows: { args: { "channelIds.0": "channelId" } },
  archive_channel: { args: { channelId: "channelId" } },
  unarchive_channel: { args: { channelId: "channelId" } },
  add_channel_members: { args: { channelId: "channelId" } },
  remove_channel_member: { args: { channelId: "channelId" } },
  change_channel_member_role: { args: { channelId: "channelId" } },
  get_channel_messages_before: {
    args: { channelId: "channelId", beforeId: "messageId" },
    // The `before` cursor is rebuilt from the LIVE message's created_at so
    // the page boundary lands one second past the message on both sides
    // (the recorded cursor is a different run's wall clock).
    offsetArgs: [{ path: "before", ctxKey: "messageCreatedAt", offset: 1 }],
  },
  create_auth_event: {
    skipIf: (record) => {
      const challenge = (record.args as Record<string, unknown> | undefined)
        ?.challenge;
      return typeof challenge === "string" &&
        challenge !== "parity-oracle-challenge"
        ? "the AUTH challenge is per-connection; replay re-signs AUTH from the live challenge (AUTH send rewrite)"
        : null;
    },
  },
  get_event: { args: { messageId: "eventId" } },
  get_thread_replies: {
    args: { messageId: "rootEventId", channelId: "channelId" },
  },
  search_messages: {},
  add_reaction: { args: { messageId: "eventId" } },
  remove_reaction: { args: { messageId: "eventId" } },
  edit_message: {
    args: { channelId: "channelId", messageId: "eventId" },
  },
  delete_message: {
    args: { channelId: "channelId", messageId: "eventId" },
  },
  get_forum_posts: { args: { channelId: "channelId" } },
  get_forum_thread: {
    args: { channelId: "channelId", messageId: "eventId" },
  },
  get_canvas: { args: { channelId: "channelId" } },
  set_canvas: { args: { channelId: "channelId" } },
  get_channel_window: { args: { channelId: "channelId" } },
  create_save_subscription: { args: { channelId: "scopeValue" } },
  read_archived_events: { args: { channelId: "scopeValue" } },
  read_archived_observer_events_for_channel: {
    args: { channelId: "channelId" },
  },
  get_channel_workflows: { args: { channelId: "channelId" } },
  get_workflow: { args: { workflowId: "workflowId" } },
  update_workflow: { args: { workflowId: "workflowId" } },
  get_workflow_runs: { args: { workflowId: "workflowId" } },
  get_run_approvals: { args: { workflowId: "workflowId" } },
  trigger_workflow: { args: { workflowId: "workflowId" } },
  delete_workflow: { args: { workflowId: "workflowId" } },
  update_team: { args: { teamId: "input.id" } },
  encode_team_snapshot_for_send: { args: { teamId: "id" } },
  update_persona: { args: { personaId: "input.id" } },
  encode_agent_snapshot_for_send: { args: { personaId: "id" } },
  set_persona_active: { args: { personaId: "id" } },
  set_persona_shared: { args: { personaId: "id" } },
  reconcile_inbound_persona_event: { args: { relayWsUrl: "arrivalRelayUrl" } },
  update_channel_template: { args: { templateId: "input.id" } },
  duplicate_channel_template: { args: { templateId: "id" } },
  get_agent_models: { args: { identityPubkey: "pubkey" } },
  get_agent_memory: { args: { identityPubkey: "agentPubkey" } },
  put_agent_session_config: { args: { identityPubkey: "pubkey" } },
  get_agent_config_surface: { args: { identityPubkey: "pubkey" } },
  get_liked_notes: { args: { identityPubkey: "authorPubkey" } },
  get_contact_list: { args: { identityPubkey: "pubkey" } },
  get_user_notes: { args: { identityPubkey: "pubkey" } },
  get_notes_timeline: { args: { identityPubkey: "pubkeys.0" } },
  get_presence: { args: { identityPubkey: "pubkeys.0" } },
  ensure_chat_task: {
    args: {
      channelId: "channelId",
      messageId: "sendId",
      identityPubkey: "agentPubkey",
    },
  },
  execute_agent_proposal: { args: { relayWsUrl: "communityRelayUrl" } },
  send_managed_agent_channel_message: { args: { channelId: "channelId" } },
  has_managed_agent_channel_message_marker: {
    args: { channelId: "channelId" },
  },
  apply_workspace: { args: { relayWsUrl: "relayUrl" } },
};

/**
 * Poll for the relay's NIP-42 AUTH challenge captured by the connect step's
 * channel callback. The relay sends it immediately on connect; the bounded
 * wait absorbs scheduling skew without hanging the session.
 */
async function waitForAuthChallenge(
  ctx: SessionContext,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.authChallenge) {
      return ctx.authChallenge;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("parity: relay did not send an AUTH challenge");
}

/** The 18 event names the oracle must observe or declare unreachable. */
export const EVENT_NAMES = [
  "agents-data-changed",
  "deep-link-add-community",
  "deep-link-connect",
  "deep-link-join",
  "deep-link-message",
  "deep-link-nostr-bind",
  "huddle-active-speakers",
  "huddle-audio-disconnected",
  "huddle-state-changed",
  "legacy-nest-migrated",
  "media-upload-progress",
  "pairing-aborted",
  "pairing-complete",
  "pairing-error",
  "pairing-sas-received",
  "prevent-sleep-expired",
  "ptt-state",
  "repos-dir-error",
] as const;

/**
 * Events the script cannot produce, with the reason. Everything else must be
 * observed during the session or the trace coverage check fails.
 */
export const UNREACHABLE_EVENTS: Record<string, string> = {
  "deep-link-add-community":
    "OS-level deep link; requires opening a buzz:// URL externally",
  "deep-link-connect":
    "OS-level deep link; requires opening a buzz:// URL externally",
  "deep-link-join":
    "OS-level deep link; requires opening a buzz:// URL externally",
  "deep-link-message":
    "OS-level deep link; requires opening a buzz:// URL externally",
  "deep-link-nostr-bind":
    "OS-level deep link; requires opening a buzz:// URL externally",
  "huddle-active-speakers":
    "audio pipeline; requires a live huddle with speaking members",
  "huddle-audio-disconnected": "requires a huddle websocket drop mid-huddle",
  "legacy-nest-migrated":
    "boot-time migration; requires legacy nest data to exist",
  "pairing-aborted": "mobile peer aborts a pairing session",
  "pairing-error":
    "requires a live pairing session whose relay connection fails or a mobile peer; the session's pairing steps run against a healthy local relay and cancel cleanly",
  "pairing-complete": "mobile peer completes a pairing session",
  "pairing-sas-received": "mobile peer receives the SAS",
  "prevent-sleep-expired": "arms a 60-minute cap timer (prevent_sleep.rs:48)",
  "ptt-state": "global shortcut key event (Ctrl+Space)",
};
