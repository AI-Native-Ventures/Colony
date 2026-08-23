/**
 * Reading the content calendar's four records off the relay.
 *
 * The authority for these shapes is `crates/buzz-core/src/content.rs`, which
 * the relay runs at ingest. Nothing here re-decides whether a record is legal:
 * an event that reached storage already passed that parser. What these
 * functions do is refuse to *display* a record they cannot read, so a
 * malformed or half-understood event renders as absent rather than as a card
 * with blank fields.
 *
 * The one rule this file does re-implement is the gate verdict, and
 * deliberately. `deriveVerdict` recomputes pass/fail/incomplete from the gate
 * statuses instead of trusting a `verdict` string, because a summary the UI
 * trusts is a summary that can lie to the person deciding whether to publish.
 */

import type { RelayEvent } from "@/shared/api/types";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** A gate that ran and cleared its bar, ran and did not, or did not run. */
export type GateStatus = "pass" | "fail" | "skip";

/** What a whole gate report adds up to. */
export type GateVerdict = "pass" | "fail" | "incomplete";

/** Gate ids a post must report, mirroring `REQUIRED_GATES` in `buzz-core`. */
export const REQUIRED_GATES = [
  "contrast",
  "grain",
  "fonts",
  "canvas",
  "housestyle",
  "claims",
] as const;

/** Largest number of slides one post may carry, mirroring `buzz-core`. */
export const MAX_SLIDES = 20;

/** Human labels for the gate ids, for the checks panel. */
export const GATE_LABELS: Record<string, string> = {
  canvas: "Canvas",
  claims: "Claims sourced",
  contrast: "Text contrast",
  fonts: "Font fallback",
  grain: "Grain",
  housestyle: "House style",
};

export type GateResult = {
  id: string;
  status: GateStatus;
  bar?: unknown;
  measured?: unknown;
  detail?: unknown;
};

export type GateReport = {
  imageHash: string;
  renderedAt: string | null;
  renderer: Record<string, unknown> | null;
  styleVersion: string | null;
  verdict: GateVerdict;
  gates: GateResult[];
};

export type ClaimKind = "verbatim" | "trim" | "derived";

export type ClaimSource =
  | { type: "page"; url: string; selector: string | null }
  | {
      type: "repo";
      repo: string | null;
      path: string;
      line: number | null;
      rev: string | null;
    }
  | { type: "owner"; event: string; saidAt: number | null };

export type ContentClaim = {
  id: string;
  asserts: string;
  kind: ClaimKind;
  source: ClaimSource | null;
  sourceHash: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
};

/**
 * How harshly the claim gate treats a claim it cannot confirm.
 *
 * This is the customer's setting, not ours: it lives on the brand kit
 * (kind 30198, `rules.claim_strictness`) and defaults to strict when the kit
 * says nothing, because strict is the product's promise.
 */
export type ClaimStrictness = "strict" | "advisory";

export type PostImage = {
  url: string;
  sha256: string;
  width: number;
  height: number;
};

export type PostAsset = {
  path: string;
  hash: string | null;
  kind: string | null;
  fictional: boolean;
};

export type PostStatus = "draft" | "ready";

export type ContentPost = {
  eventId: string;
  author: string;
  address: string;
  campaign: string;
  slug: string;
  week: number;
  scheduledFor: string;
  job: string | null;
  channel: string | null;
  headline: string | null;
  caption: string | null;
  alt: string | null;
  hashtags: string[];
  styleVersion: string | null;
  images: PostImage[];
  assets: PostAsset[];
  claims: ContentClaim[];
  claimFields: Record<string, string[]>;
  gateReports: GateReport[];
  status: PostStatus;
  updatedAt: number;
};

export type CampaignWeek = {
  index: number;
  label: string;
  startsOn: string;
};

export type ContentCampaign = {
  eventId: string;
  author: string;
  id: string;
  name: string;
  purpose: string | null;
  runningOrder: string | null;
  weeks: CampaignWeek[];
  status: "active" | "archived";
  updatedAt: number;
};

export type RuleOrigin = {
  at: number;
  quote: string;
  event: string | null;
};

export type StyleRule = {
  id: string;
  text: string;
  origin: RuleOrigin;
  active: boolean;
};

export type ContentStyle = {
  eventId: string;
  scope: string;
  version: string | null;
  rules: StyleRule[];
  settings: Record<string, unknown>;
  updatedAt: number;
};

