import { MoreHorizontal, Trash2 } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

/**
 * The Inbox detail header's overflow menu. Split out of `InboxDetailPane.tsx`
 * so that file stays under the desktop file-size ratchet.
 */
export function InboxHeaderMoreMenu({
  isDeletingMessage,
  onDelete,
}: {
  isDeletingMessage: boolean;
  onDelete: () => void;
}) {
  const trigger = (
    <Button
      aria-label="More actions"
      className="rounded-full text-muted-foreground"
      size="icon"
      type="button"
      variant="ghost"
    >
      <MoreHorizontal />
    </Button>
  );

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={isDeletingMessage}
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
          Delete message
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
