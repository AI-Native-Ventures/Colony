//! Buzz V2 kind number registry.
//!
//! This module is the authoritative source for Buzz kind numbers.
//! All constants are `u32` — NIP-01 specifies kind as an unsigned integer,
//! and u32 covers the full range without truncation.

// Standard NIP kinds
/// NIP-01: User profile metadata.
pub const KIND_PROFILE: u32 = 0;
/// NIP-01: Short text note.
pub const KIND_TEXT_NOTE: u32 = 1;
/// NIP-02: Contact list / follow list.
pub const KIND_CONTACT_LIST: u32 = 3;
/// NIP-51: Mute list (replaceable, 10000–19999 range) — pubkeys/events/threads/words a user has muted.
///
/// User-owned global state, keyed by `(pubkey, kind)`. Same ownership/scope shape as kind:3.
pub const KIND_MUTE_LIST: u32 = 10000;
/// NIP-51: Pin list (replaceable) — events the user has pinned to their profile.
///
/// User-owned global state, keyed by `(pubkey, kind)`. The events referenced may live in
/// channels, but the pin list itself is profile-level state.
pub const KIND_PIN_LIST: u32 = 10001;
/// NIP-65: Relay list metadata (replaceable) — read/write relay preferences for the outbox model.
///
/// User-owned global state, keyed by `(pubkey, kind)`. Tags are `["r", url]` or
/// `["r", url, "read"]` / `["r", url, "write"]`.
pub const KIND_NIP65_RELAY_LIST_METADATA: u32 = 10002;
/// NIP-51: Bookmark list (replaceable) — events/articles/hashtags/URLs the user has bookmarked.
///
/// User-owned global state, keyed by `(pubkey, kind)`. References content but is not itself
/// channel-scoped content.
pub const KIND_BOOKMARK_LIST: u32 = 10003;
/// NIP-51: Emoji list (replaceable) — user preferred emojis and pointers to emoji sets.
pub const KIND_EMOJI_LIST: u32 = 10030;
/// NIP-51: Follow set (parameterized replaceable, 30000–39999 range) — named curated lists of pubkeys.
///
/// User-owned, keyed by `(pubkey, kind, d_tag)`. Allows multiple named follow lists on top of
/// the single kind:3 contact list (e.g. "close-friends", "news", "devs").
pub const KIND_FOLLOW_SET: u32 = 30000;
/// NIP-51: Bookmark set (parameterized replaceable) — named curated bookmark collections.
///
/// User-owned, keyed by `(pubkey, kind, d_tag)`.
pub const KIND_BOOKMARK_SET: u32 = 30003;
/// NIP-51 / NIP-30: Emoji set (parameterized replaceable).
///
/// User-owned, keyed by `(pubkey, kind, d_tag)`. Each member publishes their own
/// kind:30030 set (signed as themselves); the workspace emoji "palette" is the
/// client-side union of everyone's sets — a view computed on read, not stored
/// state. Ingest allowlists member-authored kind:30030/10030 (see
/// `required_scope_for_kind`), and the generic NIP-33 replace path keeps only the
/// latest per `(pubkey, d_tag)`.
pub const KIND_EMOJI_SET: u32 = 30030;
/// NIP-01: Channel metadata (replaceable). Not used by Buzz today.
pub const KIND_CHANNEL_METADATA: u32 = 41;
/// NIP-09: Event deletion request.
pub const KIND_DELETION: u32 = 5;
/// NIP-25: Content is emoji char or `+`/`-`.
pub const KIND_REACTION: u32 = 7;
/// NIP-17: Outer envelope for private DMs — hides sender, content, timestamp.
pub const KIND_GIFT_WRAP: u32 = 1059;
/// NIP-94: File metadata attachment.
pub const KIND_FILE_METADATA: u32 = 1063;
/// NIP-23: Long-form content (articles, blog posts, RFCs).
/// Parameterized replaceable (NIP-33, 30000–39999 range) — keyed by `(pubkey, kind, d_tag)`.
/// Stored globally (channel_id = NULL); author-owned, not channel-scoped.
pub const KIND_LONG_FORM: u32 = 30023;
/// NIP-38: User status (general, music, or custom d-tag).
/// Parameterized replaceable (NIP-33, 30000–39999 range) — keyed by `(pubkey, kind, d_tag)`.
/// Stored globally (channel_id = NULL); user-owned personal data, not channel-scoped.
pub const KIND_USER_STATUS: u32 = 30315;
/// NIP-78 / NIP-RS: Per-client read state blob for cross-device read position sync.
/// Parameterized replaceable (NIP-33, 30000–39999 range) — keyed by `(pubkey, kind, d_tag)`.
/// Stored globally (channel_id = NULL); user-owned personal data, not channel-scoped.
/// Content is NIP-44 encrypted to the user's own keypair.
pub const KIND_READ_STATE: u32 = 30078;
/// NIP-42 auth event — never stored (carries bearer tokens).
pub const KIND_AUTH: u32 = 22242;
/// BUD-01: Blossom upload auth (used in upload.rs, not stored).
pub const KIND_BLOSSOM_AUTH: u32 = 24242;
/// Buzz custom one-time identity binding proof (ephemeral, not stored).
pub const KIND_NOSTR_IDENTITY_BINDING: u32 = 24243;
/// NIP-98: HTTP auth event (used in nip98.rs, not stored).
pub const KIND_HTTP_AUTH: u32 = 27235;

// NEW: Buzz command kinds (Pure Nostr plan)
/// Agent metadata + owner reference (replaceable, agent-authored).
pub const KIND_AGENT_PROFILE: u32 = 10100;

/// NIP-AE: Agent Engram (parameterized replaceable, agent-authored).
///
/// Encrypted memory record for AI agents. Addressed by `(pubkey_a, kind, d_tag)`,
/// where `d_tag` is an HMAC over the agent↔owner conversation key. See
/// `docs/nips/NIP-AE.md` and [`crate::engram`].
pub const KIND_AGENT_ENGRAM: u32 = 30174;

/// NIP-ER: Event Reminder (parameterized replaceable, author-only).
///
/// Encrypted, author-only reminder addressed by `(pubkey, kind, d_tag)`. The
/// public `not_before` tag tells supporting relays when the reminder is due;
/// the target, note, and state are NIP-44 encrypted to the author. Reads are
/// author-only (see [`AUTHOR_ONLY_KINDS`]). See `docs/nips/NIP-ER.md`.
pub const KIND_EVENT_REMINDER: u32 = 30300;

/// NIP-PL: encrypted push lease (parameterized replaceable, author-only).
///
/// The source event contains endpoint-bearing NIP-44 ciphertext and is readable
/// only by its authenticated author. Effective delivery state lives in the
/// dedicated push lease tables.
pub const KIND_PUSH_LEASE: u32 = 30350;

/// Kinds whose stored events are readable only by their author.
///
/// The relay must never reveal the existence, count, tags, content, schedule,
/// or search matches of these events to anyone but the authenticated author.
/// Shared across the ingest write path (NIP-ER `not_before` validation) and the
/// read path (REQ/COUNT/subscription author-only filtering).
///
/// Currently a tiny linear set. If this grows past ~4 kinds, convert to a
/// compile-time bitset or sorted array with binary search for hot-path use.
pub const AUTHOR_ONLY_KINDS: &[u32] = &[
    KIND_EVENT_REMINDER,
    KIND_PUSH_LEASE,
    KIND_DISCOVERY_ACTION,
    KIND_DISCOVERY_WORKER_ACTION,
    KIND_DISCOVERY_WORKSPACE_ACTION,
];

/// Kinds that require a result-level read gate beyond the filter-layer
/// `#p` check: even a reader who knows an event id MUST match the event's
/// `#p` tag to receive the event. This closes the kindless `{ids:[…]}` read
/// path for events whose existence must not be leaked.
///
/// Used by `filter_can_match_result_gated_kinds` to force the per-event
/// fallback path in COUNT rather than the fast SQL `count_events()`.
pub const RESULT_GATED_KINDS: &[u32] = &[
    KIND_DM_VISIBILITY,
    KIND_AGENT_TURN_METRIC,
    KIND_USAGE_RECORD,
    KIND_DISCOVERY_RECEIPT,
    KIND_DISCOVERY_WORKER_RECEIPT,
    KIND_DISCOVERY_WORKSPACE_RECEIPT,
];

/// Kinds whose stored events have `#p`-bound read access — readable only by
/// subscribers whose pubkey appears in the event's `#p` tag.
///
/// The relay enforces this at the filter layer (`p_gated_filters_authorized`):
/// a REQ that can match any kind in this set is closed unless the filter's
/// `#p` values exactly equal the authenticated reader's pubkey. For stored
/// (non-ephemeral) kinds in this set, the storage layer additionally writes a
/// NULL `search_tsv` so the event is unsearchable through NIP-50 FTS
/// (`schema/schema.sql` and `migrations/0001_initial_schema.sql` — drift
/// caught by `p_gated_persistent_kinds_have_storage_null_tsvector` in
/// `crates/buzz-search/tests/fts_integration.rs`).
///
/// Ephemeral kinds (20000–29999, e.g. [`KIND_AGENT_OBSERVER_FRAME`]) are
/// included for filter-layer enforcement but are never stored, so the
/// storage-layer search defense does not apply to them.
pub const P_GATED_KINDS: &[u32] = &[
    KIND_AGENT_OBSERVER_FRAME,
    KIND_MEMBER_ADDED_NOTIFICATION,
    KIND_MEMBER_REMOVED_NOTIFICATION,
    KIND_GIFT_WRAP,
    KIND_DM_VISIBILITY,
    KIND_DISCOVERY_RECEIPT,
    KIND_DISCOVERY_WORKER_RECEIPT,
    KIND_DISCOVERY_WORKSPACE_RECEIPT,
    // NIP-AM: agent turn metrics are encrypted to the owner and must not be
    // readable by any unauthenticated or non-owner party, including via `ids`
    // filters — see NIP-AM §Relay Behavior.
    KIND_AGENT_TURN_METRIC,
    // NIP-CL: usage records are encrypted to the owner and together disclose
    // the company's entire spend history — same read gates as turn metrics.
    KIND_USAGE_RECORD,
];

