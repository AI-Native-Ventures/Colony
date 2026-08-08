/**
 * Per-command canonicalizers for the parity oracle.
 *
 * Responses carry generated ids and timestamps (`channel_templates.rs:60` is
 * one example), so raw comparison is pure noise. A canonicalizer is declared
 * per command; a command with no canonicalizer compares raw — that is the
 * default and should be the common case.
 *
 * Two layers:
 * 1. A declared per-command canonicalizer (structural noise: media URLs,
 *    hashes, signed-event strings, Nostr event fields).
 * 2. A trace-wide normalization pass that replaces volatile *values*
 *    (UUIDs, timestamps, scripted fixture names) with ordered markers.
 *    Because the scripted session runs commands in a deterministic order,
 *    first-seen ordering aligns the same logical entity across two traces.
 */

import {
  BINARY_MARKER,
  isBinaryFingerprint,
  isNumericArray,
} from "@/parity/types";

export type Canonicalizer = (value: unknown) => unknown;

export const DEFAULT_CANONICALIZER: Canonicalizer = (value) => value;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Nostr pubkeys and event ids. Same marker family as UUIDs: generated per
// run, so two traces of the same session must compare as shapes, not literals.
const HEX64_RE = /^[0-9a-f]{64}$/i;
const HEX128_RE = /^[0-9a-f]{128}$/i;
// `live-<uuid>` subscription ids and similar prefixed ids embed a UUID; the
// embedded UUID is what gets the ordered marker, so a bare uuid and its
// prefixed occurrence normalize to the same marker.
const PREFIXED_UUID_RE =
  /^([a-z]+-)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const FIXTURE_RE = /^parity-oracle-/;
const FIXTURE_ANYWHERE_RE = /parity-oracle-[0-9a-f]{12}/g;
const UUID_ANYWHERE_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Normalizes volatile values in a trace to value-derived markers.
 *
 * Markers are a function of the value alone (FNV-1a of the value), never of
 * first-seen position: the recorded side and the live side can diverge in
 * their value sequence (an extra user, an extra event) without shifting every
 * later marker, which a position-based counter scheme turned into cascading
 * false diffs. The same value always maps to the same marker on both sides;
 * two genuinely different values always get different markers.
 */
export class TraceNormalizer {
  normalize(value: unknown): unknown {
    if (typeof value === "string") {
      return this.normalizeString(value);
    }
    if (typeof value === "number") {
      // Epoch seconds embedded in results (`created_at`, `since`, ...).
      if (value >= 1_500_000_000 && value <= 2_100_000_000) {
        return this.markerFor(String(value), "time");
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.normalize(item));
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        // Object keys carry volatile values too (`get_users_batch` returns a
        // map keyed by pubkey). Normalize keys that look volatile; everything
        // else passes through unchanged.
        const normalizedKey = this.normalizeString(key);
        out[normalizedKey] = this.normalize(item);
      }
      return out;
    }
    return value;
  }

  private normalizeString(value: string): string {
    if (FIXTURE_RE.test(value)) {
      return "$fixture";
    }
    if (HEX128_RE.test(value) || HEX64_RE.test(value)) {
      return this.markerFor(value, "hex");
    }
    if (UUID_RE.test(value)) {
      return this.markerFor(value, "uuid");
    }
    if (PREFIXED_UUID_RE.test(value)) {
      const embedded = value.slice(value.length - 36);
      return this.markerFor(embedded, "uuid");
    }
    if (ISO_TIMESTAMP_RE.test(value)) {
      return this.markerFor(value, "time");
    }
    // Fixture names embedded in longer strings (YAML, JSON, errors).
    let out = value;
    if (FIXTURE_ANYWHERE_RE.test(out)) {
      out = out.replace(FIXTURE_ANYWHERE_RE, "$fixture");
    }
    // UUIDs embedded in longer strings (errors, serialized events).
    if (UUID_ANYWHERE_RE.test(out)) {
      out = out.replace(UUID_ANYWHERE_RE, (match) =>
        this.markerFor(match, "uuid"),
      );
    }
    return out;
  }

  private markerFor(value: string, family: string): string {
    return `$${family}:${fnv1a8(value)}`;
  }
}

