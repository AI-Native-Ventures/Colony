import { assertMailSendEnabled, mailSend } from "./mail-journey.mjs";
import { actOnRef, screenshot, snapshot } from "./page-tools.mjs";

// The agent-facing half of the browser tools, split out of BrowserViews so it
// can be proven without Electron. Authority is already settled by the time a
// call arrives here: the caller passes the tab it resolved from the grant, and
// the `check` guard that enforces scope, mode and staleness.

/**
 * Run one agent-facing browser tool against an already authorised tab.
 *
 * `mail_send` is refused unless this process was started with
 * `BUZZ_BROWSER_MAIL_SEND=enabled`. The gate lives here, in the main process,
 * rather than only in the MCP adapter: a worker holds the broker socket path
 * and its own grant token, so it can reach the broker without the adapter.
 * The owner-side outreach send does not come through this function.
 *
 * @param {object} tab Tab record owned by `BrowserViews`.
 * @param {string} method Tool name from the worker.
 * @param {object} args Tool arguments from the worker.
 * @param {(options?: object) => unknown} check Authority guard.
 * @param {Record<string, string | undefined>} env Process environment.
 */
export function runBrowserTool(tab, method, args, check, env = process.env) {
  if (method === "browser_snapshot") return snapshot(tab, check);
  if (method === "browser_screenshot") return screenshot(tab, check);
  if (["browser_type", "browser_click"].includes(method))
    return actOnRef(tab, args, method, check);
  if (method === "mail_send") {
    assertMailSendEnabled(env);
    return mailSend(tab, args, check);
  }
  throw new Error("Unknown browser tool");
}