/// NIP-AP: Agent Persona (parameterized replaceable, owner-authored).
///
/// Persona definition event published by the workspace owner. Addressed by
/// `(pubkey, kind, d_tag)` where `d_tag` is the plaintext persona slug.
/// Content is a JSON body containing persona fields (system_prompt,
/// display_name, avatar_url, runtime, model, provider, name_pool).
///
/// # Access control: author-only-unless-shared
///
/// Kind 30175 uses **shared-tag-gated** read semantics to protect system
/// prompts and `respond_to_allowlist` pubkeys from being visible to all
/// community members as a side-effect of device sync:
///
/// - Events WITHOUT a `["shared", "true"]` tag are readable only by their
///   author. Foreign REQ/COUNT/fan-out/ids-lookup requests silently omit them.
/// - Events WITH exactly `["shared", "true"]` are readable community-wide,
///   enabling the opt-in agent catalog (`{kinds:[30175]}` all-authors).
///
/// Device sync already queries `authors:[self]`, so this gate never affects
/// self-reads. The `shared` tag is a tag (not a content field) so toggling
/// sharing does not change content bytes or the drift/`source_version` hash
/// (`persona_content_hash`) used by persona sync.
///
/// Ingest rejects malformed `shared` tags (any value other than `"true"`,
/// or more than one `shared` tag) so no ambiguous heads can exist.
pub const KIND_PERSONA: u32 = 30175;

/// Chat-native Block catalog head (parameterized replaceable, relay-authored).
pub const KIND_BLOCK_CATALOG_ENTRY: u32 = 30178;

/// Colony company profile (parameterized replaceable, relay-authored canonical head).
pub const KIND_COMPANY_PROFILE: u32 = 30179;

/// Colony cross-team initiative (parameterized replaceable, relay-authored canonical head).
pub const KIND_INITIATIVE: u32 = 30180;

/// Colony single-team task (parameterized replaceable, relay-authored canonical head).
pub const KIND_TASK: u32 = 30181;

/// Canonical external Organization or Person, and the aliases retired handles
/// leave behind (parameterized replaceable, relay-authored canonical head).
///
/// One kind carries both because a retired handle has to keep resolving at the
/// coordinate it was handed out under. The `schema` field distinguishes a party
/// from a pointer to one.
pub const KIND_PARTY: u32 = 30182;

/// A company's Lead or Client view over one Party (parameterized replaceable,
/// relay-authored canonical head).
///
/// A view, never a copy: the same party may be both at once, so each
/// relationship is its own head rather than a field on the party.
pub const KIND_PARTY_RELATIONSHIP: u32 = 30183;

/// Colony cost ledger: append-only model price book (NIP-33 head, `d=pricebook`).
///
/// Relay-authored. Content is the full effective-dated price table in integer
/// nanoUSD per token. Prices are data, not code: a new model or a promotional
/// rate is an appended entry, never an app release.
pub const KIND_PRICE_BOOK: u32 = 30184;

/// Colony cost ledger: attribution rulebook (NIP-33 head, `d=rulebook`).
///
/// Relay-authored. Ordered rules mapping observed usage to a company, cost
/// centre, team, and commercial purpose when a record carries no explicit
/// work context.
pub const KIND_ATTRIBUTION_RULEBOOK: u32 = 30185;

/// Colony cost ledger: CFO correction log (NIP-33 head, `d=corrections`).
///
/// Relay-authored, append-only. A correction re-attributes one usage record;
/// it never modifies the record, so the original evidence survives.
pub const KIND_CORRECTION_BOOK: u32 = 30186;

/// Colony cost ledger: per-cost-centre budget (NIP-33 head,
/// `d={cost_centre_id}:{period}` where period is `YYYY-MM`).
pub const KIND_LEDGER_BUDGET: u32 = 30187;

/// Colony interrupt delegation grant (parameterized replaceable, owner-authored).
/// Authorizes one agent tier to delegate asks to a lower tier or a specific pubkey
/// (d-tag encodes the delegation scope; JSON content defines conditions).
pub const KIND_DELEGATION_GRANT: u32 = 30188;

/// A signed interaction with a chat-native Block instance.
pub const KIND_BLOCK_ACTION: u32 = 40010;

/// An auditable result for a chat-native Block action.
pub const KIND_BLOCK_RECEIPT: u32 = 40011;

/// An immutable chat-native Block manifest.
pub const KIND_BLOCK_MANIFEST: u32 = 40012;

/// Owner-signed request to create or mutate canonical Colony company state.
pub const KIND_COMPANY_ACTION: u32 = 40013;

/// Relay-signed auditable result of a Colony company action.
pub const KIND_COMPANY_RECEIPT: u32 = 40014;

/// Owner-signed request to create or mutate canonical Colony party state.
pub const KIND_PARTY_ACTION: u32 = 40015;

/// Relay-signed auditable result of a Colony party action.
pub const KIND_PARTY_RECEIPT: u32 = 40016;

/// Member-signed command to start, inspect, or cancel a Colony Discovery run.
pub const KIND_DISCOVERY_ACTION: u32 = 40017;

/// Relay-signed, requester-private safe projection of a Discovery command result.
pub const KIND_DISCOVERY_RECEIPT: u32 = 40018;

/// Member-signed command from a trusted local Discovery worker.
pub const KIND_DISCOVERY_WORKER_ACTION: u32 = 40019;

/// Relay-signed, worker-private result of a local-worker command.
pub const KIND_DISCOVERY_WORKER_RECEIPT: u32 = 40020;

/// Member-signed private command for Discovery campaigns and Leads.
pub const KIND_DISCOVERY_WORKSPACE_ACTION: u32 = 40021;

/// Relay-signed, requester-private Discovery campaign or Lead projection.
pub const KIND_DISCOVERY_WORKSPACE_RECEIPT: u32 = 40022;

/// Colony cost ledger: owner-signed ledger command.
///
/// Adds a price entry, attribution rule, correction, or budget. Brokered by
/// the relay, which validates it and authors the resulting book head.
pub const KIND_LEDGER_ACTION: u32 = 40023;

/// Colony cost ledger: relay-signed receipt for a ledger action.
pub const KIND_LEDGER_RECEIPT: u32 = 40024;

/// Returns `true` if `kind` uses the author-only-unless-shared read model
/// (currently only `KIND_PERSONA` / 30175).
///
/// Events of these kinds may only be delivered to foreign readers when the
/// event carries exactly `["shared", "true"]`. Used by all relay read
/// chokepoints: REQ historical delivery, live fan-out, COUNT fallback,
/// and the `ids`-lookup result gate.
pub fn is_persona_shared_kind(kind: u32) -> bool {
    kind == KIND_PERSONA
}

/// Returns `true` if the event is a persona-shared-catalog kind AND the
/// requester is NOT the author AND the event does NOT carry `["shared",
/// "true"]`. All three conditions must hold to withhold the event.
///
/// This is the per-event gate used by REQ historical delivery, live fan-out,
/// and COUNT fallback paths. It is intentionally independent of
/// `is_author_only_event` — persona events with `["shared", "true"]` MUST
/// reach foreign readers; stripping them at the author-only layer would break
/// the catalog query.
pub fn is_unshared_persona_event(event: &nostr::Event, requester_pubkey_bytes: &[u8]) -> bool {
    let kind = event.kind.as_u16() as u32;
    if !is_persona_shared_kind(kind) {
        return false;
    }
    // Author reads are always allowed.
    if event.pubkey.to_bytes() == requester_pubkey_bytes {
        return false;
    }
    // Foreign reader: allowed only if the event is explicitly shared.
    !persona_event_is_shared(event)
}

/// Returns `true` if the event carries exactly one `["shared", "true"]` tag.
///
/// Requires the tag to have exactly two elements so that a three-element shape
/// like `["shared","true","extra"]` is NOT treated as shared. Ingest enforces
/// the same exact shape, so a well-stored event either has no `shared` tag
/// (author-only) or exactly one with precisely two elements and value `"true"`
/// (community-readable). This helper fails closed on any non-exact shape
/// independently of ingest guarantees.
pub fn persona_event_is_shared(event: &nostr::Event) -> bool {
    let mut count = 0usize;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.len() == 2 && parts[0].as_str() == "shared" {
            if parts[1].as_str() != "true" {
                return false;
            }
            count += 1;
        } else if !parts.is_empty() && parts[0].as_str() == "shared" {
            // Non-exact shape (wrong length) — fail closed: not shared.
            return false;
        }
    }
    count == 1
}

