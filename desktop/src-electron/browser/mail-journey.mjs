import { CLICK_FUNCTION, FOCUS_FUNCTION, cdp } from "./page-tools.mjs";

// The same contract the Rust `mail_send` tool in crates/buzz-browser/src/mail.rs
// returns: a fixed Gmail compose journey driven only by accessible-name
// prefixes, with no navigation and no agent-supplied JavaScript.
const WAIT_MS = 30000;
const CONTROL_POLL_MS = 300;
const SENT_POLL_MS = 500;
const MAX_SNAPSHOTS = 30;
const MAX_FIELD = 4000;
const MAX_NAME = 250;
const MAX_NODES = 4000;

const COMPOSE = "Compose";
const TO = "To";
const SUBJECT = "Subject";
const BODY = "Message Body";
const SEND = "Send";

/** Environment variable the Rust daemon gates `mail_send` on (PR #700). */
export const MAIL_SEND_ENV = "BUZZ_BROWSER_MAIL_SEND";
const MAIL_SEND_ENV_ENABLED = "enabled";

/** The refusal the Rust tool returns when the gate is closed, word for word. */
export const MAIL_SEND_DISABLED =
  "mail_send is disabled: sending email requires the owner's outreach approval flow; the desktop enables it only for an approved send job";

/**
 * True only when `BUZZ_BROWSER_MAIL_SEND` is exactly "enabled".
 *
 * The agent-facing tool is off by default in both shells. An agent sends mail
 * by writing an outreach card the owner approves, never by calling this tool
 * itself, so nothing the desktop spawns today sets the variable.
 */
export function mailSendEnabledFromEnv(env = process.env) {
  return env[MAIL_SEND_ENV] === MAIL_SEND_ENV_ENABLED;
}

const seconds = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireField(value, field) {
  if (typeof value !== "string" || !value.length)
    throw new Error(`Field "${field}" must be a non-empty string`);
  if (value.length > MAX_FIELD)
    throw new Error(`Field "${field}" must be at most ${MAX_FIELD} characters`);
  return value;
}

/** Flatten one `Accessibility.getFullAXTree` reply into name/role/backend id. */
async function axNodes(tab) {
  const { nodes } = await cdp(tab, "Accessibility.getFullAXTree");
  const flat = [];
  for (const node of nodes.slice(0, MAX_NODES)) {
    if (node.ignored) continue;
    if (!node.backendDOMNodeId) continue;
    flat.push({
      backendNodeId: node.backendDOMNodeId,
      role: String(node.role?.value || ""),
      name: String(node.name?.value || "").slice(0, MAX_NAME),
    });
  }
  return flat;
}

const findByPrefix = (nodes, prefix, roles) =>
  nodes.find(
    (node) => node.name.startsWith(prefix) && roles.includes(node.role),
  )?.backendNodeId ?? null;

/** All four compose controls, or `null` while any one of them is absent. */
function findControls(nodes) {
  const to = findByPrefix(nodes, TO, ["textbox", "combobox"]);
  const subject = findByPrefix(nodes, SUBJECT, ["textbox"]);
  const body = findByPrefix(nodes, BODY, ["textbox"]);
  const send = findByPrefix(nodes, SEND, ["button"]);
  if (to === null || subject === null || body === null || send === null)
    return null;
  return { to, subject, body, send };
}

/** The same failure strings the Rust journey reports, for the same states. */
function diagnose(nodes) {
  const names = nodes
    .map((node) => node.name)
    .filter(
      (name) =>
        name.startsWith(TO) ||
        name.startsWith(SUBJECT) ||
        name.startsWith(BODY) ||
        name.startsWith(SEND),
    );
  const found = names.join(", ");
  if (!names.length)
    return "missing: To, Subject, Message Body, Send (none found in AX tree)";
  if (!names.some((name) => name.startsWith(TO)))
    return `missing recipient control (expected name starting with 'To', found: ${found})`;
  if (!names.some((name) => name.startsWith(SUBJECT)))
    return `missing subject control (expected name starting with 'Subject', found: ${found})`;
  if (!names.some((name) => name.startsWith(BODY)))
    return `missing body control (expected name starting with 'Message Body', found: ${found})`;
  if (!names.some((name) => name.startsWith(SEND)))
    return `missing send control (expected name starting with 'Send', found: ${found})`;
  return `compose control mismatch (names: ${found})`;
}

