/**
 * The real auth service, wired to the identity this computer already holds.
 *
 * This module exists to keep NIP-49 key material out of the flow component.
 * A scan (`shared/lib/ncryptsecSourceScan.test.mjs`) confines that material to
 * an allowlist, so concentrating the identity calls here means the allowlist
 * covers a small file with one job rather than a large screen component that
 * many future changes will touch. `lib/encryptedBackup.ts` follows the same
 * shape for the same reason.
 *
 * The app generates and persists a keypair on first launch, so there is always
 * something to encrypt before onboarding runs. Nothing here executes until the
 * account screen is submitted.
 */
import { getRelayHttpUrl } from "@/shared/api/tauri";
import {
  createNcryptsecBackup,
  getIdentity,
  importIdentity,
} from "@/shared/api/tauriIdentity";

import { createAuthService } from "../authService";
import type { OnboardingServices } from "../contracts";
import { createFakeServices } from "../contracts.fake";

/** Bound account requests so an unreachable server fails in seconds instead
 *  of hanging on the OS-level connect timeout (mirrors invites.ts). */
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/** POST JSON to the active community's server. Network failures throw and
 *  become `unreachable` inside authService; non-2xx responses are returned as
 *  data, never thrown. */
async function postJson(path: string, body: unknown) {
  const base = await getRelayHttpUrl();
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  });
  const parsed: unknown = await response.json().catch(() => ({}));
  return { status: response.status, body: parsed };
}

/** Build the auth service against the real relay and the real identity. */
export function createWiredAuthService() {
  return createAuthService({
    post: postJson,
    createBackup: createNcryptsecBackup,
    importIdentity: async (blob, password) => {
      await importIdentity(blob, password);
    },
    getPubkey: async () => (await getIdentity()).pubkey,
  });
}

/**
 * Which auth service the machine onboarding pages run on, decided the same
 * way `NewOnboardingFlow.resolveAuthServices` decides for the canvas flow:
 * the e2e build keeps fakes so its specs stay hermetic, everything else gets
 * the real service.
 */
export function resolveMachineAuthService(env: {
  MODE?: string;
}): OnboardingServices["auth"] {
  return env.MODE === "e2e"
    ? createFakeServices().auth
    : createWiredAuthService();
}
