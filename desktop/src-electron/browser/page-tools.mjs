import { randomBytes } from "node:crypto";

async function cdp(tab, method, params = {}) {
  if (!tab.view.webContents.debugger.isAttached())
    tab.view.webContents.debugger.attach("1.3");
  return tab.view.webContents.debugger.sendCommand(method, params);
}

export async function snapshot(tab, check) {
  const before = check().revision;
  const { nodes } = await cdp(tab, "Accessibility.getFullAXTree");
  check({ revision: before });
  const nonce = randomBytes(6).toString("hex");
  const refs = new Map();
  const lines = [];
  let length = 0;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = String(node.role?.value || "");
    const name = String(node.name?.value || "").slice(0, 250);
    if (["none", "generic"].includes(role) && !name) continue;
    const ref = `${nonce}-${lines.length + 1}`;
    if (node.backendDOMNodeId)
      refs.set(ref, { backendNodeId: node.backendDOMNodeId, role });
    const line = `${ref} ${role} ${name}`.trim();
    if (length + line.length > 12000 || lines.length >= 200) break;
    length += line.length;
    lines.push(line);
  }
  tab.observation = { refs, revision: before };
  return {
    tabId: tab.id,
    url: tab.view.webContents.getURL(),
    title: tab.view.webContents.getTitle(),
    outline: lines.join("\n"),
    truncated: lines.length >= 200 || length >= 11700,
  };
}

export async function actOnRef(tab, args, method, check) {
  const observation = tab.observation;
  const target = observation?.refs.get(args.ref);
  if (!target)
    throw new Error("Unknown or stale reference; take a new snapshot");
  const guard = () => check({ write: true, revision: observation.revision });
  guard();
  if (
    method === "browser_type" &&
    (typeof args.text !== "string" || args.text.length > 4000)
  )
    throw new Error("Text must be at most 4000 characters");
  const resolved = await cdp(tab, "DOM.resolveNode", {
    backendNodeId: target.backendNodeId,
  });
  guard();
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("Element is no longer available");
  try {
    // No agent-supplied JavaScript. CDP resolves only refs from our last AX snapshot.
    const functionDeclaration =
      method === "browser_click"
        ? 'function(){ if (!this.isConnected) throw new Error("Element detached"); this.scrollIntoView({block:"center"}); this.click(); }'
        : 'function(){ if (!this.isConnected || this.type === "password" || this.disabled || this.readOnly || !(this.tagName === "INPUT" || this.tagName === "TEXTAREA" || this.isContentEditable)) throw new Error("Not an editable non-password field"); this.scrollIntoView({block:"center"}); this.focus(); }';
    const result = await cdp(tab, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
    });
    if (result.exceptionDetails)
      throw new Error("Element could not be acted on");
    guard();
    if (method === "browser_type") {
      await cdp(tab, "Input.insertText", { text: args.text });
      guard();
    }
    tab.observation = null;
    return {
      tabId: tab.id,
      dispatched: true,
      next: "Read a fresh snapshot to verify the result",
    };
  } finally {
    await cdp(tab, "Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

export async function screenshot(tab, check) {
  const revision = check().revision;
  const result = await cdp(tab, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  check({ revision });
  return { data: result.data };
}