/** Click, or focus and insert text, exactly the way `actOnRef` does. */
async function actOnBackendNode(tab, backendNodeId, text) {
  const resolved = await cdp(tab, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("Element is no longer available");
  try {
    const result = await cdp(tab, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: text === undefined ? CLICK_FUNCTION : FOCUS_FUNCTION,
    });
    if (result.exceptionDetails)
      throw new Error("Element could not be acted on");
    if (text !== undefined) await cdp(tab, "Input.insertText", { text });
  } finally {
    await cdp(tab, "Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

async function captureScreenshot(tab) {
  try {
    const result = await cdp(tab, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    return result.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Send one approved email from the Gmail tab the owner already shared.
 *
 * The journey never navigates: it clicks the page's own Compose button, waits
 * (bounded) for the four compose controls to appear by accessible-name prefix,
 * fills them, clicks Send, waits (bounded) for "Message sent", and returns the
 * same JSON contract as the Rust `mail_send` tool.
 *
 * @param {object} tab Tab record owned by `BrowserViews`.
 * @param {{to: string, subject: string, body: string}} args Message fields.
 * @param {(options?: object) => unknown} check Authority guard; `{write: true}`
 *   before every step that changes the page.
 * @param {{waitMs?: number, controlPollMs?: number, sentPollMs?: number,
 *   maxSnapshots?: number}} timing Test-only overrides for the bounded waits.
 *   Production callers omit it and get the 30 s / 30-snapshot bounds.
 * @returns {Promise<object>} `{status, failure_reason, sent_at, to, subject,
 *   screenshot_png_base64}`.
 */
export async function mailSend(tab, args, check, timing = {}) {
  const waitMs = timing.waitMs ?? WAIT_MS;
  const controlPollMs = timing.controlPollMs ?? CONTROL_POLL_MS;
  const sentPollMs = timing.sentPollMs ?? SENT_POLL_MS;
  const maxSnapshots = timing.maxSnapshots ?? MAX_SNAPSHOTS;
  const to = requireField(args.to, "to");
  const subject = requireField(args.subject, "subject");
  const body = requireField(args.body, "body");
  const failed = (reason, screenshot = null) => ({
    status: "failed",
    failure_reason: reason,
    sent_at: seconds(),
    to,
    subject,
    screenshot_png_base64: screenshot,
  });

  check({ write: true });
  tab.observation = null;

  // Step 1: click the page's own Compose button, then wait for the form.
  const deadline = Date.now() + waitMs;
  let nodes = [];
  let controls = null;
  let composeClicked = false;
  for (let attempt = 0; attempt < maxSnapshots; attempt += 1) {
    check();
    nodes = await axNodes(tab);
    controls = findControls(nodes);
    if (controls) break;
    const compose = findByPrefix(nodes, COMPOSE, ["button", "link"]);
    if (compose !== null && !composeClicked) {
      check({ write: true });
      try {
        await actOnBackendNode(tab, compose);
      } catch (error) {
        return failed(`compose click failed: ${error.message}`);
      }
      composeClicked = true;
    }
    if (Date.now() >= deadline) break;
    await sleep(controlPollMs);
  }
  if (!controls) return failed(diagnose(nodes));

  // Step 2: fill the three fields, then click Send.
  const steps = [
    ["recipient", controls.to, to],
    ["subject", controls.subject, subject],
    ["body", controls.body, body],
    ["send", controls.send, undefined],
  ];
  for (const [label, backendNodeId, text] of steps) {
    check({ write: true });
    try {
      await actOnBackendNode(tab, backendNodeId, text);
    } catch (error) {
      const verb = text === undefined ? "click" : "type";
      return failed(`${label} ${verb} failed: ${error.message}`);
    }
  }

  // Step 3: wait (bounded) for Gmail's own "Message sent" confirmation.
  const sentDeadline = Date.now() + waitMs;
  let sent = false;
  for (let attempt = 0; attempt < maxSnapshots && !sent; attempt += 1) {
    check();
    sent = (await axNodes(tab)).some((node) =>
      node.name.includes("Message sent"),
    );
    if (sent || Date.now() >= sentDeadline) break;
    await sleep(sentPollMs);
  }

  const screenshot = await captureScreenshot(tab);
  if (!sent)
    return failed(
      "timeout: 'Message sent' did not appear within 30 s",
      screenshot,
    );
  return {
    status: "sent",
    failure_reason: null,
    sent_at: seconds(),
    to,
    subject,
    screenshot_png_base64: screenshot,
  };
}
