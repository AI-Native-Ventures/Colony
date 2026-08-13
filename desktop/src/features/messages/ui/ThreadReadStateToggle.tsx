import { MailCheck, MailOpen } from "lucide-react";

import type { TimelineMessage } from "@/features/messages/types";
import { getThreadReadStateToggleLabel } from "@/features/messages/lib/threadReadState";
import { AuxiliaryPanelHeaderActions } from "@/shared/layout/AuxiliaryPanel";
import { Button } from "@/shared/ui/button";

export function ThreadReadStateToggle({
  isUnread,
  message,
  onMarkRead,
  onMarkUnread,
}: {
  isUnread: boolean;
  message: TimelineMessage;
  onMarkRead?: (message: TimelineMessage) => void;
  onMarkUnread?: (message: TimelineMessage) => void;
}) {
  if (!onMarkRead && !onMarkUnread) {
    return null;
  }

  const label = getThreadReadStateToggleLabel(isUnread);

  return (
    <AuxiliaryPanelHeaderActions>
      <Button
        aria-label={label}
        data-testid="thread-read-state-toggle"
        onClick={() => {
          if (isUnread) {
            onMarkRead?.(message);
          } else {
            onMarkUnread?.(message);
          }
        }}
        size="icon"
        title={label}
        type="button"
        variant="ghost"
      >
        {isUnread ? <MailCheck /> : <MailOpen />}
      </Button>
    </AuxiliaryPanelHeaderActions>
  );
}