/// NIP-AP: Agent Team (parameterized replaceable, owner-authored).
///
/// Team definition event published by the workspace owner. Addressed by
/// `(pubkey, kind, d_tag)` where `d_tag` is the team's stable id. Content is a
/// JSON body projecting public team fields (name, description, persona_ids).
/// A team is a user-facing grouping of personas; publishing keeps it
/// authoritative across clients and reboots, mirroring `KIND_PERSONA`.
pub const KIND_TEAM: u32 = 30176;

/// NIP-AP: Managed Agent (parameterized replaceable, owner-authored).
///
/// Managed-agent definition event published by the workspace owner. Addressed
/// by `(pubkey, kind, d_tag)` where `d_tag` is the agent's pubkey. Content is
/// an explicit opt-IN allowlist projection of the agent record — it MUST never
/// carry the agent's secret key, NIP-OA auth tag, env vars, or runtime fields,
/// since these events are world-readable on the relay.
pub const KIND_MANAGED_AGENT: u32 = 30177;

// NIP-56 reporting
/// NIP-56: Report an event, pubkey, or blob to relay moderators (kind:1984).
///
/// Accepted at ingest, persisted to the tenant-scoped `moderation_reports`
/// queue, and never fanned out publicly. Reports are signals, not triggers:
/// the relay never auto-actions on them (NIP-56).
pub const KIND_REPORT: u32 = 1984;

/// Buzz product feedback submission. Accepted at ingest, sidecarred to the
/// deployment feedback table, and never stored or fanned out as an event.
pub const KIND_PRODUCT_FEEDBACK: u32 = 42000;

// NIP-29 group admin events
/// NIP-29: Add a user to a group.
pub const KIND_NIP29_PUT_USER: u32 = 9000;
/// NIP-29: Remove a user from a group.
pub const KIND_NIP29_REMOVE_USER: u32 = 9001;
/// NIP-29: Edit group metadata.
pub const KIND_NIP29_EDIT_METADATA: u32 = 9002;
/// NIP-29: Delete an event from a group.
pub const KIND_NIP29_DELETE_EVENT: u32 = 9005;
/// NIP-29: Create a new group.
pub const KIND_NIP29_CREATE_GROUP: u32 = 9007;
/// NIP-29: Delete a group.
pub const KIND_NIP29_DELETE_GROUP: u32 = 9008;
/// NIP-29: Create an invite to a group.
pub const KIND_NIP29_CREATE_INVITE: u32 = 9009;
/// NIP-29: Request to join a group.
pub const KIND_NIP29_JOIN_REQUEST: u32 = 9021;
/// NIP-29: Request to leave a group.
pub const KIND_NIP29_LEAVE_REQUEST: u32 = 9022;

// Buzz community moderation commands (mod-signed, processed like 9030-series:
// validated + executed directly, never stored as regular events; every
// accepted command writes a `moderation_actions` audit row).
/// Moderation: ban a pubkey from the community (`p` tag target, optional
/// `expiration` + `reason` tags).
pub const KIND_MODERATION_BAN: u32 = 9040;
/// Moderation: lift a community ban (`p` tag target).
pub const KIND_MODERATION_UNBAN: u32 = 9041;
/// Moderation: timeout (write-block) a pubkey until an `expiration` tag
/// timestamp (`p` tag target, optional `reason`).
pub const KIND_MODERATION_TIMEOUT: u32 = 9042;
/// Moderation: clear a timeout early (`p` tag target).
pub const KIND_MODERATION_UNTIMEOUT: u32 = 9043;
/// Moderation: resolve a report (`report` tag = report event id hex,
/// `status` tag = resolved|dismissed, `action` tag =
/// delete|kick|ban|timeout|dismiss|escalate — see
/// `handlers/moderation_commands.rs` for the pinned vocabulary).
pub const KIND_MODERATION_RESOLVE_REPORT: u32 = 9044;

/// Returns `true` for community moderation command kinds (9040–9044).
///
/// The canonical route check — use this instead of scattering
/// `9040..=9044` matches across ingest/dispatch.
pub const fn is_moderation_command_kind(kind: u32) -> bool {
    matches!(
        kind,
        KIND_MODERATION_BAN
            | KIND_MODERATION_UNBAN
            | KIND_MODERATION_TIMEOUT
            | KIND_MODERATION_UNTIMEOUT
            | KIND_MODERATION_RESOLVE_REPORT
    )
}

// NIP-43 relay membership admin commands
/// NIP-43: Add a pubkey to the relay member list.
pub const RELAY_ADMIN_ADD_MEMBER: u32 = 9030;
/// NIP-43: Remove a pubkey from the relay member list.
pub const RELAY_ADMIN_REMOVE_MEMBER: u32 = 9031;
/// NIP-43: Change the role of an existing relay member.
pub const RELAY_ADMIN_CHANGE_ROLE: u32 = 9032;
/// Buzz: Set the workspace profile (icon). Admin/owner-signed command.
pub const RELAY_ADMIN_SET_WORKSPACE_PROFILE: u32 = 9033;
// NIP-43 relay membership announcement events (relay-signed)
/// NIP-43: Relay membership list snapshot (relay-signed, replaceable by convention).
pub const KIND_NIP43_MEMBERSHIP_LIST: u32 = 13534;
/// NIP-43: Member added announcement (relay-signed).
pub const KIND_NIP43_MEMBER_ADDED: u32 = 8000;
/// NIP-43: Member removed announcement (relay-signed).
pub const KIND_NIP43_MEMBER_REMOVED: u32 = 8001;
/// NIP-43: User leave request (user-signed, ephemeral).
pub const KIND_NIP43_LEAVE_REQUEST: u32 = 28936;

// NIP-IA identity archival requests (user/agent/owner-signed)
/// NIP-IA: Request that the relay archive a target identity.
pub const KIND_IA_ARCHIVE_REQUEST: u32 = 9035;
/// NIP-IA: Request that the relay unarchive a target identity.
pub const KIND_IA_UNARCHIVE_REQUEST: u32 = 9036;

// NIP-IA identity archival announcement events (relay-signed)
/// NIP-IA: Archived-identity delta (relay-signed).
pub const KIND_IA_ARCHIVED: u32 = 8002;
/// NIP-IA: Unarchived-identity delta (relay-signed).
pub const KIND_IA_UNARCHIVED: u32 = 8003;
/// NIP-IA: Archived identities list snapshot (relay-signed, replaceable).
pub const KIND_IA_ARCHIVED_LIST: u32 = 13535;

// NIP-29 group state (addressable range 39000–39003)
/// NIP-29: Addressable group metadata state.
pub const KIND_NIP29_GROUP_METADATA: u32 = 39000;
/// NIP-29: Addressable group admins list.
pub const KIND_NIP29_GROUP_ADMINS: u32 = 39001;
/// NIP-29: Addressable group members list.
pub const KIND_NIP29_GROUP_MEMBERS: u32 = 39002;
/// NIP-29: Addressable group roles definition.
pub const KIND_NIP29_GROUP_ROLES: u32 = 39003;

// Channel-window overlays (relay-signed, synthesized at query time, never
// stored). Appended to bridge `/query` responses for `top_level` window
// requests — see docs/bridge-channel-window.md.
/// Thread summary overlay: `e`/`d` tag = root event id, content =
/// `{reply_count, descendant_count, last_reply_at, participants}`.
pub const KIND_THREAD_SUMMARY: u32 = 39005;
/// Window bounds overlay: `d` tag = `<channel_id>:<request-cursor-or-head>`,
/// content = `{has_more, next_cursor}`. The only authority on exhaustion —
/// clients must not infer `has_more` from row counts.
pub const KIND_WINDOW_BOUNDS: u32 = 39006;

/// Workflow definition (parameterized replaceable, d=workflow_uuid).
pub const KIND_WORKFLOW_DEF: u32 = 30620;

/// NIP-DV: per-viewer DM visibility snapshot (relay-signed, parameterized
/// replaceable, d=viewer_pubkey). Carries one `h` tag per DM the viewer has
/// hidden from their sidebar. Re-published by the relay on every hide/unhide so
/// the latest event is always the authoritative hidden set. The relay knows
/// `hidden_at` per viewer; this is the only Nostr-visible projection of it.
pub const KIND_DM_VISIBILITY: u32 = 30622;

/// Lower bound of the NIP-33 parameterized replaceable range (30000–39999).
pub const PARAM_REPLACEABLE_KIND_MIN: u32 = 30000;
/// Upper bound of the NIP-33 parameterized replaceable range (30000–39999).
pub const PARAM_REPLACEABLE_KIND_MAX: u32 = 39999;

/// Lower bound of the ephemeral event range (20000–29999). Never stored.
pub const EPHEMERAL_KIND_MIN: u32 = 20000;
/// Upper bound of the ephemeral event range (20000–29999). Never stored.
pub const EPHEMERAL_KIND_MAX: u32 = 29999;

