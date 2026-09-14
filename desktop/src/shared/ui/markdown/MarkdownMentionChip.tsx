import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { cn } from "@/shared/lib/cn";
import { InlineChip } from "@/shared/ui/InlineChip";

/**
 * The timeline's mention chip.
 *
 * Split out of `markdown.tsx` for the desktop size ratchet. The chip drops the
 * `@` for display, so the identity it resolved is also published as inert
 * `data-*` attributes: the copy handler reads them to restore the sigil and to
 * carry the exact pubkey into the clipboard's HTML flavor (#7228). They change
 * neither the visuals nor the screen-reader output.
 */
export function MarkdownMentionChip({
  interactive,
  isAgentMention,
  mentionLabel,
  pubkey,
}: {
  interactive: boolean;
  isAgentMention: boolean;
  mentionLabel: string;
  pubkey: string | undefined;
}) {
  // Only chips that actually open a profile get the clickable affordance. A
  // mention whose pubkey did not resolve stays a plain chip — a pointer cursor
  // there promises a click that does nothing.
  const opensProfile = interactive && pubkey !== undefined;
  const mentionNode = (
    <InlineChip
      data-mention=""
      data-mention-kind={
        pubkey === undefined ? undefined : isAgentMention ? "agent" : "human"
      }
      data-mention-label={mentionLabel}
      data-mention-pubkey={pubkey}
      className={cn(isAgentMention && "agent-mention-highlight")}
      icon={isAgentMention ? "agent" : "human"}
      interactive={opensProfile}
    >
      {mentionLabel}
    </InlineChip>
  );

  return opensProfile ? (
    <UserProfilePopover
      botIdenticonValue={mentionLabel}
      pubkey={pubkey}
      role={isAgentMention ? "bot" : undefined}
      triggerElement="span"
    >
      {mentionNode}
    </UserProfilePopover>
  ) : (
    mentionNode
  );
}
