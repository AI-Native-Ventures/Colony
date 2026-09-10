/**
 * Project-channel lookup helpers for the Factory kind.
 */
import type { Project, Repository } from "@/features/projects/projectModels";

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

/** Build the chip label for a project: `name · defaultBranch`. */
export function projectChipLabel(
  project: Project | null,
  primaryRepo?: Repository | null,
): string {
  if (!project) return "Unknown project · main";
  const repo = primaryRepo ?? project.repositories[0] ?? null;
  return `${project.name} · ${repo?.defaultBranch ?? "main"}`;
}