/**
 * FNV-1a 32-bit, rendered as 8 hex chars. Deterministic and synchronous
 * (crypto.subtle is async; the normalizer is a pure function of its input).
 */
function fnv1a8(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stripKeys(...keys: string[]): Canonicalizer {
  const keySet = new Set(keys);
  return (value) => {
    if (Array.isArray(value)) {
      return value.map((item) => stripKeys(...keys)(item));
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (!keySet.has(key)) {
          out[key] = stripKeys(...keys)(item);
        }
      }
      return out;
    }
    return value;
  };
}

function redact(reason: string): Canonicalizer {
  return () => ({ $redacted: reason });
}

/**
 * Profile-shaped results: `avatar_url` is serialized as `""` or `null` for
 * "no avatar" depending on which native layer produced it (the relay stores
 * `""` once a profile event exists, `null` before one does). The scripted
 * session's own profile write moves a read across that boundary between the
 * record and replay phases, so the two spellings compare as one value.
 * `display_name` and `has_profile_event` stay raw — they are the contract.
 */
export function canonicalizeProfileAvatar(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeProfileAvatar(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === "avatar_url" && (item === null || item === "")) {
        out[key] = null;
      } else {
        out[key] = canonicalizeProfileAvatar(item);
      }
    }
    return out;
  }
  return value;
}

/** A Nostr event object: strip every generated field, keep the contract. */
export function canonicalizeNostrEvent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeNostrEvent(item));
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (
      typeof obj.id === "string" &&
      typeof obj.pubkey === "string" &&
      typeof obj.kind === "number" &&
      "content" in obj &&
      "sig" in obj
    ) {
      const out: Record<string, unknown> = { kind: obj.kind };
      if (obj.pubkey !== undefined) out.pubkey = obj.pubkey;
      if (obj.content !== undefined) out.content = obj.content;
      if (obj.tags !== undefined) out.tags = obj.tags;
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      out[key] = canonicalizeNostrEvent(item);
    }
    return out;
  }
  return value;
}

/** A command result that is a serialized Nostr event JSON string. */
function eventString(): Canonicalizer {
  return (value) => {
    if (typeof value !== "string") {
      return value;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      const canonical = canonicalizeNostrEvent(parsed);
      return typeof canonical === "string"
        ? canonical
        : JSON.stringify(canonical);
    } catch {
      return value;
    }
  };
}

/**
 * Canonicalize a relay push payload: the app's websocket plugin delivers
 * wire messages wrapped as `{type, data}` (OutboundMessage), where `data` is
 * the JSON wire array. Used by the replay harness to compare pushes by
 * content, not by generated event ids, signatures, timestamps, challenges
 * or subscription labels.
 *
 * Wire arrays carry per-connection/per-run identifiers as element [1] — the
 * AUTH challenge, the subscription id on EVENT/EOSE/CLOSED, the event id on
 * OK. They are handshake labels, not contract, so they reduce to role
 * markers; the remaining elements (kind, pubkey, content, tags, booleans,
 * messages) compare as recorded.
 */
export function canonicalizePushPayload(value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.type === "Text" && typeof obj.data === "string") {
      try {
        const parsed = JSON.parse(obj.data) as unknown;
        return { ...obj, data: canonicalizePushPayload(parsed) };
      } catch {
        return value;
      }
    }
    if (obj.type === "Ping" || obj.type === "Close") {
      return value;
    }
  }
  if (Array.isArray(value)) {
    const canonical = value.map((item) => canonicalizePushPayload(item));
    const verb = typeof canonical[0] === "string" ? canonical[0] : "";
    if (verb === "AUTH") {
      return [verb, "$auth-challenge"];
    }
    if (verb === "EVENT") {
      return [verb, "$subId", canonicalizeDeletedEventTags(canonical[2])];
    }
    if (verb === "EOSE") {
      return [verb, "$subId"];
    }
    if (verb === "CLOSED") {
      return [verb, "$subId", ...canonical.slice(2)];
    }
    if (verb === "OK") {
      return [verb, "$eventId", ...canonical.slice(2)];
    }
    return canonical;
  }
  return canonicalizeNostrEvent(value);
}

