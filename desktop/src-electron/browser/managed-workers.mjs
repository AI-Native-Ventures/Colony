import { createHash } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Mirrors buzz-core's canonical relay identity, including loopback aliases. */
export function normalizeRelay(raw) {
  const url = new URL(raw.trim());
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error("Invalid business relay");
  if (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  )
    url.hostname = "127.0.0.1";
  return url.href.replace(/\/+$/, "");
}
/** Same opaque filename as ManagedAgentRuntimeKey::runtime_id in Rust. */
export function runtimeId(pubkey, relay) {
  if (typeof pubkey !== "string" || !/^[a-f0-9]{64}$/i.test(pubkey))
    throw Error("Invalid teammate identity");
  return `${pubkey.toLowerCase()}__${createHash("sha256").update(normalizeRelay(relay)).digest("hex")}`;
}
function eligible(row, relay) {
  try {
    return (
      row.owner_identified === true &&
      row.backend?.type === "local" &&
      row.status === "running" &&
      Number.isInteger(row.pid) &&
      row.pid > 0 &&
      row.last_started_at &&
      row.respond_to === "owner-only" &&
      row.needs_restart === false &&
      !row.persona_orphaned &&
      normalizeRelay(row.relay_url) === relay
    );
  } catch {
    return false;
  }
}

/** Owner-selected grants. The native roster supplies ownership and live status. */
export class ManagedBrowser {
  bindings = new Map();
  pendingShares = new Map();
  constructor({
    root,
    socketPath,
    views,
    roster,
    context,
    replaceFile = rename,
  }) {
    Object.assign(this, {
      root,
      socketPath,
      views,
      roster,
      context,
      replaceFile,
    });
  }
  async rows(expected = this.context()) {
    if (!expected?.id || !expected.relay || this.views.business !== expected.id)
      throw Error("Choose a business first");
    const rows = await this.roster();
    if (this.context() !== expected || this.views.business !== expected.id)
      throw Error("Business changed; reopen this action");
    return rows.filter((row) => eligible(row, normalizeRelay(expected.relay)));
  }
  async list() {
    return (await this.rows()).map(({ pubkey, name }) => ({ pubkey, name }));
  }
  share(payload) {
    const context = this.context();
    const tab = this.views.get(payload.id);
    const epoch = this.views.authority.tabs.get(payload.id)?.grantEpoch;
    const key = runtimeId(payload.pubkey, context?.relay || "");
    const previous = this.pendingShares.get(key) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => this.shareNow(payload, { context, tab, epoch }));
    this.pendingShares.set(key, task);
    return task.finally(() => {
      if (this.pendingShares.get(key) === task) this.pendingShares.delete(key);
    });
  }
  async shareNow({ id, pubkey, mode }, { context, tab, epoch }) {
    const row = (await this.rows(context)).find((row) => row.pubkey === pubkey);
    if (!row)
      throw Error(
        "Start a local, owner-only teammate with current settings before sharing",
      );
    if (
      this.views.get(id) !== tab ||
      tab.workspace !== context.id ||
      this.views.authority.tabs.get(id)?.grantEpoch !== epoch
    )
      throw Error("Browser tab changed");
    const file = path.join(
      this.root,
      `${runtimeId(row.pubkey, row.relay_url)}.json`,
    );
    // A teammate has at most one shared tab in this beta. Revoke an older token
    // before replacing its file, so an already-running adapter cannot reuse it.
    for (const [token, binding] of this.bindings)
      if (binding.file === file) {
        this.views.authority.revokeToken(token);
        this.bindings.delete(token);
      }
    const label =
      row.name.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 48) || "Teammate";
    const grant = this.views.authority.grant(id, label, mode);
    const binding = {
      file,
      tabId: id,
      pubkey: row.pubkey,
      pid: row.pid,
      started: row.last_started_at,
      context,
    };
    this.bindings.set(grant.token, binding);
    const temporary = `${file}.${grant.token}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ socketPath: this.socketPath, token: grant.token }),
        { mode: 0o600, flag: "wx" },
      );
      if (
        this.context() !== context ||
        !this.views.authority.grants.has(grant.token)
      )
        throw Error("Browser sharing was cancelled");
      await this.replaceFile(temporary, file);
      if (
        this.context() !== context ||
        !this.views.authority.grants.has(grant.token)
      )
        throw Error("Browser sharing was cancelled");
      this.views.notify(tab);
      return { name: row.name, mode };
    } catch (error) {
      this.views.authority.revokeToken(grant.token);
      this.bindings.delete(grant.token);
      await rm(temporary, { force: true });
      throw error;
    }
  }
  async validate(token) {
    const binding = this.bindings.get(token);
    if (!binding || !this.views.authority.grants.has(token))
      throw Error("Browser access revoked");
    try {
      const row = (await this.rows(binding.context)).find(
        (row) => row.pubkey === binding.pubkey,
      );
      if (
        !row ||
        row.pid !== binding.pid ||
        row.last_started_at !== binding.started
      )
        throw Error("Teammate is no longer running or its settings changed");
      this.views.authority.check(token, binding.tabId);
    } catch (error) {
      this.views.authority.revokeToken(token);
      this.bindings.delete(token);
      try {
        this.views.notify(this.views.get(binding.tabId));
      } catch {}
      throw error;
    }
  }
  async request(request) {
    await this.validate(request.token);
    return this.views.request(request, () => this.validate(request.token));
  }
}
