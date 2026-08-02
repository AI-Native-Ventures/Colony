import { invoke } from "@tauri-apps/api/core";

export type DiscoveryCredentialStatus =
  | "configured"
  | "missing"
  | "unavailable";

export function saveDiscoveryOutscraperCredential(
  value: string,
): Promise<DiscoveryCredentialStatus> {
  return invoke<DiscoveryCredentialStatus>(
    "save_discovery_outscraper_credential",
    { value },
  );
}

export function getDiscoveryOutscraperCredentialStatus(): Promise<DiscoveryCredentialStatus> {
  return invoke<DiscoveryCredentialStatus>(
    "get_discovery_outscraper_credential_status",
  );
}

export function deleteDiscoveryOutscraperCredential(): Promise<DiscoveryCredentialStatus> {
  return invoke<DiscoveryCredentialStatus>(
    "delete_discovery_outscraper_credential",
  );
}
