import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "buzz";

function Icon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * Rendered already open, the capture is static, so nothing clicks the
 * trigger. The trigger stays in the tree so the whole pattern reads.
 */
export function Default() {
  return (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          Message actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60" sideOffset={6}>
        <DropdownMenuLabel>Message</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <Icon d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2" />
            Reply in thread
            <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Icon d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
            Copy link
            <DropdownMenuShortcut>⌘L</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Icon d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
            Pin to #engineering
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Icon d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          Edit message
        </DropdownMenuItem>
        <DropdownMenuItem className="text-destructive focus:text-destructive">
          <Icon d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
          Delete message
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Selection state: checkbox and radio items in one channel-notifications menu. */
export function WithSelection() {
  return (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          Notifications
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" sideOffset={6}>
        <DropdownMenuLabel>Notify me about</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value="mentions">
          <DropdownMenuRadioItem value="all">
            All new messages
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="mentions">
            Mentions and replies
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="none">Nothing</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked>
          Include thread replies
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={false}>
          Play a sound
          <DropdownMenuShortcut>⌘M</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
