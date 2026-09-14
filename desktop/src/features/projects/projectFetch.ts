/**
 * Community-wide project enumeration.
 *
 * Split out of `hooks.ts` so that file stays under the desktop file-size
 * ratchet; upstream's #6939 keeps the same split and file name. Owns the
 * hidden-card filter that scopes what the Projects surface enumerates.
 */
import {
  buildProjectsFromFetcher,
  type FetchProjectEventsExhaustively,
  fetchProjectEventsExhaustively,
} from "./projectEnumeration";
import type { Project } from "./projectModels";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";

const HIDDEN_PROJECT_CARDS_KEY = "buzz.projects.hidden-cards.v1";

function readHiddenProjectCards(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(HIDDEN_PROJECT_CARDS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Enumerates the community's projects, minus the viewer's hidden cards.
 */
export async function fetchProjects(
  fetchExhaustively?: FetchProjectEventsExhaustively,
  signal?: AbortSignal,
): Promise<Project[]> {
  // Delegates to `buildProjectsFromFetcher` in `projectEnumeration.ts`, which
  // is the pure, Tauri-free core of this operation. That helper's javadoc
  // explains the fail-closed tombstone contract and the NIP-OA owner-deletion
  // relay-side-suppression decision.
  const fetcher: FetchProjectEventsExhaustively =
    fetchExhaustively ??
    ((kinds, extraFilter) =>
      fetchProjectEventsExhaustively(kinds, extraFilter, undefined, signal));
  return buildProjectsFromFetcher(fetcher, {
    relayOrigin: getCachedRelayOrigin(),
    hiddenAddresses: new Set(readHiddenProjectCards()),
  });
}
