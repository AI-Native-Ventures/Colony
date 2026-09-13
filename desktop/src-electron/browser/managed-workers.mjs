import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
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
/** Native launch nonce prevents surviving descendants from reading renewed grants. */
export function grantFilename(row) {
  if (
    typeof row.browser_generation !== "string" ||
    !/^[a-f0-9]{32}$/.test(row.browser_generation)
  )
    throw Error("Missing isolated browser launch generation");
  return `${runtimeId(row.pubkey, row.relay_url)}__${row.browser_generation}.json`;
}
function eligible(row, relay) {
  try {
    return (
      row.owner_identified === true &&
      row.isolated === true &&
      !!grantFilename(row) &&
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

function validateEvidenceToken(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("Invalid evidence capability");
  return value;
}

function validateRenewalToken(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error("Invalid evidence renewal capability");
  return value;
}

function evidenceScope(binding) {
  return Object.freeze({
    communityId: binding.communityId,
    relayUrl: binding.relayUrl,
    jobId: binding.jobId,
    taskId: binding.taskId,
    channelId: binding.channelId,
    workerPubkey: binding.workerPubkey,
    threadRoot: binding.threadRoot,
  });
}

function sameEvidenceScope(left, right) {
  return [
    "communityId",
    "relayUrl",
    "jobId",
    "taskId",
    "channelId",
    "workerPubkey",
    "threadRoot",
  ].every((key) => left?.[key] === right?.[key]);
}

/** Owner-selected grants. The native roster supplies ownership and live status. */
export class ManagedBrowser {
  bindings = new Map();
  pendingShares = new Map();
  grantQueues = new Map();
  evidenceRenewals = new Map();
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

  /** Serialize tab/evidence grant writers so neither capability overwrites the other. */
  grantFileQueue(file, work) {
    const previous = this.grantQueues.get(file) || Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    this.grantQueues.set(file, task);
    return task.finally(() => {
      if (this.grantQueues.get(file) === task) this.grantQueues.delete(file);
    });
  }

  async writeGrantFile(file, value, nonce) {
    const safeNonce = String(nonce).replace(/[^A-Za-z0-9._-]/g, "_");
    const temporary = `${file}.${safeNonce}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
      await this.replaceFile(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
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
    const file = path.join(this.root, grantFilename(row));
    // A teammate has at most one shared tab in this beta. Revoke an older token
    // before replacing its file, so an already-running adapter cannot reuse it.
    for (const [token, binding] of this.bindings)
      if (
        binding.pubkey === row.pubkey &&
        binding.context.relay === context.relay
      ) {
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
      generation: row.browser_generation,
      context,
    };
    this.bindings.set(grant.token, binding);
    try {
      await this.grantFileQueue(file, async () => {
        let existing = null;
        try {
          existing = JSON.parse(await readFile(file, "utf8"));
        } catch {}
        const evidence =
          existing?.socketPath === this.socketPath &&
          typeof existing?.evidence?.token === "string"
            ? existing.evidence
            : undefined;
        const next = { socketPath: this.socketPath, token: grant.token };
        if (evidence) next.evidence = evidence;
        if (
          this.context() !== context ||
          !this.views.authority.grants.has(grant.token)
        )
          throw Error("Browser sharing was cancelled");
        await this.writeGrantFile(file, next, grant.token);
      });
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
      throw error;
    }
  }

  /**
   * Persist a native EvidenceAuthority grant without requiring an owner-shared
   * tab. The authority validation is repeated inside the serialized write, so
   * this path cannot turn a worker lifecycle row into job access by itself.
   */
  async writeEvidenceGrantFromAuthority(
    authority,
    token,
    expected = {},
    { previousRenewalToken } = {},
  ) {
    if (authority === null || typeof authority?.validate !== "function")
      throw Error("Evidence authority is unavailable");
    const checkedToken = validateEvidenceToken(token);
    const binding = await authority.validate(checkedToken, expected);
    const scope = evidenceScope(binding);
    if (previousRenewalToken !== undefined) {
      const previous = this.getEvidenceRenewal(previousRenewalToken, expected);
      if (!sameEvidenceScope(previous.scope, scope))
        throw Error("The evidence renewal scope changed; retry evidence access");
    }
    const context = this.context();
    if (!context?.id || !context.relay)
      throw Error("Choose a business before granting evidence access");
    const row = (await this.rows(context)).find(
      (candidate) =>
        candidate.pubkey === binding.workerPubkey &&
        candidate.pid === binding.pid &&
        candidate.last_started_at === binding.started &&
        candidate.browser_generation === binding.generation,
    );
    if (!row)
      throw Error("The worker lifecycle changed; retry evidence access");
    const file = path.join(this.root, grantFilename(row));
    return this.grantFileQueue(file, async () => {
      await authority.validate(checkedToken, expected);
      if (
        previousRenewalToken !== undefined &&
        !this.evidenceRenewals.has(validateRenewalToken(previousRenewalToken))
      )
        throw Error("The evidence renewal capability is no longer valid");
      let existing = null;
      try {
        existing = JSON.parse(await readFile(file, "utf8"));
      } catch {}
      if (existing !== null && existing?.socketPath !== this.socketPath)
        throw Error("The worker browser grant belongs to another host");
      if (this.context() !== context)
        throw Error("The business context changed; retry evidence access");

      // Repeated roster/head refreshes can ask for the same authority binding
      // after the UI has already delivered it. Preserve the host-issued
      // renewal token when the exact validated token and scope are still in
      // the generation-specific file. A renewal request passes an explicit
      // predecessor and intentionally rotates that token instead.
      if (
        previousRenewalToken === undefined &&
        existing?.evidence?.token === checkedToken &&
        sameEvidenceScope(existing.evidence.scope, scope)
      ) {
        let existingRenewalToken;
        try {
          existingRenewalToken = validateRenewalToken(
            existing.evidence.renewalToken,
          );
        } catch {
          existingRenewalToken = null;
        }
        if (existingRenewalToken !== null) {
          this.evidenceRenewals.set(existingRenewalToken, { scope });
          return {
            token: checkedToken,
            renewalToken: existingRenewalToken,
            scope,
            file,
          };
        }
      }
      const renewalToken = randomBytes(32).toString("hex");
      await this.writeGrantFile(
        file,
        {
          ...(existing ?? {}),
          socketPath: this.socketPath,
          evidence: {
            token: checkedToken,
            renewalToken,
            scope,
          },
        },
        `evidence-${checkedToken}`,
      );
      const previousFileRenewal = existing?.evidence?.renewalToken;
      if (previousRenewalToken !== undefined)
        this.evidenceRenewals.delete(validateRenewalToken(previousRenewalToken));
      if (
        typeof previousFileRenewal === "string" &&
        previousFileRenewal !== renewalToken
      ) {
        try {
          this.evidenceRenewals.delete(validateRenewalToken(previousFileRenewal));
        } catch {}
      }
      this.evidenceRenewals.set(renewalToken, { scope });
      return { token: checkedToken, renewalToken, scope, file };
    });
  }

  /** Return the host-issued scope behind a renewal token, never caller authority. */
  getEvidenceRenewal(renewalToken, expected = {}) {
    const checked = validateRenewalToken(renewalToken);
    const record = this.evidenceRenewals.get(checked);
    if (!record) throw Error("The evidence renewal capability is no longer valid");
    for (const key of [
      "communityId",
      "relayUrl",
      "jobId",
      "taskId",
      "channelId",
      "workerPubkey",
      "threadRoot",
    ]) {
      if (expected[key] !== undefined && expected[key] !== record.scope[key])
        throw Error("The evidence renewal scope does not match");
    }
    return record;
  }

  revokeEvidenceRenewals() {
    this.evidenceRenewals.clear();
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
        row.last_started_at !== binding.started ||
        row.browser_generation !== binding.generation
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
