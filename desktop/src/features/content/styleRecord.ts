/**
 * Writing the house style (kind 30197) from the desktop.
 *
 * Until now the style record had a schema, a parser and a ledger view, and
 * nothing anywhere wrote it: `rules[]` had zero writers and zero readers.
 * These builders are the write half. Every mutation merges into the head's
 * own JSON rather than rebuilding from the parsed record, for the same
 * reason `renderedPostEvent` does: the record carries settings keys this
 * build has never heard of, and rebuilding would drop them.
 *
 * Version discipline: every mutation that changes what future cards should
 * look like sets `version` to the mutation's own unix-seconds timestamp (as
 * a string). Reports stamp `style_version`, so a card rendered before a
 * change is detectable afterwards; without the bump, a correction is
 * invisible and the owner cannot tell whether it took effect.
 */

import { KIND_CONTENT_STYLE } from "@/shared/constants/kinds";

import type { SignedEventInput } from "./contentDecisions";

/** Pinned schema for the style record; mirrors `buzz-core`. */
export const SCHEMA_CONTENT_STYLE = "colony/content-style/v1";

/** Most references the board keeps; oldest fall off first. */
export const MAX_REFERENCES = 24;

/** Most picks the taste log keeps; oldest fall off first. */
export const MAX_PICKS = 60;

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The base body every mutation starts from: the existing head's own JSON,
 * or a fresh record when the workspace has never had one. */
export function styleBodyBase(existing: Body | null): Body {
  if (existing) {
    return { ...existing };
  }
  return { rules: [], schema: SCHEMA_CONTENT_STYLE, settings: {} };
}

function settingsOf(body: Body): Body {
  return isRecord(body.settings) ? { ...body.settings } : {};
}

export type RuleOriginInput = {
  /** Unix seconds when the owner said it. */
  at: number;
  /** The owner's sentence, verbatim. */
  quote: string;
  /** Event id of the decision it rode in on, when there was one. */
  event?: string | null;
};

/**
 * Append one house rule, in the owner's own words.
 *
 * The rule id is derived from the origin timestamp plus the current rule
 * count rather than randomness, so the same append is reproducible and
 * testable. Revoking later targets this id.
 */
export function appendStyleRule(
  existing: Body | null,
  text: string,
  origin: RuleOriginInput,
): Body {
  const body = styleBodyBase(existing);
  const rules = asList(body.rules);
  const rule: Body = {
    active: true,
    id: `r${origin.at}-${rules.length + 1}`,
    origin: {
      at: origin.at,
      quote: origin.quote,
      ...(origin.event ? { event: origin.event } : {}),
    },
    text,
  };
  return {
    ...body,
    rules: [...rules, rule],
    schema: SCHEMA_CONTENT_STYLE,
    version: String(origin.at),
  };
}

/**
 * Mark one rule inactive.
 *
 * The rule stays in the list: a rule that vanished without a trace is a rule
 * nobody can argue with later. Unknown ids leave the body unchanged apart
 * from the version bump, which is harmless and keeps the caller simple.
 */
export function revokeStyleRule(
  existing: Body | null,
  ruleId: string,
  at: number,
): Body {
  const body = styleBodyBase(existing);
  const rules = asList(body.rules).map((entry) => {
    if (!isRecord(entry) || entry.id !== ruleId) {
      return entry;
    }
    return { ...entry, active: false };
  });
  return {
    ...body,
    rules,
    schema: SCHEMA_CONTENT_STYLE,
    version: String(at),
  };
}

export type StyleReference = {
  /** Where the screenshot lives on the relay. */
  url: string;
  /** The stored bytes, so the agent can verify what it fetched. */
  sha256: string;
  /** Unix seconds when the owner saved it. */
  added_at: number;
};

/** Add one reference the owner likes. Oldest fall off past the cap. */
export function addStyleReference(
  existing: Body | null,
  reference: StyleReference,
): Body {
  const body = styleBodyBase(existing);
  const settings = settingsOf(body);
  const references = asList(settings.references)
    .filter(isRecord)
    .filter((entry) => entry.sha256 !== reference.sha256);
  const next = [...references, reference].slice(-MAX_REFERENCES);
  return {
    ...body,
    schema: SCHEMA_CONTENT_STYLE,
    settings: { ...settings, references: next },
    version: String(reference.added_at),
  };
}

/** Remove one reference by its stored hash. */
export function removeStyleReference(
  existing: Body | null,
  sha256: string,
  at: number,
): Body {
  const body = styleBodyBase(existing);
  const settings = settingsOf(body);
  const references = asList(settings.references)
    .filter(isRecord)
    .filter((entry) => entry.sha256 !== sha256);
  return {
    ...body,
    schema: SCHEMA_CONTENT_STYLE,
    settings: { ...settings, references },
    version: String(at),
  };
}

export type StyleVoice = {
  tagline?: string;
  /** How posts should sound, in the owner's words. */
  sound?: string;
  banned_words?: string[];
};

/**
 * Set the voice block. Empty strings clear a field; `banned_words` replaces
 * wholesale because chips-style editing sends the full list every time.
 */
export function setStyleVoice(
  existing: Body | null,
  voice: StyleVoice,
  at: number,
): Body {
  const body = styleBodyBase(existing);
  const settings = settingsOf(body);
  const nextVoice: Body = {};
  if (voice.tagline?.trim()) {
    nextVoice.tagline = voice.tagline.trim();
  }
  if (voice.sound?.trim()) {
    nextVoice.sound = voice.sound.trim();
  }
  const banned = (voice.banned_words ?? [])
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  return {
    ...body,
    schema: SCHEMA_CONTENT_STYLE,
    settings: {
      ...settings,
      ...(banned.length > 0
        ? { banned_words: banned }
        : { banned_words: undefined }),
      voice: nextVoice,
    },
    version: String(at),
  };
}

export type StylePick = {
  /** The post the choice was made on. */
  post: string;
  /** What distinguished the chosen take. */
  chosen: { layout?: string; hues?: string[]; family?: string };
  at: number;
};

/** Record one variant pick. Picks are taste data the agent reads; the owner
 * never has to summarise them. Does not bump `version`: a pick biases
 * future drafts, it does not invalidate already-rendered cards. */
export function recordStylePick(existing: Body | null, pick: StylePick): Body {
  const body = styleBodyBase(existing);
  const settings = settingsOf(body);
  const picks = [...asList(settings.picks), pick].slice(-MAX_PICKS);
  return {
    ...body,
    schema: SCHEMA_CONTENT_STYLE,
    settings: { ...settings, picks },
  };
}

/** The unsigned replaceable head carrying a mutated style body. */
export function buildStyleEvent(scope: string, body: Body): SignedEventInput {
  // `undefined` values (used above to clear fields) must not survive into
  // the JSON as `null`s; JSON.stringify drops them from objects, which is
  // exactly the clearing behaviour the mutations rely on.
  return {
    content: JSON.stringify(body),
    kind: KIND_CONTENT_STYLE,
    tags: [["d", scope]],
  };
}
