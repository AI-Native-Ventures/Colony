import { FolderGit2, LayoutGrid, LogIn, SquareTerminal } from "lucide-react";
import type * as React from "react";

import { ChatHeader } from "@/features/chat/ui/ChatHeader";
import type { EphemeralChannelDisplay } from "@/features/channels/lib/ephemeralChannel";
import type { ActiveDmHeaderParticipant } from "@/features/channels/useActiveChannelHeader";
import { getChannelDescription } from "@/features/channels/lib/channelDescription";
import { getDmParticipantPreview } from "@/features/channels/lib/dmParticipantDisplay";
import { ChannelHeaderStatusBadge } from "@/features/channels/ui/ChannelHeaderStatusBadge";
import { ChannelMembersBar } from "@/features/channels/ui/ChannelMembersBar";
import { useChannelMembersQuery } from "@/features/channels/hooks";
import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { useProjectChannels } from "@/features/projects/useProjectChannels";
import {
  countChannelEmployees,
  projectHeaderMeta,
} from "@/features/projects/lib/projectChannels";
import { Badge } from "@/shared/ui/badge";
import { useAgentRank } from "@/features/agents/employeeHeads";
import { useAgentReportingLine } from "@/features/agents/reportingLine";
import { AgentRankBadge } from "@/features/agents/ui/AgentRankBadge";
import { ReportingLineText } from "@/features/agents/ui/ReportingLineText";
import { useCommunities } from "@/features/communities/useCommunities";
import {
  DEFAULT_HOVER_PROFILE_STATUS_GEOMETRY,
  ProfileAvatarWithStatus,
  scaleProfileAvatarStatusGeometry,
} from "@/features/profile/ui/ProfileAvatarWithStatus";
import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { useProfilePanel } from "@/shared/context/ProfilePanelContext";
import { Button } from "@/shared/ui/button";
import type { Channel, PresenceStatus } from "@/shared/api/types";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { cn } from "@/shared/lib/cn";
import {
  setChannelSurfaceMode,
  useChannelSurfaceMode,
} from "@/features/workspace/lib/channelSurfaceMode";
import {
  toggleTerminalPanel,
  useTerminalPanel,
} from "@/features/terminal/terminalPanelStore";

const DM_HEADER_AVATAR_SIZE = 32;
const DM_HEADER_AVATAR_STATUS_GEOMETRY = scaleProfileAvatarStatusGeometry(
  DEFAULT_HOVER_PROFILE_STATUS_GEOMETRY,
  DM_HEADER_AVATAR_SIZE,
);

type ChannelScreenHeaderProps = {
  activeChannel: Channel | null;
  channelId?: string;
  activeChannelEphemeralDisplay: EphemeralChannelDisplay | null;
  activeChannelTitle: string;
  actionsVariant?: "inline" | "compact";
  activeDmAvatarUrl: string | null;
  activeDmHeaderParticipants: ActiveDmHeaderParticipant[];
  activeDmPresenceStatus: PresenceStatus | null;
  chromeWrapperRef?: React.Ref<HTMLDivElement>;
  currentPubkey?: string;
  isAddBotOpen?: boolean;
  isJoining?: boolean;
  showHeaderContent?: boolean;
  transparentChrome?: boolean;
  onAddBotOpenChange?: (open: boolean) => void;
  onJoinChannel?: () => Promise<void>;
  onManageChannel: () => void;
  onToggleMembers: () => void;
};

