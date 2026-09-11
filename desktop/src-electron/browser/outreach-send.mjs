// Owner-side send for an approved `@outreach-email` card, in the Electron
// shell. The Tauri lane answers the same `execute_outreach_send` invoke from
// desktop/src-tauri/src/commands/outreach_send.rs; this module is the other
// half of that contract, so the renderer's broker cannot tell the two shells
// apart. The refusal wordings below are copied from the Rust command on
// purpose: the owner reads the same sentence in either app.
//
// Nothing here imports Electron. The shell injects the tabs it owns and a
// function that runs the Gmail journey, so every rule is unit-testable.

/** The Gmail host the owner's Web tab must already be on. */
export const GMAIL_HOST = "mail.google.com";

const HEX_64 = 64;

/** Owner-readable refusal when the approval itself is not usable. */
export const MALFORMED =
  "This approval is malformed. Reopen the card and try again.";
/** Owner-readable refusal when no Web tab is open to send from. */
export const NO_SHARED_TAB =
  "Open your Gmail in the Web tab and try Approve again.";
/** Owner-readable refusal when the open Web tabs are on some other site. */
export const NOT_GMAIL =
  "The Web tab is not on Gmail. Open mail.google.com and try Approve again.";
/** Owner-readable refusal when a teammate currently controls the Gmail tab. */
export const WORKER_HELD =
  "A teammate is using your Gmail tab. Take it back and try Approve again.";
/** Owner-readable refusal when this approval already ran in this session. */
export const ALREADY_RAN =
  "This card was already sent from this desktop session.";

const failed = (reason) => ({ status: "failed", failure_reason: reason });

const isEventId = (value) =>
  typeof value === "string" &&
  value.length === HEX_64 &&
  /^[0-9a-fA-F]+$/.test(value);

const isFilled = (value) => typeof value === "string" && value.length > 0;

/**
 * The card fields the send actually needs, or `null` when the shape is wrong.
 *
 * Unknown fields are tolerated the way the Rust command tolerates them: the
 * card also carries lead ids, an expiry, and a status this module has no
 * business interpreting.
 */
export function readApproval(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const { instanceEventId, actionEventId, data } = args;
  if (!isEventId(instanceEventId) || !isEventId(actionEventId)) return null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const content = data.content;
  if (!content || typeof content !== "object" || Array.isArray(content))
    return null;
  if (
    !isFilled(data.destination) ||
    !isFilled(content.subject) ||
    !isFilled(content.body)
  )
    return null;
  return {
    to: data.destination,
    subject: content.subject,
    body: content.body,
    actionEventId,
  };
}

/**
 * The tab to send from, or the refusal explaining why there is not one.
 *
 * When the owner has Gmail open in more than one tab, the first in open order
 * wins: every tab of one business shares a session partition, so they all
 * share one mailbox and the choice cannot change which account sends.
 *
 * A tab a teammate currently controls is refused rather than taken back. The
 * owner already has the take-over control in the Web tab, and revoking a
 * grant from under a working teammate is the owner's decision, not this
 * module's.
 *
 * @param {{id: string, url: string, controlled?: boolean}[]} tabs Open tabs of
 *   the active business.
 * @param {string[]} allowedHosts Hosts that count as the mail surface. The
 *   default is Gmail; the Electron mail proof passes its local fixture host.
 */
export function gmailTab(tabs, allowedHosts = [GMAIL_HOST]) {
  if (!tabs.length) return { ok: false, reason: NO_SHARED_TAB };
  const hosts = allowedHosts.map((host) => host.toLowerCase());
  const match = tabs.find((tab) => {
    try {
      return hosts.includes(new URL(tab.url).host.toLowerCase());
    } catch {
      return false;
    }
  });
  if (!match) return { ok: false, reason: NOT_GMAIL };
  if (match.controlled) return { ok: false, reason: WORKER_HELD };
  return { ok: true, id: match.id };
}

/**
 * Claim an action event id for exactly one send attempt.
 *
 * Claimed before the journey runs and never released: a journey that fails
 * after clicking Send has still sent, so a retry must not run the form again.
 *
 * @returns {boolean} `true` for the first caller, `false` for every one after.
 */
export function claimAttempt(attempted, actionEventId) {
  if (attempted.has(actionEventId)) return false;
  attempted.add(actionEventId);
  return true;
}

/**
 * Send one approved outreach email from the owner's own open Gmail tab.
 *
 * Answers in the wire shape the renderer's broker parses for both shells:
 * `{status: "sent", sent_at, to, subject}` or `{status: "failed",
 * failure_reason}`. It never throws: an unusable approval, a missing tab, a
 * tab a teammate holds, a replay, and a journey that fell over are all
 * failures the owner can read on the card.
 *
 * @param {object} args Raw invoke args from the renderer.
 * @param {{tabs: () => {id: string, url: string, controlled?: boolean}[],
 *   send: (input: {tabId: string, to: string, subject: string,
 *     body: string}) => Promise<object>,
 *   attempted: Set<string>, allowedHosts?: string[]}} deps Shell-owned
 *   dependencies.
 */
export async function executeOutreachSend(args, deps) {
  const approval = readApproval(args);
  if (!approval) return failed(MALFORMED);
  let tab;
  try {
    tab = gmailTab(deps.tabs(), deps.allowedHosts ?? [GMAIL_HOST]);
  } catch {
    return failed(NO_SHARED_TAB);
  }
  if (!tab.ok) return failed(tab.reason);
  if (!claimAttempt(deps.attempted, approval.actionEventId))
    return failed(ALREADY_RAN);
  let result;
  try {
    result = await deps.send({
      tabId: tab.id,
      to: approval.to,
      subject: approval.subject,
      body: approval.body,
    });
  } catch {
    // The tab closed, the business changed, or the journey could not start.
    // The claim above stands: the owner reopens the card rather than this
    // module re-running a form that may already have been submitted.
    return failed(NO_SHARED_TAB);
  }
  if (result?.status !== "sent")
    return failed(result?.failure_reason || "Gmail did not confirm the send.");
  // The journey's screenshot stays in the shell: the receipt the broker
  // publishes carries only what the owner approved and what Gmail confirmed.
  return {
    status: "sent",
    sent_at: result.sent_at,
    to: result.to,
    subject: result.subject,
  };
}
