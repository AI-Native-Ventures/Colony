/**
 * Project-channel lookup helpers for the Factory kind.
 */
import type { Project } from "@/features/projects/projectModels";

/** Find the project whose `projectChannelId` matches the given channel id. */
export function findProjectForChannel(
  projects: readonly Project[] | undefined,
  channelId: string,
): Project | null {
  if (!projects) return null;
  return (
    projects.find((project) => project.projectChannelId === channelId) ?? null
  );
}

/** Whether the given channel id belongs to a project. */
export function isProjectChannel(
  projects: readonly Project[] | undefined,
  channelId: string,
): boolean {
  return findProjectForChannel(projects, channelId) !== null;
}
