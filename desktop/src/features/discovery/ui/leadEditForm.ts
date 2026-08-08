import type { LeadDetail, LeadUpdateInput } from "../types";

/**
 * How old a loaded `LeadDetail` may be before a submit re-fetches it.
 *
 * `update_lead` is a full-profile upsert: every omitted field binds NULL and
 * wipes the stored value. A drawer that loaded a lead long ago and writes
 * untouched fields from that load clobbers other members' edits, so submits
 * older than this re-fetch and seed untouched fields from the fresh read.
 */
export const LEAD_EDIT_STALE_MS = 120_000;

/** The edit form's working values, one string per field. */
export type LeadEditDraft = {
  website: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  contactName: string;
  contactTitle: string;
  owner: string;
  score: string;
  notes: string;
};

/** Seed the form from the loaded lead, so a submit is always a full profile. */
export function createLeadEditDraft(lead: LeadDetail): LeadEditDraft {
  return {
    website: lead.website ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    linkedinUrl: lead.linkedinUrl ?? "",
    contactName: lead.contactName ?? "",
    contactTitle: lead.contactTitle ?? "",
    owner: lead.owner ?? "",
    score: String(lead.score ?? ""),
    notes: lead.notes ?? "",
  };
}

/**
 * Re-seed fields the user left at their loaded values from a fresh read.
 *
 * Used by the stale-load guard: before submitting a full-profile write, a
 * re-fetched lead replaces every untouched field so the write does not
 * resurrect stale values. Fields the user changed keep their input.
 */
export function mergeFreshLeadValues(
  draft: LeadEditDraft,
  loaded: LeadDetail,
  fresh: LeadDetail,
): LeadEditDraft {
  const unchanged = (draftValue: string, loadedValue: string | undefined) =>
    draftValue === (loadedValue ?? "");
  return {
    website: unchanged(draft.website, loaded.website)
      ? (fresh.website ?? "")
      : draft.website,
    email: unchanged(draft.email, loaded.email)
      ? (fresh.email ?? "")
      : draft.email,
    phone: unchanged(draft.phone, loaded.phone)
      ? (fresh.phone ?? "")
      : draft.phone,
    linkedinUrl: unchanged(draft.linkedinUrl, loaded.linkedinUrl)
      ? (fresh.linkedinUrl ?? "")
      : draft.linkedinUrl,
    contactName: unchanged(draft.contactName, loaded.contactName)
      ? (fresh.contactName ?? "")
      : draft.contactName,
    contactTitle: unchanged(draft.contactTitle, loaded.contactTitle)
      ? (fresh.contactTitle ?? "")
      : draft.contactTitle,
    owner: unchanged(draft.owner, loaded.owner)
      ? (fresh.owner ?? "")
      : draft.owner,
    notes: unchanged(draft.notes, loaded.notes)
      ? (fresh.notes ?? "")
      : draft.notes,
    score: unchanged(draft.score, String(loaded.score ?? ""))
      ? String(fresh.score ?? "")
      : draft.score,
  };
}

export type LeadScoreParse =
  | { ok: true; score: number | undefined }
  | { ok: false };

/**
 * Parse the score input into the relay's integer type.
 *
 * Empty means "clear the score" (undefined on the wire, which NULLs it).
 * Non-numeric or non-integer input is rejected locally because it cannot be
 * represented in the request's JSON number type; the relay owns the 0-100
 * range check and reports it inline.
 */
export function parseLeadScore(raw: string): LeadScoreParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, score: undefined };
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return { ok: false };
  return { ok: true, score: value };
}

/**
 * Build the complete `update_lead` input from the form.
 *
 * The relay overwrites every column from the request and an omitted field
 * binds NULL, so this always sends the whole profile. An empty input means
 * "clear this field", which maps to `undefined` (NULL on the wire); the
 * relay rejects literal empty strings. `status` is deliberately omitted: it
 * falls back to the previous value server-side and belongs to ticket 4.
 */
export function buildLeadUpdateInput(draft: LeadEditDraft): LeadUpdateInput {
  const score = parseLeadScore(draft.score);
  if (!score.ok) {
    throw new Error("Fit score must be a whole number.");
  }
  return {
    website: draft.website === "" ? undefined : draft.website,
    email: draft.email === "" ? undefined : draft.email,
    phone: draft.phone === "" ? undefined : draft.phone,
    linkedinUrl: draft.linkedinUrl === "" ? undefined : draft.linkedinUrl,
    contactName: draft.contactName === "" ? undefined : draft.contactName,
    contactTitle: draft.contactTitle === "" ? undefined : draft.contactTitle,
    owner: draft.owner === "" ? undefined : draft.owner,
    score: score.score,
    notes: draft.notes === "" ? undefined : draft.notes,
  };
}

/** The editable fields the drawer form owns, in display order. */
export function editableLeadFields(
  lead: LeadDetail,
): Array<{ key: keyof LeadEditDraft; label: string }> {
  const fields: Array<{ key: keyof LeadEditDraft; label: string }> = [
    { key: "website", label: "Website" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "linkedinUrl", label: "LinkedIn URL" },
  ];
  const isPerson = lead.entityType === "person" || Boolean(lead.personName);
  if (isPerson) {
    fields.push({ key: "contactName", label: "Contact name" });
    fields.push({ key: "contactTitle", label: "Contact title" });
  }
  fields.push({ key: "owner", label: "Owner" });
  fields.push({ key: "score", label: "Fit score" });
  fields.push({ key: "notes", label: "Notes" });
  return fields;
}
