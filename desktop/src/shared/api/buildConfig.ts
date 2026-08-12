import { invoke } from "@/shared/api/nativeBridge";

/** Immutable relay URL embedded when this desktop binary was built. */
export function getBuildDefaultRelayUrl(): Promise<string | null> {
  return invoke<string | null>("get_build_default_relay_url");
}
