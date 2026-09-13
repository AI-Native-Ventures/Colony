import { AlertTriangle, Check, Loader2 } from "lucide-react";
import * as React from "react";

import { IdentityInitialsAvatar } from "@/features/agents/ui/IdentityInitialsAvatar";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useActiveCompany } from "@/features/company/hooks";
import { loadActiveCommunityId } from "@/features/communities/communityStorage";
import { useCommunities } from "@/features/communities/useCommunities";
import type { DraftActorMentionRef } from "@/features/messages/lib/useDrafts";
import { getRelayWsUrl } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
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
  buildWebsiteStarterDraft,
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
  onOpenChannel?: (
    request: WebsiteTeamOpenChannelRequest,
  ) => undefined | Promise<boolean>;
  onOpenCompanySettings?: () => void;
  onInstalled?: (
    result: InstallWebsiteTeamResult,
    starts: AgentStartOutcome[],
  ) => void;
};

export type WebsiteTeamOpenChannelRequest = {
  channelId: string;
  communityId: string;
  relayUrl: string;
  ownerPubkey: string;
  draftContent: string;
  mentionRefs: DraftActorMentionRef[];
};

export function WebsiteTeamInstallDialog({
  open,
  onOpenChange,
  onOpenChannel,
  onOpenCompanySettings,
  onInstalled,
}: WebsiteTeamInstallDialogProps) {
  const recipeQuery = useWebsiteTeamRecipeQuery();
  const recipe = recipeQuery.data ?? null;
  const channelsQuery = useChannelsQuery();
  const installMutation = useWebsiteTeamInstallMutation();
  const installStatusQuery = useWebsiteTeamInstallStatusQuery(open);
  const { activeCommunity } = useCommunities();
  const activeCommunityId = activeCommunity?.id ?? "";
  const hasStoredActiveCommunity =
    activeCommunityId !== "" && loadActiveCommunityId() === activeCommunityId;
  const companyQuery = useActiveCompany(
    activeCommunityId,
    open && hasStoredActiveCommunity,
  );

  const [channelId, setChannelId] = React.useState("");
  const [seedUrl, setSeedUrl] = React.useState("");
  const [starterPrompt, setStarterPrompt] = React.useState("");
  const [run, setRun] = React.useState<WebsiteTeamInstallRun | null>(null);
  const [installedCommunityId, setInstalledCommunityId] = React.useState<
    string | null
  >(null);
  const [openChannelError, setOpenChannelError] = React.useState<string | null>(
    null,
  );
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
      setInstalledCommunityId(null);
      setOpenChannelError(null);
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
  const readyCount = startSummary?.ready ?? 0;
  const joinedCount = startSummary?.joined ?? 0;
  const newlyAddedCount = startSummary?.newlyAdded ?? 0;
  const expectedPersonaCount = run?.result.personas.length ?? 4;
  const teamReady = Boolean(
    run &&
      assessment?.state === "complete" &&
      expectedPersonaCount === 4 &&
      run.starts.length === 4 &&
      joinedCount === 4 &&
      readyCount === 4,
  );
  const startByPersona = new Map(
    (run?.starts ?? []).map((outcome) => [outcome.personaId, outcome] as const),
  );
  const selectedChannel =
    channels.find((channel) => channel.id === channelId) ?? null;
  const canInstall =
    Boolean(selectedChannel) && Boolean(recipe) && !installMutation.isPending;
  const companyAvailable = companyQuery.data?.ok === true;

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
      setInstalledCommunityId(loadActiveCommunityId());
      setOpenChannelError(null);
      onInstalled?.(next.result, next.starts);
    } catch {
      // The mutation holds the error; keep the dialog open for a retry.
    }
  }

  async function handleOpenChannel() {
    if (!run || !onOpenChannel) return;
    const targetChannelId = run.result.channelId ?? channelId;
    const expectedCommunityId = installedCommunityId;
    if (!teamReady) {
      setOpenChannelError(
        "Finish team setup before opening the Website Manager channel.",
      );
      return;
    }
    if (
      !targetChannelId ||
      !expectedCommunityId ||
      loadActiveCommunityId() !== expectedCommunityId
    ) {
      setOpenChannelError(
        "The community changed while setup was open. Switch back and try again.",
      );
      return;
    }

    const avery = run.result.personas.find(
      (persona) =>
        persona.displayName.trim().toLowerCase() === "avery" ||
        persona.roleId.trim().toLowerCase() === "website-manager",
    );
    if (!avery?.agentPubkey.trim()) {
      setOpenChannelError(
        "Avery is not available in this community yet. Retry team setup first.",
      );
      return;
    }

    try {
      const [identity, relayUrl] = await Promise.all([
        getIdentity(),
        getRelayWsUrl(),
      ]);
      if (
        loadActiveCommunityId() !== expectedCommunityId ||
        identity.pubkey.trim().toLowerCase() !==
          run.result.ownerPubkey.trim().toLowerCase() ||
        relayUrl.trim().replace(/\/+$/, "").toLowerCase() !==
          run.result.relayUrl.trim().replace(/\/+$/, "").toLowerCase()
      ) {
        setOpenChannelError(
          "The account or community changed while setup was open. Switch back and try again.",
        );
        return;
      }

      const accepted = await onOpenChannel({
        channelId: targetChannelId,
        communityId: expectedCommunityId,
        relayUrl: run.result.relayUrl,
        ownerPubkey: run.result.ownerPubkey,
        draftContent: buildWebsiteStarterDraft(
          run.result.starterPrompt ?? starterPrompt,
          run.result.seedUrl ?? seedUrl,
        ),
        mentionRefs: [
          {
            displayName: avery.displayName,
            pubkey: avery.agentPubkey,
            isAgent: true,
          },
        ],
      });
      if (accepted === false) {
        setOpenChannelError(
          "The account or community changed while opening the channel. Switch back and try again.",
        );
        return;
      }
      setOpenChannelError(null);
    } catch (error) {
      setOpenChannelError(
        error instanceof Error
          ? error.message
          : "Could not open the Website Manager channel. Try again.",
      );
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-2xl overflow-hidden p-0"
        data-testid="website-team-install-dialog"
      >
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
                {installStatusQuery.data.upgraded_to ? (
                  <>
                    Provided content updated to{" "}
                    {installStatusQuery.data.upgraded_to} in this community on{" "}
                    {new Date(
                      installStatusQuery.data.updated_at,
                    ).toLocaleDateString()}
                    . Installing again checks for a newer version.
                  </>
                ) : (
                  <>
                    Already installed in this community on{" "}
                    {new Date(
                      installStatusQuery.data.updated_at,
                    ).toLocaleDateString()}
                    . Installing again checks the same team and people instead
                    of creating duplicates.
                  </>
                )}
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
                The team will work in this channel.
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
                  {teamReady ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">
                      {assessment.state !== "complete"
                        ? assessment.headline
                        : teamReady
                          ? assessment.headline
                          : "Team installed; finish setup"}
                    </p>
                    {assessment.detail ? (
                      <p className="text-xs text-muted-foreground">
                        {assessment.detail}
                      </p>
                    ) : null}
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="website-team-channel-status"
                    >
                      {run.starts.length === 0
                        ? "Channel setup has not produced a teammate result yet."
                        : `${joinedCount} of ${expectedPersonaCount} teammates joined; ${readyCount} are ready; ${newlyAddedCount} joined on this attempt.`}
                    </p>
                  </div>
                </div>

                <details data-testid="website-team-install-details">
                  <summary className="cursor-pointer text-xs font-medium">
                    View setup details
                  </summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Team publication:{" "}
                      {describePublication(run.result.publication.team)}
                    </p>
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
                                {start.ready
                                  ? `${start.newlyAdded ? "joined now" : "already joined"}, runtime ready`
                                  : start.joined
                                    ? `${start.newlyAdded ? "joined now" : "already joined"}, runtime not ready${start.error ? `: ${start.error}` : ""}`
                                    : start.needsConfiguration
                                      ? `not joined, needs configuration: ${start.error}`
                                      : `channel membership not confirmed${start.error ? `: ${start.error}` : ""}`}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>

                    {startSummary && startSummary.failed.length > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {startSummary.ready} of {expectedPersonaCount} teammates
                        are ready. Retry after fixing the item named above;
                        installation is already complete and will not duplicate
                        anyone.
                      </p>
                    ) : null}

                    {run.result.notes.length > 0 ? (
                      <ul className="space-y-0.5">
                        {run.result.notes.map((note) => (
                          <li
                            className="text-xs text-muted-foreground"
                            key={note}
                          >
                            {note}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </details>

                {!companyAvailable ? (
                  <div className="space-y-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-3">
                    <p className="text-xs text-muted-foreground">
                      {companyQuery.isPending
                        ? "Checking your business setup..."
                        : "Finish your business setup before starting a tracked website job."}
                    </p>
                    {onOpenCompanySettings && !companyQuery.isPending ? (
                      <Button
                        onClick={onOpenCompanySettings}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Set up business
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {onOpenChannel && (run.result.channelId ?? channelId) ? (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-background px-3 py-3"
                    data-testid="website-team-next-step"
                  >
                    <p className="max-w-xl text-xs text-muted-foreground">
                      {companyAvailable
                        ? "Open the channel to ask Avery to improve your website. Your brief and URL are ready in the composer."
                        : "Open the channel to review your draft, then finish business setup before sending it to Avery."}
                    </p>
                    <Button
                      data-testid="website-team-open-channel"
                      disabled={!teamReady}
                      onClick={() => void handleOpenChannel()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Open channel
                    </Button>
                  </div>
                ) : null}
                {openChannelError ? (
                  <p
                    className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                    role="alert"
                  >
                    {openChannelError}
                  </p>
                ) : null}
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
              data-testid="website-team-install-submit"
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
