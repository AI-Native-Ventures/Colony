/**
 * Linking a project to a channel.
 *
 * The relation is one `buzz-channel` tag on the project's kind:30621
 * announcement, so linking and unlinking are a tag patch on the live signed
 * head — never a channel-type change and never a new relay concept.
 */

import { isValidProjectChannelId } from "../projectModels";
import type { Project } from "../projectModels";

const CHANNEL_TAG = "buzz-channel";

/**
 * Returns `tags` carrying exactly one `buzz-channel` tag for `channelId`, or
 * none when `channelId` is null. Every other tag keeps its value and its
 * position; an existing channel tag is replaced where it already sits, so the
 * patch stays a minimal diff of the live head.
 */
export function withProjectChannel(
  tags: readonly (readonly string[])[],
  channelId: string | null,
): string[][] {
  const normalized = channelId?.trim() ?? null;
  if (normalized !== null && !isValidProjectChannelId(normalized)) {
    throw new Error("Project channel id is invalid.");
  }

  const next: string[][] = [];
  let replaced = false;
  for (const tag of tags) {
    if (tag[0] !== CHANNEL_TAG) {
      next.push([...tag]);
      continue;
    }
    // Collapse duplicates a nonconforming head may carry: only the first
    // channel tag survives, and only when a link is being written.
    if (normalized !== null && !replaced) {
      next.push([CHANNEL_TAG, normalized]);
      replaced = true;
    }
  }

  if (normalized !== null && !replaced) {
    next.push([CHANNEL_TAG, normalized]);
  }

  return next;
}

type LinkableProject = Pick<Project, "owner" | "projectChannelId">;

/**
 * The projects a user may link to `channelId`: their own projects that either
 * have no channel yet or already point at this one. A project owned by
 * someone else, or already linked elsewhere, is not offered — re-pointing it
 * would silently move another channel's project.
 */
export function linkableProjects<T extends LinkableProject>(
  projects: readonly T[] | null | undefined,
  channelId: string | null | undefined,
  currentPubkey: string | null | undefined,
): T[] {
  const owner = currentPubkey?.trim().toLowerCase();
  if (!owner) return [];
  return (projects ?? []).filter(
    (project) =>
      project.owner.toLowerCase() === owner &&
      (!project.projectChannelId || project.projectChannelId === channelId),
  );
}
