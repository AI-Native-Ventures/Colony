/**
 * Naming and request-shaping for the per-agent git worktrees the Software
 * Factory creates. Pure functions: the native call itself lives behind
 * `nativeFactory().createWorktree`.
 */
import type { Project } from "@/features/projects/projectModels";
import type { NativeFactoryWorktreeRequest } from "@/shared/api/nativeBridge";

/** Longest branch name we generate, including the `feat/` prefix. */
const MAX_BRANCH_LENGTH = 40;

/** Lowercase ascii words, hyphen-joined; everything else is dropped. */
function kebabSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The branch one agent works a brief on: `feat/<kebab brief>`, capped at 40
 * characters and never left with a trailing dash. A brief with no usable words
 * falls back to the agent's own name, so two agents on the same wordless brief
 * still get different branches.
 */
export function worktreeBranchFor(brief: string, agentName: string): string {
  const fromBrief = kebabSlug(brief);
  const slug = fromBrief || kebabSlug(agentName) || "agent";
  const trimmed = slug
    .slice(0, Math.max(1, MAX_BRANCH_LENGTH - "feat/".length))
    .replace(/-+$/g, "");
  return `feat/${trimmed || "agent"}`;
}

/**
 * The native request for a project's worktree, or `null` when the project has
 * no repository to branch from — the caller must not create a worktree then.
 */
export function buildWorktreeRequest({
  project,
  reposDir,
  branch,
}: {
  project: Project | null | undefined;
  reposDir: string | null;
  branch: string;
}): NativeFactoryWorktreeRequest | null {
  if (!project) return null;
  const primaryRepository =
    project.repositories.find(
      (candidate) => candidate.repoAddress === project.primaryRepositoryAddress,
    ) ?? project.repositories[0];
  if (!primaryRepository) return null;
  return {
    reposDir,
    projectDtag: project.dtag,
    cloneUrl: primaryRepository.cloneUrls[0] ?? null,
    branch,
    from: primaryRepository.defaultBranch || null,
  };
}