// Ephemeral events (20000–29999) — Redis pub/sub only, never stored.
/// Ephemeral: user presence update (online/away/offline).
pub const KIND_PRESENCE_UPDATE: u32 = 20001;
/// NIP-AB: Device pairing event. Ephemeral — relay may discard after delivery.
pub const KIND_PAIRING: u32 = 24134;
/// Ephemeral: typing indicator for a channel.
pub const KIND_TYPING_INDICATOR: u32 = 20002;
/// Ephemeral: owner-scoped encrypted agent observer telemetry and control frame.
pub const KIND_AGENT_OBSERVER_FRAME: u32 = 24200;
/// Ephemeral: huddle emoji reaction burst. Channel-scoped to the ephemeral
/// huddle channel with an `h` tag; never stored in the timeline.
pub const KIND_HUDDLE_REACTION: u32 = 24810;
// Stream messaging
/// NIP-29 group chat message kind. V1 used kind:10001 (replaceable range — wrong), then 40001.
///
/// Agent shutdown convention: the agent's owner sends a kind:9 message with content
/// `"!shutdown"` and a `#p` tag mentioning the agent. The harness exits gracefully.
/// This is a convention, not a new event kind — uses regular stream messages.
pub const KIND_STREAM_MESSAGE: u32 = 9;
/// V1 used kind:10002 (replaceable range — wrong).
pub const KIND_STREAM_MESSAGE_V2: u32 = 40002;
/// V1 used kind:10004 (replaceable range + NIP-51 collision — wrong).
pub const KIND_STREAM_MESSAGE_EDIT: u32 = 40003;
/// A stream message that has been pinned in a channel.
pub const KIND_STREAM_MESSAGE_PINNED: u32 = 40004;
/// A stream message that has been bookmarked by a user.
pub const KIND_STREAM_MESSAGE_BOOKMARKED: u32 = 40005;
/// A stream message scheduled for future delivery.
pub const KIND_STREAM_MESSAGE_SCHEDULED: u32 = 40006;
/// A reminder attached to a stream message or time.
pub const KIND_STREAM_REMINDER: u32 = 40007;
/// A diff/patch message showing file changes (unified diff format).
pub const KIND_STREAM_MESSAGE_DIFF: u32 = 40008;
/// Canvas (shared document) for a channel.
pub const KIND_CANVAS: u32 = 40100;
/// System message for channel state changes (join, leave, rename, etc.).
pub const KIND_SYSTEM_MESSAGE: u32 = 40099;

// Relay-only sidecar kinds (never client-submitted)
/// Channel metadata with computed fields (relay-signed sidecar).
pub const KIND_CHANNEL_SUMMARY: u32 = 40901;
/// Bulk presence state (relay-signed sidecar).
pub const KIND_PRESENCE_SNAPSHOT: u32 = 40902;

// Direct messages (41000–41999)
/// Open/create DM (p-tags = participants).
pub const KIND_DM_OPEN: u32 = 41010;
/// Add member to group DM.
pub const KIND_DM_ADD_MEMBER: u32 = 41011;
/// Hide DM from sidebar.
pub const KIND_DM_HIDE: u32 = 41012;
/// A new direct-message conversation was created.
pub const KIND_DM_CREATED: u32 = 41001;

// Agent job protocol (43000–43999)
// Not using NIP-90 kinds (5000–6999) — Buzz requires auth chains (depth ≤ 3, breadth ≤ 10).
/// An agent job was requested.
pub const KIND_JOB_REQUEST: u32 = 43001;
/// An agent accepted a job request.
pub const KIND_JOB_ACCEPTED: u32 = 43002;
/// Progress update for an in-flight agent job.
pub const KIND_JOB_PROGRESS: u32 = 43003;
/// Final result of a completed agent job.
pub const KIND_JOB_RESULT: u32 = 43004;
/// A job cancellation was requested.
pub const KIND_JOB_CANCEL: u32 = 43005;
/// An agent job failed with an error.
pub const KIND_JOB_ERROR: u32 = 43006;

/// Relay-signed notification: the target pubkey was added to a channel.
/// Stored globally (channel_id = None) with p-tag = target, h-tag = channel UUID.
pub const KIND_MEMBER_ADDED_NOTIFICATION: u32 = 44100;

/// Relay-signed notification: the target pubkey was removed from a channel.
/// Stored globally (channel_id = None) with p-tag = target, h-tag = channel UUID.
pub const KIND_MEMBER_REMOVED_NOTIFICATION: u32 = 44101;

/// NIP-AM: Agent Turn Metric — durable per-turn token-usage record (agent-authored).
///
/// Regular stored event (append-only, never replaced). The agent publishes one
/// event per completed turn, NIP-44 encrypted to its owner. Tags: exactly one `p`
/// (owner pubkey) and one `agent` (agent pubkey == event pubkey); no `h` tag.
/// Stored globally (channel_id = NULL); owner-scoped reads only (p-gated, NIP-42).
/// See `docs/nips/NIP-AM.md`.
pub const KIND_AGENT_TURN_METRIC: u32 = 44200;

/// Colony cost ledger: immutable usage record for one provider API call.
///
/// Captured at the wire by the metering checkpoint, or entered by the owner
/// for non-token costs. Content is NIP-44 ciphertext addressed to the owner.
/// The agent that spent the money does not author the counts: the checkpoint
/// reads them from the provider's own response.
pub const KIND_USAGE_RECORD: u32 = 44210;

// Colony interrupt protocol (44300–44303)
/// Colony interrupt Ask (stored, non-replaceable, agent-signed or relay-signed).
/// An escalation event requesting human judgment on a decision, question, credential,
/// blocker, or stall. Tags: `ask-type`, `ask-category`, `agent` (escalating agent pubkey),
/// optional `ask-default`, optional `ask-timeout`.
pub const KIND_ASK: u32 = 44300;

/// Colony interrupt Ask resolution (stored, non-replaceable, audience-signed or relay-signed).
/// An Answer to a pending Ask event (tag `e` references the Ask). Ends the Ask lifecycle
/// without further relay processing.
pub const KIND_ASK_RESOLUTION: u32 = 44301;

/// Colony interrupt Ask withdrawal (stored, non-replaceable, executive-signed).
/// An agent-initiated cancellation of a pending Ask event (tag `e` references the Ask).
pub const KIND_ASK_WITHDRAWAL: u32 = 44302;

/// Colony interrupt decision log (stored, non-replaceable, leader/executive-signed).
/// Record of a decision made autonomously under a delegation grant: the ask filed,
/// the decision made, and the undo path. Enables auditing and policy tuning.
pub const KIND_DECISION_LOG: u32 = 44303;

// Forum / social (45000–45999)
// V1 used addressable range (30001–30003) — wrong.
/// A forum post (thread root).
pub const KIND_FORUM_POST: u32 = 45001;
/// A vote on a forum post.
pub const KIND_FORUM_VOTE: u32 = 45002;
/// A comment reply on a forum post.
pub const KIND_FORUM_COMMENT: u32 = 45003;

// Workflow engine (46000–46999)
/// Trigger workflow execution.
pub const KIND_WORKFLOW_TRIGGER: u32 = 46020;
/// Grant pending approval.
pub const KIND_APPROVAL_GRANT: u32 = 46030;
/// Deny pending approval.
pub const KIND_APPROVAL_DENY: u32 = 46031;
/// A workflow was triggered by a matching event.
pub const KIND_WORKFLOW_TRIGGERED: u32 = 46001;
/// A workflow step began execution.
pub const KIND_WORKFLOW_STEP_STARTED: u32 = 46002;
/// A workflow step completed successfully.
pub const KIND_WORKFLOW_STEP_COMPLETED: u32 = 46003;
/// A workflow step failed.
pub const KIND_WORKFLOW_STEP_FAILED: u32 = 46004;
/// The entire workflow completed successfully.
pub const KIND_WORKFLOW_COMPLETED: u32 = 46005;
/// The entire workflow failed.
pub const KIND_WORKFLOW_FAILED: u32 = 46006;
/// The workflow was cancelled before completion.
pub const KIND_WORKFLOW_CANCELLED: u32 = 46007;
/// A workflow step is waiting for human approval.
pub const KIND_WORKFLOW_APPROVAL_REQUESTED: u32 = 46010;
/// A pending workflow approval was granted.
pub const KIND_WORKFLOW_APPROVAL_GRANTED: u32 = 46011;
/// A pending workflow approval was denied.
pub const KIND_WORKFLOW_APPROVAL_DENIED: u32 = 46012;

// User groups (47000–47999)

// System / admin custom range (48000–48999)
/// An audit log entry was recorded.
pub const KIND_AUDIT_ENTRY: u32 = 48001;
/// A huddle (audio/video session) was started.
pub const KIND_HUDDLE_STARTED: u32 = 48100;
/// A participant joined a huddle.
pub const KIND_HUDDLE_PARTICIPANT_JOINED: u32 = 48101;
/// A participant left a huddle.
pub const KIND_HUDDLE_PARTICIPANT_LEFT: u32 = 48102;
/// A huddle ended.
pub const KIND_HUDDLE_ENDED: u32 = 48103;
/// Huddle channel guidelines/rules document.
pub const KIND_HUDDLE_GUIDELINES: u32 = 48106;

// Media (49000–49999)
/// Internal kind for media upload audit entries. Not a relay event kind.
pub const KIND_MEDIA_UPLOAD: u32 = 49001;

