import * as React from "react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
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
 * Radix's ContextMenu root has no `defaultOpen`, it only opens from a real
 * right-click. The capture is static, so the row dispatches one `contextmenu`
 * event at its own coordinates on mount, which is exactly the interaction a
 * user performs. The trigger stays visible so the whole pattern reads.
 */
function useOpenOnMount() {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(rect.left + 28),
        clientY: Math.round(rect.bottom + 6),
      }),
    );
  }, []);

  return ref;
}

export function Default() {
  const triggerRef = useOpenOnMount();

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          className="flex w-56 cursor-default select-none items-center gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-sm text-foreground"
          ref={triggerRef}
        >
          <span className="text-muted-foreground">#</span>
          <span className="truncate font-medium">engineering</span>
          <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-2xs font-semibold text-primary-foreground">
            4
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        <ContextMenuLabel>#engineering</ContextMenuLabel>
        <ContextMenuItem>
          <Icon d="M4 6h16M4 12h16M4 18h10" />
          Mark as read
          <ContextMenuShortcut>⇧Esc</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          <Icon d="M12 17.3l-6.2 3.3 1.2-6.9-5-4.9 6.9-1L12 1.5l3.1 6.3 6.9 1-5 4.9 1.2 6.9z" />
          Star channel
        </ContextMenuItem>
        <ContextMenuCheckboxItem checked>Mute notifications</ContextMenuCheckboxItem>
        <ContextMenuSeparator />
        <ContextMenuItem>
          <Icon d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          Rename channel
        </ContextMenuItem>
        <ContextMenuItem className="text-destructive focus:text-destructive">
          <Icon d="M16 17l5-5-5-5M21 12H9M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
          Leave channel
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
