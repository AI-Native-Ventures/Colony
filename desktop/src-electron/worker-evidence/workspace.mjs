import path from "node:path";

import { normalizeRelay, runtimeId } from "../browser/managed-workers.mjs";

const PUBKEY_PATTERN = /^[a-f0-9]{64}$/i;

function requireAbsoluteDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("Managed-agent data directory must be absolute");
  }
  return path.resolve(value);
}

/**
 * Resolve the sandbox home created by the native isolation launcher.
 *
 * `isolation/launch.rs::wrap` creates
 * `{managed_agents_base_dir}/isolated/{runtime_id}/home`. The Electron main
 * process supplies the already native-owned base directory; worker records'
 * optional `working_dir` field is intentionally ignored because it describes a
 * project checkout, not the isolated home used for evidence output.
 */
export function nativeManagedWorkerWorkspace({
  managedAgentsBaseDir,
  workerPubkey,
  relayUrl,
} = {}) {
  if (
    typeof workerPubkey !== "string" ||
    !PUBKEY_PATTERN.test(workerPubkey)
  ) {
    throw new Error("Managed-agent identity is invalid");
  }
  const base = requireAbsoluteDirectory(managedAgentsBaseDir);
  const relay = normalizeRelay(relayUrl);
  return path.join(base, "isolated", runtimeId(workerPubkey, relay), "home");
}

/** Create the resolver injected into `EvidenceAuthority`. */
export function createNativeWorkspaceResolver(managedAgentsBaseDir) {
  const base = requireAbsoluteDirectory(managedAgentsBaseDir);
  return ({ workerPubkey, relayUrl } = {}) =>
    nativeManagedWorkerWorkspace({
      managedAgentsBaseDir: base,
      workerPubkey,
      relayUrl,
    });
}