/**
 * Deletion events (kind 5) reference the deleted event's id in their e-tag.
 * That id is minted per run (the deleted reaction/message is recreated fresh
 * on each side), so it carries no contract at the push layer — the delete
 * TARGET is verified by the correlated command args (`delete_message` and
 * `remove_reaction` receive the live ids). Both sides reduce to a role
 * marker, keeping every other tag and the event shape raw.
 */
function canonicalizeDeletedEventTags(event: unknown): unknown {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return event;
  }
  const obj = event as Record<string, unknown>;
  if (obj.kind !== 5 || !Array.isArray(obj.tags)) {
    return event;
  }
  return {
    ...obj,
    tags: obj.tags.map((tag) =>
      Array.isArray(tag) && tag[0] === "e" && typeof tag[1] === "string"
        ? [tag[0], "$deleted-event", ...tag.slice(2)]
        : tag,
    ),
  };
}

/**
 * Canonicalize binary payloads for comparison. The recorder fingerprints
 * binary RESULTS at record time (`{$binary: {length, sha256}}`); replay sees
 * the raw byte arrays. Both sides reduce to `{$binary: {length}}` — the
 * length is the contract (the payload bytes are never stored), and the hash
 * is dropped because the two sides legitimately hash the same file through
 * different byte representations (fingerprinted at record, raw at replay).
 */
export function canonicalizeBinary(value: unknown): unknown {
  if (isBinaryFingerprint(value)) {
    return { [BINARY_MARKER]: { length: value[BINARY_MARKER].length } };
  }
  if (Array.isArray(value)) {
    if (isNumericArray(value)) {
      return { [BINARY_MARKER]: { length: value.length } };
    }
    return value.map((item) => canonicalizeBinary(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = canonicalizeBinary(item);
    }
    return out;
  }
  return value;
}

/**
 * Snapshot payloads compare as shape, not byte length: the encoded bytes are
 * a function of the whole persona/agent store, which legitimately differs
 * between the record phase and the replay phase of the same session.
 */
export function canonicalizeSnapshotBytes(value: unknown): unknown {
  if (isBinaryFingerprint(value)) {
    return { [BINARY_MARKER]: { length: "$snapshot" } };
  }
  if (Array.isArray(value)) {
    if (isNumericArray(value)) {
      return { [BINARY_MARKER]: { length: "$snapshot" } };
    }
    return value.map((item) => canonicalizeSnapshotBytes(item));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = canonicalizeSnapshotBytes(item);
    }
    return out;
  }
  return value;
}

/**
 * Nostr event lists (channel windows, message pages): the relay orders
 * same-second events by their per-run generated event ids, so the same
 * event set legitimately arrives in a different order on each side. Compare
 * the SET of canonical events, not the sequence.
 */
function canonicalEventList(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return canonicalizeNostrEvent(value);
  }
  const canonical = value.map((item) => canonicalizeNostrEvent(item));
  canonical.sort((a, b) => {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });
  return canonical;
}

/**
 * A channel messages page: canonical events sorted by content, and the page
 * cursor dropped — it points into a per-run event stream, so its values are
 * volatile by construction.
 */
function canonicalEventsPage(): Canonicalizer {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    if (Array.isArray(out.events)) {
      out.events = canonicalEventList(out.events);
    }
    out.next_cursor = "$cursor";
    return out;
  };
}

/**
 * Forum thread root: the relay returns the root event with `event_id` (not
 * `id`) and string-serialized fields, so the generic Nostr canonicalizer
 * does not recognize it. Strip the generated fields; everything else
 * (pubkey, content, tags, thread counts) is contract.
 */