/// NIP-34: Repository announcement (parameterized replaceable, d-tag = repo-id).
pub const KIND_GIT_REPO_ANNOUNCEMENT: u32 = 30617;
/// NIP-34: Repository state — current branch/tag refs (parameterized replaceable, d-tag = repo-id).
pub const KIND_GIT_REPO_STATE: u32 = 30618;
/// NIP-34: Patch (git format-patch output).
pub const KIND_GIT_PATCH: u32 = 1617;
/// NIP-34: Pull request.
pub const KIND_GIT_PULL_REQUEST: u32 = 1618;
/// NIP-34: Pull request update (tip commit change).
pub const KIND_GIT_PR_UPDATE: u32 = 1619;
/// NIP-34: Issue.
pub const KIND_GIT_ISSUE: u32 = 1621;
/// NIP-34: Status — Open.
pub const KIND_GIT_STATUS_OPEN: u32 = 1630;
/// NIP-34: Status — Applied / Merged.
pub const KIND_GIT_STATUS_MERGED: u32 = 1631;
/// NIP-34: Status — Closed.
pub const KIND_GIT_STATUS_CLOSED: u32 = 1632;
/// NIP-34: Status — Draft.
pub const KIND_GIT_STATUS_DRAFT: u32 = 1633;

/// All registered kind constants — used for duplicate detection and iteration.
pub const ALL_KINDS: &[u32] = &[
    KIND_PROFILE,
    KIND_TEXT_NOTE,
    KIND_CONTACT_LIST,
    KIND_MUTE_LIST,
    KIND_PIN_LIST,
    KIND_NIP65_RELAY_LIST_METADATA,
    KIND_BOOKMARK_LIST,
    KIND_EMOJI_LIST,
    KIND_FOLLOW_SET,
    KIND_BOOKMARK_SET,
    KIND_EMOJI_SET,
    KIND_CHANNEL_METADATA,
    KIND_DELETION,
    KIND_REACTION,
    KIND_GIFT_WRAP,
    KIND_FILE_METADATA,
    KIND_AGENT_PROFILE,
    KIND_AGENT_ENGRAM,
    KIND_EVENT_REMINDER,
    KIND_PERSONA,
    KIND_BLOCK_CATALOG_ENTRY,
    KIND_COMPANY_PROFILE,
    KIND_INITIATIVE,
    KIND_TASK,
    KIND_BLOCK_ACTION,
    KIND_BLOCK_RECEIPT,
    KIND_BLOCK_MANIFEST,
    KIND_COMPANY_ACTION,
    KIND_COMPANY_RECEIPT,
    KIND_PARTY,
    KIND_PARTY_RELATIONSHIP,
    KIND_PARTY_ACTION,
    KIND_PARTY_RECEIPT,
    KIND_DISCOVERY_ACTION,
    KIND_DISCOVERY_RECEIPT,
    KIND_DISCOVERY_WORKER_ACTION,
    KIND_DISCOVERY_WORKER_RECEIPT,
    KIND_DISCOVERY_WORKSPACE_ACTION,
    KIND_DISCOVERY_WORKSPACE_RECEIPT,
    KIND_PRICE_BOOK,
    KIND_ATTRIBUTION_RULEBOOK,
    KIND_CORRECTION_BOOK,
    KIND_LEDGER_BUDGET,
    KIND_DELEGATION_GRANT,
    KIND_LEDGER_ACTION,
    KIND_LEDGER_RECEIPT,
    KIND_TEAM,
    KIND_MANAGED_AGENT,
    KIND_REPORT,
    KIND_PRODUCT_FEEDBACK,
    KIND_NIP29_PUT_USER,
    KIND_NIP29_REMOVE_USER,
    KIND_NIP29_EDIT_METADATA,
    KIND_NIP29_DELETE_EVENT,
    KIND_NIP29_CREATE_GROUP,
    KIND_NIP29_DELETE_GROUP,
    KIND_NIP29_CREATE_INVITE,
    KIND_NIP29_JOIN_REQUEST,
    KIND_NIP29_LEAVE_REQUEST,
    KIND_MODERATION_BAN,
    KIND_MODERATION_UNBAN,
    KIND_MODERATION_TIMEOUT,
    KIND_MODERATION_UNTIMEOUT,
    KIND_MODERATION_RESOLVE_REPORT,
    RELAY_ADMIN_ADD_MEMBER,
    RELAY_ADMIN_REMOVE_MEMBER,
    RELAY_ADMIN_CHANGE_ROLE,
    RELAY_ADMIN_SET_WORKSPACE_PROFILE,
    KIND_NIP43_MEMBERSHIP_LIST,
    KIND_NIP43_MEMBER_ADDED,
    KIND_NIP43_MEMBER_REMOVED,
    KIND_NIP43_LEAVE_REQUEST,
    KIND_IA_ARCHIVE_REQUEST,
    KIND_IA_UNARCHIVE_REQUEST,
    KIND_IA_ARCHIVED,
    KIND_IA_UNARCHIVED,
    KIND_IA_ARCHIVED_LIST,
    KIND_NIP29_GROUP_METADATA,
    KIND_NIP29_GROUP_ADMINS,
    KIND_NIP29_GROUP_MEMBERS,
    KIND_NIP29_GROUP_ROLES,
    KIND_THREAD_SUMMARY,
    KIND_WINDOW_BOUNDS,
    KIND_PRESENCE_UPDATE,
    KIND_TYPING_INDICATOR,
    KIND_HUDDLE_REACTION,
    KIND_BLOSSOM_AUTH,
    KIND_PAIRING,
    KIND_AGENT_OBSERVER_FRAME,
    KIND_HTTP_AUTH,
    KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2,
    KIND_STREAM_MESSAGE_EDIT,
    KIND_STREAM_MESSAGE_PINNED,
    KIND_STREAM_MESSAGE_BOOKMARKED,
    KIND_STREAM_MESSAGE_SCHEDULED,
    KIND_STREAM_REMINDER,
    KIND_STREAM_MESSAGE_DIFF,
    KIND_CANVAS,
    KIND_SYSTEM_MESSAGE,
    KIND_CHANNEL_SUMMARY,
    KIND_PRESENCE_SNAPSHOT,
    KIND_DM_VISIBILITY,
    KIND_DM_OPEN,
    KIND_DM_ADD_MEMBER,
    KIND_DM_HIDE,
    KIND_DM_CREATED,
    KIND_JOB_REQUEST,
    KIND_JOB_ACCEPTED,
    KIND_JOB_PROGRESS,
    KIND_JOB_RESULT,
    KIND_JOB_CANCEL,
    KIND_JOB_ERROR,
    KIND_MEMBER_ADDED_NOTIFICATION,
    KIND_MEMBER_REMOVED_NOTIFICATION,
    KIND_AGENT_TURN_METRIC,
    KIND_USAGE_RECORD,
    KIND_ASK,
    KIND_ASK_RESOLUTION,
    KIND_ASK_WITHDRAWAL,
    KIND_DECISION_LOG,
    KIND_WORKFLOW_DEF,
    KIND_LONG_FORM,
    KIND_USER_STATUS,
    KIND_READ_STATE,
    KIND_FORUM_POST,
    KIND_FORUM_VOTE,
    KIND_FORUM_COMMENT,
    KIND_WORKFLOW_TRIGGER,
    KIND_APPROVAL_GRANT,
    KIND_APPROVAL_DENY,
    KIND_WORKFLOW_TRIGGERED,
    KIND_WORKFLOW_STEP_STARTED,
    KIND_WORKFLOW_STEP_COMPLETED,
    KIND_WORKFLOW_STEP_FAILED,
    KIND_WORKFLOW_COMPLETED,
    KIND_WORKFLOW_FAILED,
    KIND_WORKFLOW_CANCELLED,
    KIND_WORKFLOW_APPROVAL_REQUESTED,
    KIND_WORKFLOW_APPROVAL_GRANTED,
    KIND_WORKFLOW_APPROVAL_DENIED,
    KIND_AUDIT_ENTRY,
    KIND_HUDDLE_STARTED,
    KIND_HUDDLE_PARTICIPANT_JOINED,
    KIND_HUDDLE_PARTICIPANT_LEFT,
    KIND_HUDDLE_ENDED,
    KIND_HUDDLE_GUIDELINES,
    KIND_MEDIA_UPLOAD,
    KIND_GIT_REPO_ANNOUNCEMENT,
    KIND_GIT_REPO_STATE,
    KIND_GIT_PATCH,
    KIND_GIT_PULL_REQUEST,
    KIND_GIT_PR_UPDATE,
    KIND_GIT_ISSUE,
    KIND_GIT_STATUS_OPEN,
    KIND_GIT_STATUS_MERGED,
    KIND_GIT_STATUS_CLOSED,
    KIND_GIT_STATUS_DRAFT,
];

/// Returns `true` if `kind` is in the ephemeral range (20000–29999).
pub const fn is_ephemeral(kind: u32) -> bool {
    kind >= EPHEMERAL_KIND_MIN && kind <= EPHEMERAL_KIND_MAX
}

/// Returns `true` if `kind` is replaceable (NIP-01: kinds 0, 3, 41, 10000–19999).
/// NIP-33 parameterized-replaceable kinds (30000–39999) use a different replacement
/// key (includes `d`-tag) and are handled separately via `replace_parameterized_event`.
pub const fn is_replaceable(kind: u32) -> bool {
    matches!(kind, 0 | 3 | KIND_CHANNEL_METADATA | 10000..=19999)
}

