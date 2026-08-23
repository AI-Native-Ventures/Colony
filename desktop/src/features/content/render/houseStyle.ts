/**
 * The pre-render text gates: everything checkable before a pixel exists.
 *
 * These run first, and that ordering is commercial rather than cosmetic. A
 * card whose claim has no source, or whose headline breaks a house rule, must
 * never reach the renderer: catching it in the text costs nothing, catching it
 * after rendering means the customer has already paid for the bad one. Every
 * other AI social tool renders first.
 *
 * The claims half of the pre-render gate lives in `../claimVerifier`, shipped
 * by the claim-verifier ticket and exported for this pipeline to call. This
 * module owns the rest: canvas, banned words, and the em-dash rule.
 *
 * House rules come from the brand kit, not from here. Colony's kit is one row
 * in a table, not the only one, so a rule hardcoded in this file would be a
 * rule every customer inherits whether it suits their brand or not. The one
 * exception is the em-dash, which is a Colony-wide writing rule that predates
 * the kit and applies to everything the product emits.
 */

/** One gate's verdict, shaped the way a `GateResult` expects. */
export type GateEntry = {
  id: string;
  status: "pass" | "fail";
  bar: unknown;
  measured: unknown;
  detail: string;
};

/** The text of a card, as authored, before anything is drawn. */
export type CardText = {
  /** Words that will appear on the image. */
  headline: string;
  /** Anything else drawn on the card: labels, foot lines, callouts. */
  extra?: string[];
  /** The caption, which ships with the card but is not drawn on it. */
  caption?: string;
  /** Alt text. */
  alt?: string;
};

/** The kit fields these gates read. */
export type HouseRules = {
  /** Allowed canvases, e.g. `[{ name: "post", w: 1080, h: 1350 }]`. */
  canvases: { name: string; w: number; h: number }[];
  /** Words this brand does not use. Case-insensitive, whole word. */
  bannedWords?: string[];
};

/** Every string a card will publish, so a rule cannot be dodged by field. */
export function allText(text: CardText): string[] {
  return [
    text.headline,
    ...(text.extra ?? []),
    text.caption ?? "",
    text.alt ?? "",
  ].filter((s) => s.length > 0);
}

/**
 * The em-dash gate.
 *
 * A Colony-wide writing rule, not a kit setting: the character is banned
 * everywhere the product emits words. Checked across every field rather than
 * only the headline, because a caption ships with the card and is read by the
 * same person.
 */
export function emDashGate(text: CardText): GateEntry {
  const offenders: string[] = [];
  for (const s of allText(text)) {
    if (s.includes("—")) {
      offenders.push(s);
    }
  }
  return {
    bar: 0,
    detail:
      offenders.length === 0
        ? "No em-dashes."
        : `Em-dash in: ${offenders.map((s) => `"${s}"`).join(", ")}. Use a plain dash, a comma, a colon, or two sentences.`,
    id: "em-dash",
    measured: offenders.length,
    status: offenders.length === 0 ? "pass" : "fail",
  };
}

/**
 * The canvas gate.
 *
 * A card rendered at a size the kit does not list is a card that will be
 * cropped or letterboxed by whatever it is posted to, which is a defect the
 * renderer can see and the author cannot.
 */
export function canvasGate(
  width: number,
  height: number,
  rules: HouseRules,
): GateEntry {
  const match = rules.canvases.find((c) => c.w === width && c.h === height);
  const allowed = rules.canvases
    .map((c) => `${c.name} ${c.w}x${c.h}`)
    .join(", ");
  return {
    bar: allowed,
    detail: match
      ? `Canvas ${width}x${height} is the kit's "${match.name}".`
      : `Canvas ${width}x${height} is not in this kit. Allowed: ${allowed || "none configured"}.`,
    id: "canvas",
    measured: `${width}x${height}`,
    status: match ? "pass" : "fail",
  };
}

/**
 * Words to compare against, lowercased, with punctuation dropped.
 *
 * Hyphens and spaces both split, so a kit entry and the text it is checked
 * against are tokenised the same way. That is what lets a hyphenated entry
 * like "AI-powered" match the headline "An AI-powered workspace" while still
 * refusing to fire "leverage" on "leveraged".
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 0);
}

/** Whether `needle` appears in `words` as a contiguous run of whole tokens. */
function containsRun(words: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > words.length) {
    return false;
  }
  for (let i = 0; i + needle.length <= words.length; i++) {
    let all = true;
    for (let j = 0; j < needle.length; j++) {
      if (words[i + j] !== needle[j]) {
        all = false;
        break;
      }
    }
    if (all) {
      return true;
    }
  }
  return false;
}

/**
 * The banned-words gate.
 *
 * Whole-token and case-insensitive, so a rule written in lower case catches a
 * headline in title case, and "leverage" does not fire on "leveraged". A kit
 * entry spanning several tokens — "AI-powered", "artificial intelligence" —
 * matches as a contiguous run, so a brand can ban a phrase rather than only a
 * word.
 *
 * Entries are tokenised and compared, never compiled. Kit content is customer
 * data, and turning it into a regex would hand a brand file control over this
 * process: an entry of ".*" would either throw or match everything.
 */
export function bannedWordsGate(text: CardText, rules: HouseRules): GateEntry {
  const banned = rules.bannedWords ?? [];
  const hits: string[] = [];
  if (banned.length > 0) {
    const haystacks = allText(text).map(tokenize);
    for (const entry of banned) {
      const needle = tokenize(entry);
      if (needle.length === 0 || hits.includes(entry)) {
        continue;
      }
      if (haystacks.some((words) => containsRun(words, needle))) {
        hits.push(entry);
      }
    }
  }
  return {
    bar: banned.length,
    detail:
      hits.length === 0
        ? banned.length === 0
          ? "This kit lists no banned words."
          : "No banned words."
        : `This brand does not use: ${hits.join(", ")}.`,
    id: "banned-words",
    measured: hits,
    status: hits.length === 0 ? "pass" : "fail",
  };
}

/**
 * Run every pre-render text gate this module owns.
 *
 * The claims gate is not here: it needs network verification and lives in
 * `../claimVerifier`. The render pipeline runs both and concatenates the
 * entries, so a report carries one flat list whatever produced it.
 */
export function preRenderTextGates(
  text: CardText,
  width: number,
  height: number,
  rules: HouseRules,
): GateEntry[] {
  return [
    emDashGate(text),
    canvasGate(width, height, rules),
    bannedWordsGate(text, rules),
  ];
}

/**
 * Whether a set of gate entries permits rendering.
 *
 * Any failure stops the render. There is no partial pass: the point of a
 * pre-render gate is that the expensive step never happens.
 */
export function mayRender(entries: GateEntry[]): {
  ok: boolean;
  blocking: GateEntry[];
} {
  const blocking = entries.filter((e) => e.status === "fail");
  return { blocking, ok: blocking.length === 0 };
}
