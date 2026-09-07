import { randomBytes } from "node:crypto";

export function normalizeUrl(value) {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Invalid URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Only HTTP(S) URLs without credentials are supported");
  }
  return url.href;
}

export class Authority {
  tabs = new Map();
  grants = new Map();

  add(tab) {
    this.tabs.set(tab.id, {
      ...tab,
      url: normalizeUrl(tab.url),
      revision: 0,
      grantEpoch: 0,
    });
  }

  grant(tabId, worker, mode = "read") {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("Tab is closed");
    if (!/^[a-zA-Z0-9 _-]{1,48}$/.test(worker))
      throw new Error("Invalid worker name");
    if (!["read", "interact"].includes(mode))
      throw new Error("Invalid grant mode");
    if ([...this.grants.values()].some((g) => g.tabId === tabId))
      throw new Error("Tab already has a controller");
    tab.grantEpoch += 1;
    const grant = {
      token: randomBytes(32).toString("hex"),
      tabId,
      worker,
      mode,
      workspace: tab.workspace,
      origin: new URL(tab.url).origin,
    };
    this.grants.set(grant.token, grant);
    return grant;
  }

  check(token, tabId, { write = false, revision } = {}) {
    const grant = this.grants.get(token);
    if (!grant)
      throw new Error("Access revoked; ask the owner to share the tab again");
    const tab = this.tabs.get(tabId);
    if (
      !tab ||
      grant.tabId !== tabId ||
      grant.workspace !== tab.workspace ||
      new URL(tab.url).origin !== grant.origin
    )
      throw new Error("Tab scope mismatch");
    if (write && grant.mode !== "interact")
      throw new Error("This grant is read-only");
    if (revision !== undefined && revision !== tab.revision)
      throw new Error("Observation is stale; take a new snapshot");
    return tab;
  }

  revokeToken(token) {
    const grant = this.grants.get(token);
    if (!grant) return;
    this.grants.delete(token);
    const tab = this.tabs.get(grant.tabId);
    if (tab) tab.grantEpoch += 1;
  }

  revoke(tabId) {
    const tab = this.tabs.get(tabId);
    if (tab) tab.grantEpoch += 1;
    for (const [key, grant] of this.grants)
      if (grant.tabId === tabId) this.grants.delete(key);
  }

  navigate(tabId, url) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const next = normalizeUrl(url);
    if (new URL(next).origin !== new URL(tab.url).origin) this.revoke(tabId);
    tab.url = next;
    tab.revision += 1;
  }

  remove(tabId) {
    this.revoke(tabId);
    this.tabs.delete(tabId);
  }
}
