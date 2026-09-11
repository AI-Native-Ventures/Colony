import { ChevronDown, FolderGit2 } from "lucide-react";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useProjectsQuery } from "@/features/projects/hooks";
import {
  primaryRepository,
  projectForChannel,
  repositorySlug,
} from "@/features/projects/lib/projectChannels";
import { linkableProjects } from "@/features/projects/lib/projectChannelLink";
import type { Project } from "@/features/projects/projectModels";
import { useLinkProjectChannelMutation } from "@/features/projects/useLinkProjectChannel";
import { useFeatureEnabled } from "@/shared/features";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { FieldGroup } from "./ChannelManagementSheetRows";

/** "owner/repo" for a project, or its description when it has no repository. */
export function projectRowSubtitle(project: Project): string {
  const slug = repositorySlug(primaryRepository(project, project.repositories));
  if (slug) return slug;
  const description = project.description.trim();
  return description || "No repository yet";
}

/**
 * The channel-settings **Project** row: shows the project this channel
 * belongs to and lets an owner or admin link or unlink one.
 *
 * Linking writes the `buzz-channel` tag on the project's announcement; the
 * channel itself is untouched and stays an ordinary stream channel.
 */
export function ChannelProjectRow({
  canManage,
  channelId,
  currentPubkey,
}: {
  canManage: boolean;
  channelId: string | null;
  currentPubkey?: string;
}) {
  const enabled = useFeatureEnabled("workspaceFactoryTab");
  const { goProjects } = useAppNavigation();
  const projects = useProjectsQuery({ enabled }).data;
  const linkMutation = useLinkProjectChannelMutation();
  const [selectedProjectId, setSelectedProjectId] = React.useState<
    string | null
  >(null);

  const linkedProject = projectForChannel(projects, channelId);
  const options = React.useMemo(
    () =>
      linkableProjects(projects, channelId, currentPubkey).filter(
        (project) => project.id !== linkedProject?.id,
      ),
    [channelId, currentPubkey, linkedProject?.id, projects],
  );
  const selectedProject =
    options.find((project) => project.id === selectedProjectId) ?? null;
  const isPending = linkMutation.isPending;
  const errorMessage =
    linkMutation.error instanceof Error ? linkMutation.error.message : null;

  if (!enabled || !channelId) {
    return null;
  }
  // A viewer who cannot manage the channel still sees the link, but only when
  // one exists — an empty picker would suggest an action they cannot take.
  if (!canManage && !linkedProject) {
    return null;
  }

  const link = (project: Project | null, nextChannelId: string | null) => {
    if (!project) return;
    linkMutation.mutate(
      { channelId: nextChannelId, project },
      { onSuccess: () => setSelectedProjectId(null) },
    );
  };

  return (
    <FieldGroup testId="channel-management-project" title="Project">
      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
        <FolderGit2
          className="h-4 w-4 shrink-0 text-muted-foreground"
          data-slot="field-row-icon"
        />
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-sm font-medium text-foreground">
            {linkedProject ? linkedProject.name : "No project"}
          </span>
          <span
            className="mt-0.5 block truncate text-sm font-normal text-muted-foreground/70"
            data-testid="channel-management-project-subtitle"
          >
            {linkedProject
              ? projectRowSubtitle(linkedProject)
              : options.length > 0
                ? "Link this channel to one of your projects"
                : "Create a project first, then link it here"}
          </span>
        </span>
        {linkedProject ? (
          canManage ? (
            <Button
              data-testid="channel-management-project-unlink"
              disabled={isPending}
              onClick={() => link(linkedProject, null)}
              size="sm"
              type="button"
              variant="outline"
            >
              {isPending ? "Unlinking..." : "Unlink"}
            </Button>
          ) : null
        ) : options.length > 0 ? (
          <>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Project: ${selectedProject?.name ?? "None"}`}
                  className="h-9 min-w-0 max-w-40 justify-end px-2.5 text-right text-sm font-medium"
                  data-testid="channel-management-project-select"
                  disabled={isPending}
                  type="button"
                  variant="ghost"
                >
                  <span className="truncate">
                    {selectedProject?.name ?? "Choose project"}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground/70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  onValueChange={setSelectedProjectId}
                  value={selectedProjectId ?? ""}
                >
                  {options.map((project) => (
                    <DropdownMenuRadioItem key={project.id} value={project.id}>
                      {project.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              data-testid="channel-management-project-link"
              disabled={isPending || !selectedProject}
              onClick={() => link(selectedProject, channelId)}
              size="sm"
              type="button"
            >
              {isPending ? "Linking..." : "Link"}
            </Button>
          </>
        ) : (
          <Button
            data-testid="channel-management-project-create"
            onClick={() => void goProjects()}
            size="sm"
            type="button"
            variant="outline"
          >
            Create a project
          </Button>
        )}
      </div>
      {errorMessage ? (
        <p
          className="px-4 pb-3 text-sm text-destructive"
          data-testid="channel-management-project-error"
        >
          {errorMessage}
        </p>
      ) : null}
    </FieldGroup>
  );
}