export function ChannelScreenHeader({
  activeChannel,
  channelId,
  activeChannelEphemeralDisplay,
  activeChannelTitle,
  actionsVariant = "inline",
  activeDmAvatarUrl,
  activeDmHeaderParticipants,
  activeDmPresenceStatus,
  chromeWrapperRef,
  currentPubkey,
  isAddBotOpen,
  isJoining = false,
  onAddBotOpenChange,
  showHeaderContent = true,
  transparentChrome = false,
  onJoinChannel,
  onManageChannel,
  onToggleMembers,
}: ChannelScreenHeaderProps) {
  const surfaceMode = useChannelSurfaceMode(channelId);
  // A channel a project owns reads as a repository: repo icon, "project"
  // badge, and "owner/repo · branch · N employees" in place of the topic.
  const { projectByChannelId } = useProjectChannels();
  const project = activeChannel
    ? (projectByChannelId.get(activeChannel.id) ?? null)
    : null;
  const knownAgentPubkeys = useKnownAgentPubkeys();
  const projectMembers = useChannelMembersQuery(
    project && activeChannel ? activeChannel.id : null,
  ).data;
  const projectMeta = project
    ? projectHeaderMeta(
        project,
        project.repositories,
        countChannelEmployees(projectMembers, knownAgentPubkeys),
      )
    : null;
  const isGroupDm =
    activeChannel?.channelType === "dm" &&
    activeDmHeaderParticipants.length > 1;
  const activeDmParticipant = activeDmHeaderParticipants[0] ?? null;
  // A DM with a company-hired agent shows its rank next to the name. A human
  // or personal-agent DM resolves to no rank and renders nothing extra.
  const { activeCommunity } = useCommunities();
  const isDirectAgentDm = activeChannel?.channelType === "dm" && !isGroupDm;
  const dmParticipantRank = useAgentRank(
    activeCommunity?.id ?? "",
    isDirectAgentDm ? (activeDmParticipant?.pubkey ?? null) : null,
  );
  // The reporting line reads the same records the relay enforces: the
  // employee head first, then only owner-authored managed-agent heads.
  const dmParticipantReportingLine = useAgentReportingLine(
    activeCommunity?.id ?? "",
    isDirectAgentDm && dmParticipantRank
      ? (activeDmParticipant?.pubkey ?? null)
      : null,
  );
  const { openProfilePanel } = useProfilePanel();
  const showJoinButton =
    activeChannel !== null &&
    !activeChannel.isMember &&
    activeChannel.visibility === "open" &&
    !activeChannel.archivedAt &&
    onJoinChannel;

  const terminalPanel = useTerminalPanel();
  const workspaceToggle = channelId ? (
    <button
      aria-label={
        surfaceMode === "workspace" ? "Close workspace" : "Open workspace"
      }
      aria-pressed={surfaceMode === "workspace"}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground hover:bg-muted",
        surfaceMode === "workspace" && "bg-muted text-foreground",
      )}
      data-testid="channel-workspace-toggle"
      onClick={() =>
        setChannelSurfaceMode(
          channelId,
          surfaceMode === "workspace" ? "timeline" : "workspace",
        )
      }
      type="button"
    >
      <LayoutGrid aria-hidden className="size-4" />
    </button>
  ) : null;
  const terminalButton = activeChannel ? (
    <Button
      aria-label={
        terminalPanel.mode === "closed"
          ? "Open Colony Term"
          : "Hide Colony Term"
      }
      onClick={toggleTerminalPanel}
      size="icon"
      title="Colony Term (⌘J)"
      type="button"
      variant={terminalPanel.mode === "closed" ? "outline" : "secondary"}
    >
      <SquareTerminal />
    </Button>
  ) : null;
  const channelActions = activeChannel ? (
    showJoinButton ? (
      <Button
        disabled={isJoining}
        onClick={() => void onJoinChannel()}
        size="sm"
        variant="default"
      >
        <LogIn className="mr-1.5 h-4 w-4" />
        {isJoining ? "Joining…" : "Join"}
      </Button>
    ) : (
      <ChannelMembersBar
        channel={activeChannel}
        currentPubkey={currentPubkey}
        isAddBotOpen={isAddBotOpen}
        onAddBotOpenChange={onAddBotOpenChange}
        onManageChannel={onManageChannel}
        onToggleMembers={onToggleMembers}
        variant={actionsVariant}
      />
    )
  ) : null;
  const actions = activeChannel ? (
    <div className="flex items-center gap-1">
      {workspaceToggle}
      {terminalButton}
      {channelActions}
    </div>
  ) : null;

  if (!showHeaderContent) {
    return null;
  }

  return (
    <ChatHeader
      belowSystemChrome
      chromeWrapperRef={chromeWrapperRef}
      actions={actions}
      channelType={activeChannel?.channelType}
      description={projectMeta ?? getChannelDescription(activeChannel)}
      showDescription={Boolean(projectMeta)}
      leadingContent={
        projectMeta ? (
          <FolderGit2
            aria-hidden
            className="mr-0.5 h-4 w-4 text-muted-foreground"
            data-testid="chat-header-project-icon"
          />
        ) : activeChannel?.channelType === "dm" ? (
          isGroupDm ? (
            <DmHeaderParticipantStack
              participants={activeDmHeaderParticipants}
            />
          ) : activeDmParticipant ? (
            <UserProfilePopover
              pubkey={activeDmParticipant.pubkey}
              triggerAriaLabel={`Open profile for ${activeChannelTitle}`}
              triggerElement="span"
            >
              <ProfileAvatarWithStatus
                avatarClassName="text-xs"
                avatarUrl={activeDmAvatarUrl}
                className="mr-1.5 h-8 w-8"
                geometry={DM_HEADER_AVATAR_STATUS_GEOMETRY}
                iconClassName="h-4 w-4"
                label={activeChannelTitle}
                size={DM_HEADER_AVATAR_SIZE}
                status={activeDmPresenceStatus ?? "offline"}
                statusTestId="chat-presence-badge"
                testId="chat-header-dm-avatar"
              />
            </UserProfilePopover>
          ) : (
            <ProfileAvatarWithStatus
              avatarClassName="text-xs"
              avatarUrl={activeDmAvatarUrl}
              className="mr-1.5 h-8 w-8"
              geometry={DM_HEADER_AVATAR_STATUS_GEOMETRY}
              iconClassName="h-4 w-4"
              label={activeChannelTitle}
              size={DM_HEADER_AVATAR_SIZE}
              status={activeDmPresenceStatus ?? "offline"}
              statusTestId="chat-presence-badge"
              testId="chat-header-dm-avatar"
            />
          )
        ) : undefined
      }
      statusBadge={
        <>
          {dmParticipantRank ? (
            <>
              <AgentRankBadge rank={dmParticipantRank} />
              <ReportingLineText
                className="max-w-40"
                line={dmParticipantReportingLine}
                onOpenManager={
                  openProfilePanel
                    ? (managerPubkey) => openProfilePanel(managerPubkey)
                    : null
                }
                testId="chat-header-dm-reporting-line"
              />
            </>
          ) : null}
          {project ? (
            <Badge data-testid="chat-header-project-badge" variant="outline">
              project
            </Badge>
          ) : null}
          <ChannelHeaderStatusBadge
            ephemeralDisplay={activeChannelEphemeralDisplay}
          />
        </>
      }
      title={activeChannelTitle}
      transparentChrome={transparentChrome}
      visibility={activeChannel?.visibility}
    />
  );
}