/// Returns `true` if `kind` is in the NIP-33 parameterized replaceable range (30000–39999).
///
/// These events are keyed by `(pubkey, kind, d_tag)` — the latest `created_at` wins.
pub const fn is_parameterized_replaceable(kind: u32) -> bool {
    kind >= PARAM_REPLACEABLE_KIND_MIN && kind <= PARAM_REPLACEABLE_KIND_MAX
}

/// Returns `true` if `kind` is a workflow execution event (46001–46012).
/// These must not trigger workflows (prevents infinite loops).
pub const fn is_workflow_execution_kind(kind: u32) -> bool {
    kind >= KIND_WORKFLOW_TRIGGERED && kind <= KIND_WORKFLOW_APPROVAL_DENIED
}

/// Returns `true` if `kind` is a NIP-43 relay membership admin command (9030–9032)
/// or the Buzz workspace-profile admin command (9033).
pub const fn is_relay_admin_kind(kind: u32) -> bool {
    matches!(
        kind,
        RELAY_ADMIN_ADD_MEMBER
            | RELAY_ADMIN_REMOVE_MEMBER
            | RELAY_ADMIN_CHANGE_ROLE
            | RELAY_ADMIN_SET_WORKSPACE_PROFILE
    )
}

/// Returns `true` if `kind` is a NIP-IA identity archival request (9035–9036).
///
/// Only the user-signed *request* kinds are matched. The relay-signed delta and
/// snapshot kinds (8002/8003/13535) are emitted by the relay, never ingested as
/// commands, so they are intentionally excluded.
pub const fn is_identity_archive_request_kind(kind: u32) -> bool {
    matches!(kind, KIND_IA_ARCHIVE_REQUEST | KIND_IA_UNARCHIVE_REQUEST)
}

/// Returns `true` if `kind` is a Buzz command kind that requires transactional execution.
pub const fn is_command_kind(kind: u32) -> bool {
    matches!(
        kind,
        KIND_WORKFLOW_DEF
            | KIND_DM_OPEN
            | KIND_DM_ADD_MEMBER
            | KIND_DM_HIDE
            | KIND_WORKFLOW_TRIGGER
            | KIND_APPROVAL_GRANT
            | KIND_APPROVAL_DENY
            | KIND_COMPANY_ACTION
            | KIND_PARTY_ACTION
            | KIND_LEDGER_ACTION
            | KIND_DISCOVERY_ACTION
            | KIND_DISCOVERY_WORKER_ACTION
            | KIND_DISCOVERY_WORKSPACE_ACTION
    )
}

/// Returns `true` if `kind` may only be authored by the relay.
/// Client submission of these kinds must be rejected.
pub const fn is_relay_only_kind(kind: u32) -> bool {
    matches!(
        kind,
        KIND_NIP43_MEMBERSHIP_LIST
            | KIND_CHANNEL_SUMMARY
            | KIND_PRESENCE_SNAPSHOT
            | KIND_DM_VISIBILITY
            | KIND_THREAD_SUMMARY
            | KIND_WINDOW_BOUNDS
            | KIND_BLOCK_CATALOG_ENTRY
            | KIND_COMPANY_PROFILE
            | KIND_INITIATIVE
            | KIND_TASK
            | KIND_COMPANY_RECEIPT
            | KIND_PARTY
            | KIND_PARTY_RELATIONSHIP
            | KIND_PARTY_RECEIPT
            | KIND_LEDGER_RECEIPT
            | KIND_PRICE_BOOK
            | KIND_ATTRIBUTION_RULEBOOK
            | KIND_CORRECTION_BOOK
            | KIND_LEDGER_BUDGET
            | KIND_DISCOVERY_RECEIPT
            | KIND_DISCOVERY_WORKER_RECEIPT
            | KIND_DISCOVERY_WORKSPACE_RECEIPT
    )
}

/// Extract the kind from a nostr Event as u32.
/// NIP-01 specifies kind as an unsigned integer; u32 covers the full range.
pub fn event_kind_u32(event: &nostr::Event) -> u32 {
    event.kind.as_u16() as u32
}

/// Extract the kind from a nostr Event as i32 (for Postgres INT columns).
/// Safe: all Buzz kinds fit in i32 (max 65535 < i32::MAX).
pub fn event_kind_i32(event: &nostr::Event) -> i32 {
    event.kind.as_u16() as i32
}

// Compile-time: new kinds are in the expected ranges.
const _: () = assert!(is_replaceable(KIND_AGENT_PROFILE)); // 10100 ∈ 10000–19999
const _: () = assert!(is_parameterized_replaceable(KIND_PERSONA)); // 30175 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_BLOCK_CATALOG_ENTRY)); // 30178 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_COMPANY_PROFILE)); // 30179 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_INITIATIVE)); // 30180 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_TASK)); // 30181 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_PARTY)); // 30182 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_PARTY_RELATIONSHIP)); // 30183 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_TEAM)); // 30176 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_MANAGED_AGENT)); // 30177 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_WORKFLOW_DEF)); // 30620 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_EVENT_REMINDER)); // 30300 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_DM_VISIBILITY)); // 30622 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_THREAD_SUMMARY)); // 39005 ∈ 30000–39999
const _: () = assert!(is_parameterized_replaceable(KIND_WINDOW_BOUNDS)); // 39006 ∈ 30000–39999

// Compile-time: NIP-34 parameterized replaceable kinds are in the correct range.
const _: () = assert!(
    KIND_GIT_REPO_ANNOUNCEMENT >= PARAM_REPLACEABLE_KIND_MIN
        && KIND_GIT_REPO_ANNOUNCEMENT <= PARAM_REPLACEABLE_KIND_MAX
);
const _: () = assert!(
    KIND_GIT_REPO_STATE >= PARAM_REPLACEABLE_KIND_MIN
        && KIND_GIT_REPO_STATE <= PARAM_REPLACEABLE_KIND_MAX
);

// Compile-time: all Buzz kind constants fit in nostr's u16-backed Kind.
const _: () = assert!(KIND_AUTH <= u16::MAX as u32);
const _: () = assert!(KIND_CANVAS <= u16::MAX as u32);
const _: () = assert!(KIND_HUDDLE_GUIDELINES <= u16::MAX as u32);
const _: () = assert!(KIND_COMPANY_PROFILE <= u16::MAX as u32);
const _: () = assert!(KIND_INITIATIVE <= u16::MAX as u32);
const _: () = assert!(KIND_TASK <= u16::MAX as u32);
const _: () = assert!(KIND_COMPANY_ACTION <= u16::MAX as u32);
const _: () = assert!(KIND_COMPANY_RECEIPT <= u16::MAX as u32);
const _: () = assert!(KIND_DISCOVERY_ACTION <= u16::MAX as u32);
const _: () = assert!(KIND_DISCOVERY_RECEIPT <= u16::MAX as u32);
const _: () = assert!(KIND_DISCOVERY_WORKER_ACTION <= u16::MAX as u32);
const _: () = assert!(KIND_DISCOVERY_WORKER_RECEIPT <= u16::MAX as u32);
const _: () = assert!(!is_ephemeral(KIND_COMPANY_PROFILE));
const _: () = assert!(!is_ephemeral(KIND_INITIATIVE));
const _: () = assert!(!is_ephemeral(KIND_TASK));
const _: () = assert!(EPHEMERAL_KIND_MIN < EPHEMERAL_KIND_MAX);
// Compile-time: KIND_AGENT_TURN_METRIC is a regular stored kind (not ephemeral, not replaceable).
const _: () = assert!(!is_ephemeral(KIND_AGENT_TURN_METRIC));
const _: () = assert!(!is_replaceable(KIND_AGENT_TURN_METRIC));
const _: () = assert!(!is_parameterized_replaceable(KIND_AGENT_TURN_METRIC));
const _: () = assert!(KIND_AGENT_TURN_METRIC <= u16::MAX as u32);
// Compile-time: interrupt kinds are regular stored, non-replaceable.
const _: () = assert!(!is_ephemeral(KIND_ASK));
const _: () = assert!(!is_replaceable(KIND_ASK));
const _: () = assert!(KIND_ASK <= u16::MAX as u32);
const _: () = assert!(is_parameterized_replaceable(KIND_DELEGATION_GRANT)); // 30188 in 30000-39999
                                                                            // Moderation kinds fit u16 and are neither replaceable nor ephemeral:
                                                                            // 1984 is a regular event (persisted to the queue, never fanned out);
                                                                            // 9040–9044 are direct commands (executed, never stored).