function canonicalizeForumThread(): Canonicalizer {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return canonicalizeNostrEvent(value);
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      if (key === "root" && typeof item === "object" && item !== null) {
        const root: Record<string, unknown> = {};
        for (const [rootKey, rootValue] of Object.entries(
          item as Record<string, unknown>,
        )) {
          if (
            rootKey === "event_id" ||
            rootKey === "created_at" ||
            rootKey === "sig"
          ) {
            continue;
          }
          root[rootKey] = canonicalizeNostrEvent(rootValue);
        }
        out[key] = root;
      } else {
        out[key] = canonicalizeNostrEvent(item);
      }
    }
    return out;
  };
}

/**
 * Save subscriptions: the list order is per-run (creation order), so compare
 * the SET of subscriptions. Each item's `created_at` is per-run; the
 * remaining fields (identity, relay, scope, kinds) are contract.
 */
function canonicalizeSaveSubscriptions(): Canonicalizer {
  return (value) => {
    if (!Array.isArray(value)) {
      return value;
    }
    const canonical = value.map((item) => {
      if (typeof item !== "object" || item === null) {
        return item;
      }
      const out: Record<string, unknown> = {
        ...(item as Record<string, unknown>),
      };
      delete out.created_at;
      return out;
    });
    canonical.sort((a, b) => {
      const ja = JSON.stringify(a);
      const jb = JSON.stringify(b);
      return ja < jb ? -1 : ja > jb ? 1 : 0;
    });
    return canonical;
  };
}

/**
 * Declared per-command canonicalizers. Keyed by command name; absent commands
 * compare raw (after the global value normalization pass).
 *
 * Only structural noise belongs here: fields that are generated but not
 * UUID/timestamp-shaped, or that legitimately differ between runs. The global
 * pass handles UUIDs, timestamps and fixture names.
 *
 * Redaction canonicalizers cover the recorder's result redactors: the
 * recorder redacts at record time, so the live side must redact the same
 * field at diff time or the two sides can never agree.
 */
