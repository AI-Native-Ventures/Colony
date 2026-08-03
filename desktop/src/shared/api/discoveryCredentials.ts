import { invoke } from "@tauri-apps/api/core";

export type DiscoveryCredentialStatus =
  | "configured"
  | "missing"
  | "unavailable";

export type DiscoveryCredentialProvider =
  | "outscraper"
  | "brave_search"
  | "exa_search";

export function saveDiscoveryCredential(
  provider: DiscoveryCredentialProvider,
  value: string,
): Promise<DiscoveryCredentialStatus> {
  return invoke<DiscoveryCredentialStatus>("save_discovery_credential", {
    provider,
    value,
  });
}

export function getDiscoveryCredentialStatus(
  provider: DiscoveryCredentialProvider,
): Promise<DiscoveryCredentialStatus> {
  return invoke<DiscoveryCredentialStatus>("get_discovery_credential_status", {
    provider,
  });
}

export function deleteDiscoveryCredential(
  provider: DiscoveryCredentialProvider,
): Promise<DiscoveryCredentialStatus> {
  return invoke<DiscoveryCredentialStatus>("delete_discovery_credential", {
    provider,
  });
}
