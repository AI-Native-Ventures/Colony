import { Separator } from "buzz";

export function Default() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <span className="text-sm text-foreground">Channel settings</span>
      <Separator />
      <span className="text-sm text-muted-foreground">
        Notifications, members, and invites.
      </span>
    </div>
  );
}

export function Vertical() {
  return (
    <div className="flex h-6 items-center gap-3 text-xs text-muted-foreground">
      <span>14 members</span>
      <Separator className="h-4" orientation="vertical" />
      <span>3 agents</span>
      <Separator className="h-4" orientation="vertical" />
      <span>Public</span>
    </div>
  );
}

export function InMenu() {
  return (
    <div className="flex w-full max-w-[14rem] flex-col rounded-lg border border-border/70 bg-card/80 py-1 text-sm">
      <span className="px-3 py-1.5 text-foreground">Mark as read</span>
      <span className="px-3 py-1.5 text-foreground">Mute channel</span>
      <Separator className="my-1" />
      <span className="px-3 py-1.5 text-foreground">Copy channel link</span>
      <Separator className="my-1" />
      <span className="px-3 py-1.5 text-destructive">Leave channel</span>
    </div>
  );
}

export function Subtle() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <span className="text-sm text-foreground">Yesterday</span>
      <Separator className="bg-border/60" />
      <span className="text-sm text-muted-foreground">
        scout opened PR #320 and armed auto-merge.
      </span>
    </div>
  );
}