export const CANONICALIZERS: Record<string, Canonicalizer> = {
  // Profile reads/writes: avatar_url null-vs-"" is serialization, not state
  // (see canonicalizeProfileAvatar); everything else compares raw.
  get_profile: canonicalizeProfileAvatar,
  update_profile: canonicalizeProfileAvatar,
  get_user_profile: canonicalizeProfileAvatar,
  get_users_batch: canonicalizeProfileAvatar,
  update_profile_at_relay: canonicalizeProfileAvatar,

  // Media descriptors carry generated URLs and content hashes.
  upload_media: stripKeys("url", "sha256", "blurhash", "dim", "uploaded"),
  upload_media_bytes: stripKeys("url", "sha256", "blurhash", "dim", "uploaded"),
  pick_and_upload_image: stripKeys(
    "url",
    "sha256",
    "blurhash",
    "dim",
    "uploaded",
  ),
  pick_and_upload_media: stripKeys(
    "url",
    "sha256",
    "blurhash",
    "dim",
    "uploaded",
  ),
  fetch_media_bytes: stripKeys("url", "sha256", "blurhash", "dim", "uploaded"),
  fetch_snapshot_bytes: stripKeys(
    "url",
    "sha256",
    "blurhash",
    "dim",
    "uploaded",
  ),
  download_file: stripKeys("url", "sha256", "blurhash", "dim", "uploaded"),
  download_image: stripKeys("url", "sha256", "blurhash", "dim", "uploaded"),
  fetch_workspace_icon: stripKeys(
    "url",
    "sha256",
    "blurhash",
    "dim",
    "uploaded",
  ),
  save_png_data_url: stripKeys("url", "sha256"),

  // Pairing QR carries a freshly minted pairing payload.
  start_pairing: redact("pairing QR"),

  // Record-time result redactors (see recorder.ts DEFAULT_REDACTORS) — the
  // live replay side must redact the same fields or the sides can never
  // agree.
  get_nsec: redact("nsec"),
  get_runtime_file_config: redact("runtime config may hold keys"),
  get_global_agent_config: redact("global agent config may hold keys"),
  get_discovery_credential_status: redact(
    "discovery credential status may echo secrets",
  ),
  nip44_encrypt_to_self: redact("nonce-bearing ciphertext"),

  // Signed events embed their own generated id, signature and timestamp.
  sign_event: eventString(),
  create_auth_event: eventString(),
  sign_nostr_identity_binding: eventString(),
  build_observer_control_event: eventString(),
  nip44_decrypt_from_self: eventString(),

  // Channel lifecycle: the fixture channel's UUID is correlated by the
  // replay harness (recorded id -> live id) and timestamps are per-run.
  create_channel: stripKeys("created_at", "updated_at"),
  get_channel_details: stripKeys("created_at", "updated_at"),
  update_channel: stripKeys("created_at", "updated_at"),

  // Channel templates generate ids server-side.
  create_channel_template: stripKeys("id", "created_at", "updated_at"),
  update_channel_template: stripKeys("id", "created_at", "updated_at"),
  duplicate_channel_template: stripKeys("id", "created_at", "updated_at"),

  // Workflows, teams and personas generate ids, channel scopes and
  // timestamps server-side; the replay legitimately creates fresh objects,
  // so those fields compare as shapes, never as literals.
  create_workflow: stripKeys("id", "channel_id", "created_at", "updated_at"),
  get_workflow: stripKeys("id", "channel_id", "created_at", "updated_at"),
  update_workflow: stripKeys("id", "channel_id", "created_at", "updated_at"),
  create_team: stripKeys("id", "created_at", "updated_at"),
  update_team: stripKeys("id", "created_at", "updated_at"),
  create_persona: stripKeys("id", "created_at", "updated_at"),
  update_persona: stripKeys("id", "created_at", "updated_at"),
  set_persona_shared: stripKeys("id", "created_at", "updated_at"),
  set_persona_active: stripKeys("id", "created_at", "updated_at"),

  // Triggered events and canvas writes carry freshly minted event ids.
  trigger_workflow: stripKeys("event_id"),
  set_canvas: stripKeys("event_id"),

  // Home-feed meta embeds the wall clock at read time.
  get_feed: stripKeys("generated_at"),

  // The contact list is a NIP-51 event the session rewrites on every run;
  // its id and timestamp are per-run, its content is the contract.
  get_contact_list: stripKeys("id", "created_at"),

  // Save subscriptions list order and item timestamps are per-run.
  list_save_subscriptions: canonicalizeSaveSubscriptions(),

  // Snapshot encodes: the recorder fingerprints results, replay sees raw
  // bytes, and the byte CONTENT is a function of volatile store state (the
  // record phase's own agents/personas exist during replay), so both sides
  // reduce to a shape marker. The record-side trace still preserves the
  // fingerprint (length + sha256) for the committed baseline; the diff
  // compares shape. (Audio frames — the binary-volume case — are NOT
  // canonicalized this way: their length is a contract.)
  encode_team_snapshot_for_send: canonicalizeSnapshotBytes,
  encode_agent_snapshot_for_send: canonicalizeSnapshotBytes,

  // Message results carry generated event ids and timestamps.
  send_channel_message: stripKeys(
    "event_id",
    "parent_event_id",
    "root_event_id",
    "created_at",
  ),
  publish_note: stripKeys("event_id"),
  set_contact_list: stripKeys("event_id"),

  // WebSocket connection ids are process-local integers that differ between
  // record and replay; the harness remaps them in args (wsIdMap) and the
  // result reduces to a constant.
  "plugin:websocket|connect": () => "$wsId",

  // Nostr-event-bearing results.
  get_event: eventString(),
  get_thread_replies: canonicalizeNostrEvent,
  search_messages: canonicalizeNostrEvent,
  get_channel_messages_before: canonicalEventsPage(),
  get_channel_window: canonicalEventList,
  get_forum_posts: canonicalizeNostrEvent,
  get_forum_thread: canonicalizeForumThread(),
  get_note: canonicalizeNostrEvent,
  get_notes_timeline: canonicalizeNostrEvent,
  get_global_notes: canonicalizeNostrEvent,
  get_liked_notes: canonicalizeNostrEvent,
  get_user_notes: canonicalizeNostrEvent,
  get_note_reactions: canonicalizeNostrEvent,
  get_relay_self: canonicalizeNostrEvent,
};
