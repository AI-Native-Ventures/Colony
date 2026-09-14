import type * as React from "react";

import { AgentRoleSubtitle } from "@/features/agents/ui/AgentRoleSubtitle";
import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { MessageHeaderRow, MessageMetaSegments } from "./MessageHeader";

/**
 * The author line of a non-continuation message: name, then the
 * divider-separated metadata segments, then Colony's agent role subtitle on
 * its own wrapped line.
 */
export function MessageRowHeader({
  agentOwnerNode,
  authorNode,
  botIdenticonValue,
  inlineMetadataNode,
  personaNode,
  profilePopoverRole,
  pubkey,
}: {
  agentOwnerNode: React.ReactNode;
  authorNode: React.ReactNode;
  botIdenticonValue?: string;
  inlineMetadataNode: React.ReactNode;
  personaNode: React.ReactNode;
  profilePopoverRole?: string;
  pubkey?: string;
}) {
  return (
    // pe reserves the measured action-rail footprint (0px until measured) so
    // header content ends before the rail's left edge in every rail state.
    <MessageHeaderRow className="colony-message-header pe-[var(--message-action-rail-width,0px)]">
      {pubkey ? (
        <UserProfilePopover
          pubkey={pubkey}
          role={profilePopoverRole}
          botIdenticonValue={botIdenticonValue}
          // The trigger wrapper is a flex item whose `min-width: auto`
          // refuses to shrink below the nowrap width of its truncating
          // child, so a long author name overflowed the header row
          // (upstream #7550).
          triggerClassName="min-w-0 max-w-full"
        >
          <button
            className="truncate rounded leading-message-author focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          >
            {authorNode}
          </button>
        </UserProfilePopover>
      ) : (
        authorNode
      )}
      {/* Author is not a segment: "Alice 9:53 AM" needs no divider. */}
      <MessageMetaSegments
        segments={[
          { key: "owner", node: agentOwnerNode },
          { key: "timestamp", node: inlineMetadataNode },
          { key: "persona", node: personaNode },
        ]}
      />
      {/* Colony's agent role subtitle is `basis-full`: it owns the next line
          of the wrapping header, so it stays outside the divider run. */}
      {profilePopoverRole === "bot" && <AgentRoleSubtitle pubkey={pubkey} />}
    </MessageHeaderRow>
  );
}