export type CorrectionBin = "rule" | "setting" | "card";

export type ContentDecision = {
  eventId: string;
  author: string;
  coordinate: string;
  decision: "approve" | "change";
  imageSha256: string | null;
  verdict: GateVerdict;
  note: string | null;
  correction: { bin: CorrectionBin; text: string } | null;
  decidedAt: number;
};

/**
 * How a post stands with the owner, once its decisions are folded in.
 *
 * `changed-since-approval` is the state that needs the extra field on the
 * approval event to exist at all: the post's image no longer hashes to what
 * was signed off, so the approval is real but no longer covers these bytes.
 */
export type PostApprovalState =
  | "unreviewed"
  | "changes-requested"
  | "approved"
  | "changed-since-approval";

function tagValue(event: RelayEvent, name: string): string | null {
  const found = event.tags.find((tag) => tag[0] === name);
  return found?.[1] ?? null;
}

function readJson(event: RelayEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function list(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

/** Strip an optional `sha256:` prefix so two spellings compare equal. */
export function bareSha256(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

/**
 * The SHA-256 of the ordered slide hashes, so a decision names the whole set.
 *
 * Mirrors `slides_digest` in `buzz-core`: the input is the list of slide
 * images in slide order; the output is bare lowercase hex. Editing one slide
 * changes the digest, which is what makes an approval of a carousel invalid
 * after one slide is re-rendered.
 */
export function slidesDigest(images: PostImage[]): string {
  // Concatenate all slide hashes into one byte stream, then hash the stream.
  // This gives an ordered digest: changing one slide or reordering slides
  // changes the result, so an approval against this digest covers the exact
  // set of bytes and nothing else.
  const encoded = images.map((image) => image.sha256).join("");
  return bytesToHex(sha256(new TextEncoder().encode(encoded)));
}

/**
 * The verdict the gate statuses of one report add up to.
 *
 * Recomputed rather than read. A report that says "pass" over a skipped claims
 * gate is exactly the lie this feature exists to prevent, and the relay
 * already refuses to store one; recomputing means the UI does not depend on
 * that having worked.
 */
export function deriveVerdict(gates: GateResult[]): GateVerdict {
  if (gates.some((gate) => gate.status === "fail")) {
    return "fail";
  }
  if (gates.some((gate) => gate.status === "skip")) {
    return "incomplete";
  }
  return "pass";
}

/**
 * The verdict across all slide reports, or `null` when nothing ran.
 *
 * The worst verdict wins: one failing slide makes the whole post fail, one
 * incomplete slide makes the whole post incomplete. Only when every report
 * passes is the post fully passing.
 */
export function postVerdict(reports: GateReport[]): GateVerdict | null {
  if (reports.length === 0) {
    return null;
  }
  let worst: GateVerdict = "pass";
  for (const report of reports) {
    const verdict = deriveVerdict(report.gates);
    if (verdict === "fail") {
      return "fail";
    }
    if (verdict === "incomplete") {
      worst = "incomplete";
    }
  }
  return worst;
}

/** Gate ids a post should report but does not, across all its reports. */
export function missingGates(reports: GateReport[]): string[] {
  if (reports.length === 0) {
    return [...REQUIRED_GATES];
  }
  return REQUIRED_GATES.filter(
    (id) =>
      !reports.some((report) => report.gates.some((gate) => gate.id === id)),
  );
}

function parseGateReport(raw: Record<string, unknown>): GateReport | null {
  const imageHash = str(raw, "image_hash");
  if (!imageHash) {
    return null;
  }
  const gates: GateResult[] = [];
  for (const entry of list(raw, "gates")) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const gate = entry as Record<string, unknown>;
    const id = str(gate, "id");
    const status = str(gate, "status");
    if (!id || (status !== "pass" && status !== "fail" && status !== "skip")) {
      continue;
    }
    gates.push({
      bar: gate.bar,
      detail: gate.detail,
      id,
      measured: gate.measured,
      status,
    });
  }
  return {
    gates,
    imageHash: bareSha256(imageHash),
    renderedAt: str(raw, "rendered_at"),
    renderer: record(raw, "renderer"),
    styleVersion: str(raw, "style_version"),
    verdict: deriveVerdict(gates),
  };
}

function parseClaimSource(raw: Record<string, unknown>): ClaimSource | null {
  switch (str(raw, "type")) {
    case "page": {
      const url = str(raw, "url");
      return url ? { selector: str(raw, "selector"), type: "page", url } : null;
    }
    case "repo": {
      const path = str(raw, "path");
      return path
        ? {
            line: num(raw, "line"),
            path,
            repo: str(raw, "repo"),
            rev: str(raw, "rev"),
            type: "repo",
          }
        : null;
    }
    case "owner": {
      const event = str(raw, "event");
      return event
        ? { event, saidAt: num(raw, "said_at"), type: "owner" }
        : null;
    }
    default:
      return null;
  }
}

function parseClaim(raw: Record<string, unknown>): ContentClaim | null {
  const id = str(raw, "id");
  const asserts = str(raw, "asserts");
  const kind = str(raw, "kind");
  if (
    !id ||
    !asserts ||
    (kind !== "verbatim" && kind !== "trim" && kind !== "derived")
  ) {
    return null;
  }
  const rawSource = record(raw, "source");
  return {
    asserts,
    id,
    kind,
    source: rawSource ? parseClaimSource(rawSource) : null,
    sourceHash: str(raw, "source_hash"),
    verifiedAt: str(raw, "verified_at"),
    verifiedBy: str(raw, "verified_by"),
  };
}

/** Parse a campaign head (kind 30195). Returns null when unreadable. */
export function parseCampaign(event: RelayEvent): ContentCampaign | null {
  const id = tagValue(event, "d");
  const content = readJson(event);
  if (!id || !content) {
    return null;
  }
  const name = str(content, "name");
  if (!name) {
    return null;
  }
  const weeks: CampaignWeek[] = [];
  for (const entry of list(content, "weeks")) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const week = entry as Record<string, unknown>;
    const index = num(week, "index");
    const label = str(week, "label");
    const startsOn = str(week, "starts_on");
    if (index === null || !label || !startsOn) {
      continue;
    }
    weeks.push({ index, label, startsOn });
  }
  weeks.sort((a, b) => a.index - b.index);
  return {
    author: event.pubkey,
    eventId: event.id,
    id,
    name,
    purpose: str(content, "purpose"),
    runningOrder: str(content, "running_order"),
    status: str(content, "status") === "archived" ? "archived" : "active",
    updatedAt: event.created_at,
    weeks,
  };
}

/** Parse a post head (kind 30196). Returns null when unreadable. */
export function parsePost(event: RelayEvent): ContentPost | null {
  const address = tagValue(event, "d");
  const content = readJson(event);
  if (!address || !content) {
    return null;
  }
  const separator = address.indexOf(":");
  if (separator <= 0 || separator === address.length - 1) {
    return null;
  }
  const week = num(content, "week");
  const scheduledFor = str(content, "scheduled_for");
  if (week === null || !scheduledFor) {
    return null;
  }

  const rawImages = list(content, "images");
  const images: PostImage[] = [];
  for (const entry of rawImages) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const sha = str(raw, "sha256");
    const url = str(raw, "url");
    if (sha && url) {
      images.push({
        height: num(raw, "height") ?? 0,
        sha256: bareSha256(sha),
        url,
        width: num(raw, "width") ?? 0,
      });
    }
  }

  const claims: ContentClaim[] = [];
  for (const entry of list(content, "claims")) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const claim = parseClaim(entry as Record<string, unknown>);
    if (claim) {
      claims.push(claim);
    }
  }

  const claimFields: Record<string, string[]> = {};
  const rawFields = record(content, "claim_fields");
  if (rawFields) {
    for (const [field, value] of Object.entries(rawFields)) {
      if (Array.isArray(value)) {
        claimFields[field] = value.filter(
          (id): id is string => typeof id === "string",
        );
      }
    }
  }

  const assets: PostAsset[] = [];
  for (const entry of list(content, "assets")) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const asset = entry as Record<string, unknown>;
    const path = str(asset, "path");
    if (!path) {
      continue;
    }
    const hash = str(asset, "hash");
    assets.push({
      fictional: asset.fictional === true,
      hash: hash ? bareSha256(hash) : null,
      kind: str(asset, "kind"),
      path,
    });
  }

  const rawReports = list(content, "gate_reports");
  const gateReports: GateReport[] = [];
  for (const entry of rawReports) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const report = parseGateReport(entry as Record<string, unknown>);
    if (report) {
      gateReports.push(report);
    }
  }

  return {
    address,
    alt: str(content, "alt"),
    assets,
    author: event.pubkey,
    campaign: address.slice(0, separator),
    caption: str(content, "caption"),
    channel: str(content, "channel"),
    claimFields,
    claims,
    eventId: event.id,
    gateReports,
    hashtags: list(content, "hashtags")
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.replace(/^#/, ""))
      .filter((tag) => tag.length > 0),
    headline: str(content, "headline"),
    images,
    job: str(content, "job"),
    scheduledFor,
    slug: address.slice(separator + 1),
    status: str(content, "status") === "ready" ? "ready" : "draft",
    styleVersion: str(content, "style_version"),
    updatedAt: event.created_at,
    week,
  };
}