const _: () = assert!(KIND_REPORT <= u16::MAX as u32);
const _: () = assert!(KIND_MODERATION_RESOLVE_REPORT <= u16::MAX as u32);
const _: () = assert!(!is_ephemeral(KIND_REPORT));
const _: () = assert!(is_moderation_command_kind(KIND_MODERATION_BAN));
const _: () = assert!(is_moderation_command_kind(KIND_MODERATION_RESOLVE_REPORT));
const _: () = assert!(!is_moderation_command_kind(KIND_REPORT));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn company_work_kinds_are_addressable_and_distinct() {
        let kinds = [KIND_COMPANY_PROFILE, KIND_INITIATIVE, KIND_TASK];
        assert_eq!(kinds, [30179, 30180, 30181]);
        for kind in kinds {
            assert!(is_parameterized_replaceable(kind));
            assert!(!is_ephemeral(kind));
            assert!(kind <= u16::MAX as u32);
            assert!(ALL_KINDS.contains(&kind));
        }

        let unique = kinds.into_iter().collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), 3);

        for existing in [
            KIND_PERSONA,
            KIND_TEAM,
            KIND_MANAGED_AGENT,
            KIND_BLOCK_CATALOG_ENTRY,
        ] {
            assert!(!unique.contains(&existing));
        }
    }

    /// The party kinds are addressable, distinct, and not colliding with any
    /// kind already in use.
    ///
    /// A number reused by accident is the one mistake here that cannot be
    /// migrated away from: every relay that stored an event under it keeps
    /// serving it under the old meaning.
    #[test]
    fn party_kinds_are_addressable_and_distinct() {
        let kinds = [KIND_PARTY, KIND_PARTY_RELATIONSHIP];
        assert_eq!(kinds, [30182, 30183]);
        for kind in kinds {
            assert!(is_parameterized_replaceable(kind));
            assert!(!is_ephemeral(kind));
            assert!(kind <= u16::MAX as u32);
            assert!(ALL_KINDS.contains(&kind));
        }

        for existing in [
            KIND_PERSONA,
            KIND_TEAM,
            KIND_MANAGED_AGENT,
            KIND_BLOCK_CATALOG_ENTRY,
            KIND_COMPANY_PROFILE,
            KIND_INITIATIVE,
            KIND_TASK,
        ] {
            assert!(
                !kinds.contains(&existing),
                "party kinds collide with {existing}"
            );
        }
    }

    #[test]
    fn party_authority_kinds_have_exact_classifications() {
        assert_eq!(KIND_PARTY_ACTION, 40015);
        assert_eq!(KIND_PARTY_RECEIPT, 40016);

        // Regular, not replaceable: an action and its receipt are evidence of
        // one request and must never be overwritten by a later one.
        for kind in [KIND_PARTY_ACTION, KIND_PARTY_RECEIPT] {
            assert!(!is_parameterized_replaceable(kind));
            assert!(!is_replaceable(kind));
            assert!(!is_ephemeral(kind));
            assert!(ALL_KINDS.contains(&kind));
        }

        let company = [KIND_COMPANY_ACTION, KIND_COMPANY_RECEIPT];
        for kind in [KIND_PARTY_ACTION, KIND_PARTY_RECEIPT] {
            assert!(!company.contains(&kind));
        }

        // Classification is what the relay routes on. Defining the integers
        // without it makes every party kind an unknown kind at ingest, which is
        // a refusal that reads exactly like a correct authorization failure.
        for head in [KIND_PARTY, KIND_PARTY_RELATIONSHIP] {
            assert!(is_relay_only_kind(head), "a client must not author {head}");
            assert!(!is_command_kind(head));
        }
        assert!(is_command_kind(KIND_PARTY_ACTION));
        assert!(!is_relay_only_kind(KIND_PARTY_ACTION));
        assert!(is_relay_only_kind(KIND_PARTY_RECEIPT));
        assert!(!is_command_kind(KIND_PARTY_RECEIPT));
    }

    #[test]
    fn ledger_kinds_have_exact_classifications() {
        assert_eq!(KIND_USAGE_RECORD, 44210);
        assert_eq!(KIND_LEDGER_ACTION, 40023);
        assert_eq!(KIND_LEDGER_RECEIPT, 40024);
        assert_eq!(KIND_PRICE_BOOK, 30184);
        assert_eq!(KIND_ATTRIBUTION_RULEBOOK, 30185);
        assert_eq!(KIND_CORRECTION_BOOK, 30186);
        assert_eq!(KIND_LEDGER_BUDGET, 30187);

        for kind in [
            KIND_USAGE_RECORD,
            KIND_LEDGER_ACTION,
            KIND_LEDGER_RECEIPT,
            KIND_PRICE_BOOK,
            KIND_ATTRIBUTION_RULEBOOK,
            KIND_CORRECTION_BOOK,
            KIND_LEDGER_BUDGET,
        ] {
            assert!(
                ALL_KINDS.contains(&kind),
                "kind {kind} missing from registry"
            );
        }

        // A usage record is evidence of one paid API call. Overwriting one
        // would erase money that was actually spent, so it is a regular
        // stored kind, never replaceable.
        assert!(!is_replaceable(KIND_USAGE_RECORD));
        assert!(!is_parameterized_replaceable(KIND_USAGE_RECORD));
        assert!(!is_ephemeral(KIND_USAGE_RECORD));

        // Action and receipt are evidence of one request, same as party.
        for kind in [KIND_LEDGER_ACTION, KIND_LEDGER_RECEIPT] {
            assert!(!is_parameterized_replaceable(kind));
            assert!(!is_replaceable(kind));
            assert!(!is_ephemeral(kind));
        }

        // The four books are NIP-33 heads: current state, addressed by d tag.
        for head in [
            KIND_PRICE_BOOK,
            KIND_ATTRIBUTION_RULEBOOK,
            KIND_CORRECTION_BOOK,
            KIND_LEDGER_BUDGET,
        ] {
            assert!(is_parameterized_replaceable(head));
        }

        // Classification is what the relay routes on. Defining the integers
        // without it makes every ledger kind an unknown kind at ingest, a
        // refusal that reads exactly like a correct authorization failure.
        assert!(is_command_kind(KIND_LEDGER_ACTION));
        assert!(!is_relay_only_kind(KIND_LEDGER_ACTION));
        assert!(!is_command_kind(KIND_LEDGER_RECEIPT));
        assert!(!is_command_kind(KIND_USAGE_RECORD));
        assert!(!is_relay_only_kind(KIND_USAGE_RECORD));
        for relay_authored in [
            KIND_LEDGER_RECEIPT,
            KIND_PRICE_BOOK,
            KIND_ATTRIBUTION_RULEBOOK,
            KIND_CORRECTION_BOOK,
            KIND_LEDGER_BUDGET,
        ] {
            assert!(
                is_relay_only_kind(relay_authored),
                "a client must not author {relay_authored}"
            );
            assert!(!is_command_kind(relay_authored));
        }

        // Usage records are NIP-44 ciphertext addressed to the owner. They
        // carry the company's entire spend history, so they get the same read
        // gates as turn metrics: `#p`-bound at the filter layer and closed to
        // the kindless `{ids:[…]}` path.
        assert!(P_GATED_KINDS.contains(&KIND_USAGE_RECORD));
        assert!(RESULT_GATED_KINDS.contains(&KIND_USAGE_RECORD));
        // The books are relay-authored plaintext state, readable community-wide
        // like the party heads, so they are deliberately not p-gated.
        for plaintext_head in [
            KIND_PRICE_BOOK,
            KIND_ATTRIBUTION_RULEBOOK,
            KIND_CORRECTION_BOOK,
            KIND_LEDGER_BUDGET,
        ] {
            assert!(!P_GATED_KINDS.contains(&plaintext_head));
        }
    }

    #[test]
    fn company_authority_kinds_have_exact_classifications() {
        assert_eq!(KIND_COMPANY_ACTION, 40013);
        assert_eq!(KIND_COMPANY_RECEIPT, 40014);

        for kind in [
            KIND_COMPANY_PROFILE,
            KIND_INITIATIVE,
            KIND_TASK,
            KIND_COMPANY_ACTION,
            KIND_COMPANY_RECEIPT,
        ] {
            assert!(ALL_KINDS.contains(&kind));
        }

        for head in [KIND_COMPANY_PROFILE, KIND_INITIATIVE, KIND_TASK] {
            assert!(is_relay_only_kind(head));
            assert!(!is_command_kind(head));
        }
        assert!(is_command_kind(KIND_COMPANY_ACTION));
        assert!(!is_relay_only_kind(KIND_COMPANY_ACTION));
        assert!(is_relay_only_kind(KIND_COMPANY_RECEIPT));
        assert!(!is_command_kind(KIND_COMPANY_RECEIPT));
        assert!(!is_parameterized_replaceable(KIND_COMPANY_ACTION));
        assert!(!is_parameterized_replaceable(KIND_COMPANY_RECEIPT));
    }

    #[test]
    fn discovery_kinds_have_exact_private_classifications() {
        assert_eq!(KIND_DISCOVERY_ACTION, 40017);
        assert_eq!(KIND_DISCOVERY_RECEIPT, 40018);
        assert_eq!(KIND_DISCOVERY_WORKER_ACTION, 40019);
        assert_eq!(KIND_DISCOVERY_WORKER_RECEIPT, 40020);
        assert_eq!(KIND_DISCOVERY_WORKSPACE_ACTION, 40021);
        assert_eq!(KIND_DISCOVERY_WORKSPACE_RECEIPT, 40022);
        assert!(ALL_KINDS.contains(&KIND_DISCOVERY_ACTION));
        assert!(ALL_KINDS.contains(&KIND_DISCOVERY_RECEIPT));
        assert!(ALL_KINDS.contains(&KIND_DISCOVERY_WORKER_ACTION));
        assert!(ALL_KINDS.contains(&KIND_DISCOVERY_WORKER_RECEIPT));
        assert!(ALL_KINDS.contains(&KIND_DISCOVERY_WORKSPACE_ACTION));
        assert!(ALL_KINDS.contains(&KIND_DISCOVERY_WORKSPACE_RECEIPT));
        assert!(AUTHOR_ONLY_KINDS.contains(&KIND_DISCOVERY_ACTION));
        assert!(AUTHOR_ONLY_KINDS.contains(&KIND_DISCOVERY_WORKER_ACTION));
        assert!(AUTHOR_ONLY_KINDS.contains(&KIND_DISCOVERY_WORKSPACE_ACTION));
        assert!(P_GATED_KINDS.contains(&KIND_DISCOVERY_RECEIPT));
        assert!(P_GATED_KINDS.contains(&KIND_DISCOVERY_WORKER_RECEIPT));
        assert!(P_GATED_KINDS.contains(&KIND_DISCOVERY_WORKSPACE_RECEIPT));
        assert!(RESULT_GATED_KINDS.contains(&KIND_DISCOVERY_RECEIPT));
        assert!(RESULT_GATED_KINDS.contains(&KIND_DISCOVERY_WORKER_RECEIPT));
        assert!(RESULT_GATED_KINDS.contains(&KIND_DISCOVERY_WORKSPACE_RECEIPT));
        assert!(is_command_kind(KIND_DISCOVERY_ACTION));
        assert!(is_command_kind(KIND_DISCOVERY_WORKER_ACTION));
        assert!(is_command_kind(KIND_DISCOVERY_WORKSPACE_ACTION));
        assert!(!is_relay_only_kind(KIND_DISCOVERY_ACTION));
        assert!(!is_relay_only_kind(KIND_DISCOVERY_WORKER_ACTION));
        assert!(!is_relay_only_kind(KIND_DISCOVERY_WORKSPACE_ACTION));
        assert!(is_relay_only_kind(KIND_DISCOVERY_RECEIPT));
        assert!(is_relay_only_kind(KIND_DISCOVERY_WORKER_RECEIPT));
        assert!(is_relay_only_kind(KIND_DISCOVERY_WORKSPACE_RECEIPT));
        assert!(!is_command_kind(KIND_DISCOVERY_RECEIPT));
        assert!(!is_command_kind(KIND_DISCOVERY_WORKER_RECEIPT));
        assert!(!is_command_kind(KIND_DISCOVERY_WORKSPACE_RECEIPT));
        assert!(!is_parameterized_replaceable(KIND_DISCOVERY_ACTION));
        assert!(!is_parameterized_replaceable(KIND_DISCOVERY_RECEIPT));
        assert!(!is_parameterized_replaceable(KIND_DISCOVERY_WORKER_ACTION));
        assert!(!is_parameterized_replaceable(KIND_DISCOVERY_WORKER_RECEIPT));
        assert!(!is_parameterized_replaceable(
            KIND_DISCOVERY_WORKSPACE_ACTION
        ));
        assert!(!is_parameterized_replaceable(
            KIND_DISCOVERY_WORKSPACE_RECEIPT
        ));
    }

    #[test]
    fn no_duplicate_kind_values() {
        let mut seen = std::collections::HashSet::new();
        for &k in ALL_KINDS {
            assert!(seen.insert(k), "duplicate kind value: {k}");
        }
    }

    #[test]
    fn block_kinds() {
        assert_eq!(KIND_BLOCK_ACTION, 40010);
        assert_eq!(KIND_BLOCK_RECEIPT, 40011);
        assert_eq!(KIND_BLOCK_MANIFEST, 40012);
        assert_eq!(KIND_BLOCK_CATALOG_ENTRY, 30178);

        for kind in [
            KIND_BLOCK_ACTION,
            KIND_BLOCK_RECEIPT,
            KIND_BLOCK_MANIFEST,
            KIND_BLOCK_CATALOG_ENTRY,
        ] {
            assert!(ALL_KINDS.contains(&kind));
        }

        assert!(is_parameterized_replaceable(KIND_BLOCK_CATALOG_ENTRY));
        assert!(!is_parameterized_replaceable(KIND_BLOCK_ACTION));
        assert!(!is_parameterized_replaceable(KIND_BLOCK_RECEIPT));
        assert!(!is_parameterized_replaceable(KIND_BLOCK_MANIFEST));
        assert!(!is_replaceable(KIND_BLOCK_ACTION));
        assert!(!is_replaceable(KIND_BLOCK_RECEIPT));
        assert!(!is_replaceable(KIND_BLOCK_MANIFEST));
    }

    #[test]
    fn nip43_membership_snapshot_is_relay_only() {
        assert!(is_relay_only_kind(KIND_NIP43_MEMBERSHIP_LIST));
        assert!(!is_relay_only_kind(KIND_NIP43_LEAVE_REQUEST));
    }

    #[test]
    fn parameterized_replaceable_range() {
        assert!(!is_parameterized_replaceable(29999));
        assert!(is_parameterized_replaceable(30000));
        assert!(is_parameterized_replaceable(30023)); // NIP-23 long-form
        assert!(is_parameterized_replaceable(39000)); // NIP-29 group metadata
        assert!(is_parameterized_replaceable(39999));
        assert!(!is_parameterized_replaceable(40000));
    }

    #[test]
    fn replaceable_and_parameterized_are_disjoint() {
        for kind in 0..=65535u32 {
            assert!(
                !(is_replaceable(kind) && is_parameterized_replaceable(kind)),
                "kind {kind} is both replaceable and parameterized replaceable"
            );
        }
    }

    // ── persona_event_is_shared / is_unshared_persona_event ──────────────

    fn make_persona_event(tags: &[&[&str]]) -> nostr::Event {
        use nostr::{EventBuilder, Keys, Kind, Tag};
        let keys = Keys::generate();
        let tag_vec: Vec<Tag> = tags
            .iter()
            .map(|parts| Tag::parse(parts.iter().copied()).unwrap())
            .collect();
        EventBuilder::new(Kind::Custom(KIND_PERSONA as u16), "")
            .tags(tag_vec)
            .sign_with_keys(&keys)
            .unwrap()
    }

    #[test]
    fn persona_event_is_shared_true_tag() {
        let ev = make_persona_event(&[&["d", "my-agent"], &["shared", "true"]]);
        assert!(persona_event_is_shared(&ev));
    }

    #[test]
    fn persona_event_is_shared_no_tag() {
        let ev = make_persona_event(&[&["d", "my-agent"]]);
        assert!(!persona_event_is_shared(&ev));
    }

    #[test]
    fn persona_event_is_shared_wrong_value() {
        let ev = make_persona_event(&[&["d", "my-agent"], &["shared", "false"]]);
        assert!(!persona_event_is_shared(&ev));
    }

    #[test]
    fn persona_event_is_shared_duplicate_shared_tags() {
        // Two ["shared","true"] tags → ambiguous; not considered shared.
        let ev =
            make_persona_event(&[&["d", "my-agent"], &["shared", "true"], &["shared", "true"]]);
        assert!(!persona_event_is_shared(&ev));
    }

    #[test]
    fn persona_event_is_shared_three_element_tag_not_shared() {
        // ["shared","true","extra"] — three elements — must NOT be treated as shared.
        // The helper fails closed on any non-exact shape independently of ingest guarantees.
        let ev = make_persona_event(&[&["d", "my-agent"], &["shared", "true", "extra"]]);
        assert!(!persona_event_is_shared(&ev));
    }

    #[test]
    fn persona_event_is_shared_one_element_tag_not_shared() {
        // ["shared"] — only one element — not shared (fails the == 2 check).
        let ev = make_persona_event(&[&["d", "my-agent"], &["shared"]]);
        assert!(!persona_event_is_shared(&ev));
    }

    #[test]
    fn is_unshared_persona_event_author_always_allowed() {
        // Even without a shared tag the event author should not be blocked.
        use nostr::{EventBuilder, Keys, Kind, Tag};
        let keys = Keys::generate();
        let ev = EventBuilder::new(Kind::Custom(KIND_PERSONA as u16), "")
            .tags(vec![Tag::parse(["d", "my-agent"]).unwrap()])
            .sign_with_keys(&keys)
            .unwrap();
        let author_bytes = keys.public_key().to_bytes();
        assert!(!is_unshared_persona_event(&ev, &author_bytes));
    }

    #[test]
    fn is_unshared_persona_event_foreign_no_tag() {
        let ev = make_persona_event(&[&["d", "my-agent"]]);
        let foreign = [0u8; 32];
        assert!(is_unshared_persona_event(&ev, &foreign));
    }

    #[test]
    fn is_unshared_persona_event_foreign_shared_tag() {
        let ev = make_persona_event(&[&["d", "my-agent"], &["shared", "true"]]);
        let foreign = [0u8; 32];
        assert!(!is_unshared_persona_event(&ev, &foreign));
    }

    #[test]
    fn is_unshared_persona_event_non_persona_kind_passthrough() {
        use nostr::{EventBuilder, Keys, Kind};
        let keys = Keys::generate();
        let ev = EventBuilder::new(Kind::Custom(KIND_TEAM as u16), "")
            .sign_with_keys(&keys)
            .unwrap();
        let foreign = [0u8; 32];
        // Non-persona kinds are never blocked by this gate.
        assert!(!is_unshared_persona_event(&ev, &foreign));
    }
}
