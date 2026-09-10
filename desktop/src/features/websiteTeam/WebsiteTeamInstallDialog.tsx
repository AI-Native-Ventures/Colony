import { AlertTriangle, Check, Loader2 } from "lucide-react";
import * as React from "react";

import { IdentityInitialsAvatar } from "@/features/agents/ui/IdentityInitialsAvatar";
import { useChannelsQuery } from "@/features/channels/hooks";
import type { InstallWebsiteTeamResult } from "@/shared/api/tauriWebsiteTeam";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

import type { AgentStartOutcome } from "./installLogic";
import {
  assessInstall,
  describePublication,
  summarizeAgentStarts,
} from "./installLogic";
import {
  useWebsiteTeamInstallMutation,
  useWebsiteTeamInstallStatusQuery,
  useWebsiteTeamRecipeQuery,
  type WebsiteTeamInstallRun,
} from "./useWebsiteTeamInstall";

type WebsiteTeamInstallDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled?: (
    result: InstallWebsiteTeamResult,
    starts: AgentStartOutcome[],
  ) => void;
};

export function WebsiteTeamInstallDialog({
  open,
  onOpenChange,
  onInstalled,
}: WebsiteTeamInstallDialogProps) {
  const recipeQuery = useWebsiteTeamRecipeQuery();
  const recipe = recipeQuery.data ?? null;
  const channelsQuery = useChannelsQuery();
  const installMutation = useWebsiteTeamInstallMutation();
  const installStatusQuery = useWebsiteTeamInstallStatusQuery(open);

  const [channelId, setChannelId] = React.useState("");
  const [seedUrl, setSeedUrl] = React.useState("");
  const [starterPrompt, setStarterPrompt] = React.useState("");
  const [run, setRun] = React.useState<WebsiteTeamInstallRun | null>(null);
  const promptSeededRef = React.useRef(false);
  const resetInstall = installMutation.reset;

  const channels = React.useMemo(
    () =>
      (channelsQuery.data ?? []).filter(
        (channel) => channel.channelType !== "dm" && !channel.archivedAt,
      ),
    [channelsQuery.data],
  );

  React.useEffect(() => {
    if (!open) {
      promptSeededRef.current = false;
      setChannelId("");
      setSeedUrl("");
      setStarterPrompt("");
      setRun(null);
      resetInstall();
      return;
    }
    if (!channelId && channels.length > 0) {
      setChannelId(channels[0].id);
    }
  }, [open, channelId, channels, resetInstall]);

  React.useEffect(() => {
    if (!open || !recipe || promptSeededRef.current) {
      return;
    }
    promptSeededRef.current = true;
    setStarterPrompt((current) =>
      current.trim().length > 0 ? current : recipe.examplePrompt,
    );
  }, [open, recipe]);

  const assessment = run ? assessInstall(run.result) : null;
  const startSummary = run ? summarizeAgentStarts(run.starts) : null;
  const startByPersona = new Map(
    (run?.starts ?? []).map((outcome) => [outcome.personaId, outcome] as const),
  );
  const selectedChannel =
    channels.find((channel) => channel.id === channelId) ?? null;
  const canInstall =
    Boolean(selectedChannel) && Boolean(recipe) && !installMutation.isPending;

  async function handleInstall() {
    if (!selectedChannel || !recipe) {
      return;
    }
    try {
      const next = await installMutation.mutateAsync({
        channelId: selectedChannel.id,
        seedUrl,
        starterPrompt: starterPrompt.trim() || recipe.examplePrompt,
      });
      setRun(next);
      onInstalled?.(next.result, next.starts);
    } catch {
      // The mutation holds the error; keep the dialog open for a retry.
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-2xl overflow-hidden p-0">
        <div className="flex max-h-[85vh] flex-col">
          <DialogHeader className="shrink-0 border-b border-border/60 px-6 py-5 pr-14">
            <DialogTitle>Website Manager</DialogTitle>
            <DialogDescription>
              {recipe?.outcome ??
                "Installs a four-person website studio: research, direction, build, and independent review."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
            {recipe ? (
              <div className="space-y-2">
                <span className="text-sm font-medium">The team</span>
                <div className="flex flex-wrap gap-2">
                  {recipe.personas.map((persona) => (
                    <div
                      className="flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-1"
                      key={persona.personaId}
                    >
                      <IdentityInitialsAvatar
                        className="h-5 w-5 text-2xs"
                        colorIndex={persona.colorIndex}
                        label={persona.displayName}
                        size={20}
                      />
                      <span className="text-xs font-medium">
                        {persona.displayName}
                      </span>
                      <span className="text-2xs text-muted-foreground">
                        {persona.tier === "leader" ? "Lead" : "Worker"}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Avery delegates, reviews, and presents. Ren researches. Jules
                  designs, builds, and prepares the handover. Vera reviews
                  independently.
                </p>
              </div>
            ) : null}

            {installStatusQuery.data ? (
              <p className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                Already installed in this community on{" "}
                {new Date(
                  installStatusQuery.data.updated_at,
                ).toLocaleDateString()}
                . Installing again reconciles the same team, agents, and skills
                instead of creating duplicates.
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="website-team-url">
                Website URL (optional)
              </label>
              <Input
                disabled={installMutation.isPending}
                id="website-team-url"
                onChange={(event) => setSeedUrl(event.target.value)}
                placeholder="https://example.com"
                value={seedUrl}
              />
            </div>

            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="website-team-prompt"
              >
                What should they do?
              </label>
              <Textarea
                disabled={installMutation.isPending}
                id="website-team-prompt"
                onChange={(event) => setStarterPrompt(event.target.value)}
                placeholder={recipe?.examplePrompt ?? "Improve my website"}
                rows={2}
                value={starterPrompt}
              />
            </div>

            <div className="space-y-1.5">
              <label
                className="text-sm font-medium"
                htmlFor="website-team-channel"
              >
                Channel
              </label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs"
                disabled={channels.length === 0 || installMutation.isPending}
                id="website-team-channel"
                onChange={(event) => setChannelId(event.target.value)}
                value={channelId}
              >
                {channels.length === 0 ? (
                  <option value="">No channels available</option>
                ) : null}
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name} · {channel.visibility}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                The four agents join this channel and start there.
              </p>
            </div>

            {recipeQuery.error instanceof Error ? (
              <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {recipeQuery.error.message}
              </p>
            ) : null}

            {installMutation.error instanceof Error ? (
              <p className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {installMutation.error.message}
              </p>
            ) : null}

            {run && assessment ? (
              <div className="space-y-3 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3">
                <div className="flex items-start gap-2">
                  {assessment.state === "complete" ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{assessment.headline}</p>
                    {assessment.detail ? (
                      <p className="text-xs text-muted-foreground">
                        {assessment.detail}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      Team: {describePublication(run.result.publication.team)}
                    </p>
                  </div>
                </div>

                <ul className="space-y-1.5">
                  {assessment.personas.map((persona) => {
                    const start = startByPersona.get(persona.personaId);
                    const publication =
                      run.result.publication.personas.find(
                        (entry) => entry.id === persona.personaId,
                      )?.status ?? "missing";
                    return (
                      <li
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                        key={persona.personaId}
                      >
                        <span className="font-medium">
                          {persona.displayName}
                        </span>
                        <span className="text-muted-foreground">
                          {persona.roleTitle}
                        </span>
                        <span className="text-muted-foreground">
                          ·{" "}
                          {persona.status === "missing"
                            ? "agent missing"
                            : persona.status === "existing"
                              ? "existing agent"
                              : "agent created"}
                        </span>
                        <span className="text-muted-foreground">
                          · {describePublication(publication)}
                        </span>
                        {start ? (
                          <span
                            className={cn(
                              "text-muted-foreground",
                              start.error ? "text-warning" : undefined,
                            )}
                          >
                            ·{" "}
                            {start.started
                              ? "in channel, running"
                              : start.needsConfiguration
                                ? `in channel, needs configuration: ${start.error}`
                                : `in channel, not started: ${start.error}`}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>

                {run.result.skills.length > 0 ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium">Skills</p>
                    <ul className="space-y-0.5">
                      {run.result.skills.map((skill) => (
                        <li
                          className="text-xs text-muted-foreground"
                          key={skill.name}
                        >
                          {skill.name}:{" "}
                          {skill.status === "preserved"
                            ? "kept your edited copy"
                            : skill.status === "failed"
                              ? `failed (${skill.detail ?? "unknown error"})`
                              : skill.status}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {startSummary && startSummary.failed.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {startSummary.started} of {run.starts.length} teammates
                    running. Retry after fixing your agent defaults or Power
                    configuration; installation is already complete and will not
                    duplicate anyone.
                  </p>
                ) : null}

                {run.result.notes.length > 0 ? (
                  <ul className="space-y-0.5">
                    {run.result.notes.map((note) => (
                      <li className="text-xs text-muted-foreground" key={note}>
                        {note}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  {recipe?.integrationNote ??
                    "Starting a website job uses the Website Manager job surface."}
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 px-6 py-4">
            <Button
              onClick={() => onOpenChange(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              {run ? "Done" : "Cancel"}
            </Button>
            <Button
              disabled={!canInstall}
              onClick={() => void handleInstall()}
              size="sm"
              type="button"
            >
              {installMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Installing...
                </>
              ) : run ? (
                "Retry install and start"
              ) : (
                "Install team"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