function DmHeaderParticipantStack({
  participants,
}: {
  participants: ActiveDmHeaderParticipant[];
}) {
  const { hiddenCount, visibleParticipants } =
    getDmParticipantPreview(participants);
  const stackItemCount = visibleParticipants.length + (hiddenCount > 0 ? 1 : 0);

  return (
    <div
      className="mr-1.5 flex shrink-0 items-center"
      data-testid="chat-header-dm-avatar-stack"
    >
      {visibleParticipants.map((participant, index) => (
        <UserProfilePopover
          key={participant.pubkey}
          pubkey={participant.pubkey}
          triggerAriaLabel={`Open profile for ${participant.displayName}`}
          triggerElement="span"
        >
          <span
            className={index > 0 ? "-ml-2" : ""}
            data-testid="chat-header-dm-avatar-stack-participant"
            style={{
              zIndex: index + 1,
              ...(index < stackItemCount - 1 && {
                mask: "radial-gradient(circle 18px at calc(100% + 4px) 50%, transparent 99%, #fff 100%)",
                WebkitMask:
                  "radial-gradient(circle 18px at calc(100% + 4px) 50%, transparent 99%, #fff 100%)",
              }),
            }}
          >
            <UserAvatar
              avatarUrl={participant.avatarUrl}
              className="h-8 w-8 text-xs"
              displayName={participant.displayName}
              size="sm"
            />
          </span>
        </UserProfilePopover>
      ))}
      {hiddenCount > 0 ? (
        <div
          className={visibleParticipants.length > 0 ? "-ml-2" : ""}
          data-testid="chat-header-dm-avatar-stack-more"
          style={{ zIndex: stackItemCount }}
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground shadow-xs">
            <span className="text-2xs leading-none">+{hiddenCount}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
