/**
 * Project channels: the derived view that makes a channel owned by a project
 * look different from a plain stream channel.
 *
 * A channel is a *project channel* when some project claims it as its
 * `projectChannelId`. Nothing on the channel itself says so, and no relay or
 * channel-type change is involved — the relation lives on the kind:30621
 * project announcement (`buzz-channel` tag), so every surface that wants to
 * treat those channels differently derives it here.
 */

import type { Channel } from "@/shared/api/types";
import type { Project, Repository } from "../projectModels";

export type ProjectChannel = {
  channel: Channel;
  project: Project;
};

type ProjectChannelSource = Pick<Project, "projectChannelId">;

/** Index of channel id → owning project, first project wins on a tie. */
function projectsByChannelId<T extends ProjectChannelSource>(
  projects: readonly T[] | null | undefined,
): Map<string, T> {
  const byChannelId = new Map<string, T>();
  for (const project of projects ?? []) {
    const channelId = project.projectChannelId;
    if (!channelId || byChannelId.has(channelId)) continue;
    byChannelId.set(channelId, project);
  }
  return byChannelId;
}

/** The project owning `channelId`, or null when no project claims it. */
export function projectForChannel<T extends ProjectChannelSource>(
  projects: readonly T[] | null | undefined,
  channelId: string | null | undefined,
): T | null {
  if (!channelId) return null;
  return projectsByChannelId(projects).get(channelId) ?? null;
}

/**
 * Splits channels into the ones a project owns and everything else, keeping
 * the input order within each side.
 */
export function partitionProjectChannels(
  channels: readonly Channel[] | null | undefined,
  projects: readonly Project[] | null | undefined,
): { projectChannels: ProjectChannel[]; rest: Channel[] } {
  const byChannelId = projectsByChannelId(projects);
  const projectChannels: ProjectChannel[] = [];
  const rest: Channel[] = [];

  for (const channel of channels ?? []) {
    const project = byChannelId.get(channel.id);
    if (project) {
      projectChannels.push({ channel, project });
    } else {
      rest.push(channel);
    }
  }

  return { projectChannels, rest };
}

type RepositoryMeta = Pick<
  Repository,
  "cloneUrls" | "defaultBranch" | "dtag" | "name" | "repoAddress"
>;

/** The project's primary repository, falling back to the first one it has. */
export function primaryRepository<T extends RepositoryMeta>(
  project: Pick<Project, "primaryRepositoryAddress"> | null | undefined,
  repositories: readonly T[] | null | undefined,
): T | null {
  if (!repositories || repositories.length === 0) return null;
  const primary = repositories.find(
    (repository) =>
      repository.repoAddress === project?.primaryRepositoryAddress,
  );
  return primary ?? repositories[0] ?? null;
}

/** The `/git/<owner-pubkey>/<repo>` path a Buzz relay serves its own repos on. */
const RELAY_HOSTED_PATH = /^\/?git\/[0-9a-f]{64}\/[^/]+$/i;

/** The path part of a clone URL: `owner/repo`, `git/<pubkey>/repo`, … */
function cloneUrlPath(cloneUrl: string): string {
  const trimmed = cloneUrl
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  try {
    return new URL(trimmed).pathname;
  } catch {
    // scp-style remotes (`git@github.com:block/buzz`) are not URLs.
    const colon = trimmed.lastIndexOf(":");
    return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  }
}

/**
 * "owner/repo" for a repository — the last two path segments of its clone URL,
 * which is how a GitHub-hosted repo carries its account.
 *
 * A relay-hosted repo falls back to its own name: its path carries the owner's
 * 64-hex pubkey, and a pubkey in a header reads as noise, not as an account.
 */
export function repositorySlug(
  repository: RepositoryMeta | null | undefined,
): string | null {
  if (!repository) return null;

  const cloneUrl = repository.cloneUrls?.find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (cloneUrl) {
    const path = cloneUrlPath(cloneUrl);
    if (!RELAY_HOSTED_PATH.test(path)) {
      const segments = path.split("/").filter((segment) => segment.length > 0);
      if (segments.length >= 2) {
        return segments.slice(-2).join("/");
      }
    }
  }

  const name = repository.name?.trim() || repository.dtag?.trim();
  return name && name.length > 0 ? name : null;
}

export function formatEmployeeCount(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${safe} ${safe === 1 ? "employee" : "employees"}`;
}

/**
 * The project channel header's subtitle: "owner/repo · branch · N employees".
 * Parts that cannot be resolved are dropped rather than rendered empty.
 */
export function projectHeaderMeta(
  project: Pick<Project, "primaryRepositoryAddress"> | null | undefined,
  repositories: readonly RepositoryMeta[] | null | undefined,
  employeeCount: number,
): string {
  const repository = primaryRepository(project, repositories);
  const parts = [
    repositorySlug(repository),
    repository ? repository.defaultBranch?.trim() || "main" : null,
    formatEmployeeCount(employeeCount),
  ].filter((part): part is string => Boolean(part));

  return parts.join(" · ");
}

/** The default branch shown as trailing meta on a sidebar project row. */
export function projectBranchLabel(
  project: Pick<Project, "primaryRepositoryAddress"> | null | undefined,
  repositories: readonly RepositoryMeta[] | null | undefined,
): string | null {
  const repository = primaryRepository(project, repositories);
  if (!repository) return null;
  return repository.defaultBranch?.trim() || "main";
}

/**
 * How many of a channel's members are agents — the "N employees" in the
 * header. `knownAgentPubkeys` is the community-wide agent baseline; a
 * member's own `isAgent` flag can only widen it.
 */
export function countChannelEmployees(
  members: readonly { pubkey: string; isAgent?: boolean }[] | null | undefined,
  knownAgentPubkeys: ReadonlySet<string> | null | undefined,
): number {
  if (!members) return 0;
  let count = 0;
  for (const member of members) {
    const pubkey = member.pubkey?.trim().toLowerCase() ?? "";
    if (member.isAgent === true || knownAgentPubkeys?.has(pubkey)) {
      count += 1;
    }
  }
  return count;
}