/** Parse a house-style head (kind 30197). Returns null when unreadable. */
export function parseStyle(event: RelayEvent): ContentStyle | null {
  const scope = tagValue(event, "d");
  const content = readJson(event);
  if (!scope || !content) {
    return null;
  }
  const rules: StyleRule[] = [];
  for (const entry of list(content, "rules")) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const rule = entry as Record<string, unknown>;
    const id = str(rule, "id");
    const text = str(rule, "text");
    const origin = record(rule, "origin");
    const at = origin ? num(origin, "at") : null;
    const quote = origin ? str(origin, "quote") : null;
    if (!origin || !id || !text || at === null || !quote) {
      continue;
    }
    rules.push({
      active: rule.active !== false,
      id,
      origin: { at, event: str(origin, "event"), quote },
      text,
    });
  }
  return {
    eventId: event.id,
    rules,
    scope,
    settings: record(content, "settings") ?? {},
    updatedAt: event.created_at,
    version: str(content, "version"),
  };
}

/**
 * Read one brand kit head (kind 30198) far enough to get the claim gate's
 * strictness. The kit's hues, type and marks are opaque here; this is the one
 * rule field a gate consumes. Returns null when the kit is unreadable or says
 * nothing, and the caller applies the default (strict).
 */
export function parseClaimStrictness(
  event: RelayEvent,
): ClaimStrictness | null {
  const content = readJson(event);
  if (!content) {
    return null;
  }
  const rules = record(content, "rules");
  const value = rules ? str(rules, "claim_strictness") : null;
  return value === "strict" || value === "advisory" ? value : null;
}

