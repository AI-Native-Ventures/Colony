import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { invokeTauri } from "@/shared/api/invokeTauri";
// Straight from the module that owns it, not through the `tauri` barrel: a
// test that mocks the barrel (welcomeGuidePowerRace does) would otherwise lose
// this export and fail to load anything downstream of it.
import {
  fromRawAcpRuntimeCatalogEntry,
  type RawAcpRuntimeCatalogEntry,
} from "@/shared/api/runtimeCatalog";

/**
 * Discover the ACP runtime catalog.
 *
 * `force` defaults to `false` — the cheap backend path that serves cached
 * availability + auth statuses with no process spawns. Pass `{ force: true }`
 * only from surfaces that need fresh auth/version state (Settings, onboarding,
 * post-mutation refresh); that path runs the expensive probe pipeline.
 */
export async function discoverAcpRuntimes(options?: {
  force?: boolean;
}): Promise<AcpRuntimeCatalogEntry[]> {
  const raw = await invokeTauri<RawAcpRuntimeCatalogEntry[]>(
    "discover_acp_providers",
    { force: options?.force ?? false },
  );
  return raw.map(fromRawAcpRuntimeCatalogEntry);
}