/** Parse an owner decision (kind 40025). Returns null when unreadable. */
export function parseDecision(event: RelayEvent): ContentDecision | null {
  const coordinate = tagValue(event, "a");
  const content = readJson(event);
  if (!coordinate || !content) {
    return null;
  }
  const decision = str(content, "decision");
  if (decision !== "approve" && decision !== "change") {
    return null;
  }
  const target = record(content, "target");
  const verdict = target ? str(target, "verdict") : null;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "incomplete") {
    return null;
  }
  const rawCorrection = record(content, "correction");
  const bin = rawCorrection ? str(rawCorrection, "bin") : null;
  const correctionText = rawCorrection ? str(rawCorrection, "text") : null;
  const imageSha = target ? str(target, "image_sha256") : null;

  return {
    author: event.pubkey,
    coordinate,
    correction:
      (bin === "rule" || bin === "setting" || bin === "card") && correctionText
        ? { bin, text: correctionText }
        : null,
    decidedAt: event.created_at,
    decision,
    eventId: event.id,
    imageSha256: imageSha ? bareSha256(imageSha) : null,
    note: str(content, "note"),
    verdict,
  };
}

/** The relay coordinate a decision points at, for one post. */
export function postCoordinate(post: ContentPost, postKind: number): string {
  return `${postKind}:${post.author}:${post.address}`;
}

/**
 * Fold a post's decisions into one state.
 *
 * Newest decision wins, and an approval only counts for the bytes it named.
 * With slides, the decision names a digest over every slide hash, so a card
 * re-rendered after sign-off reads as `changed-since-approval` rather than
 * inheriting the approval.
 */
export function approvalState(
  post: ContentPost,
  decisions: ContentDecision[],
): PostApprovalState {
  const newest = decisions
    .slice()
    .sort((a, b) => b.decidedAt - a.decidedAt)
    .at(0);
  if (!newest) {
    return "unreviewed";
  }
  if (newest.decision === "change") {
    return "changes-requested";
  }
  if (post.images.length > 0 && newest.imageSha256) {
    const digest = slidesDigest(post.images);
    if (newest.imageSha256 !== digest) {
      return "changed-since-approval";
    }
  }
  return "approved";
}
