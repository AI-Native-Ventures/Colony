import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "buzz";

export function Default() {
  return (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="outline">Invite people</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite people to Colony</DialogTitle>
          <DialogDescription>
            Anyone with this link can request to join. An owner still has to
            approve them before they see any channels.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm text-foreground">
          https://colony.ainative.ventures/join/8f2a-41c7-b90d
        </div>
        <p className="text-sm text-muted-foreground">
          Expires in 7 days. Used 3 of 25 times.
        </p>
        <DialogFooter>
          <Button variant="outline">Revoke link</Button>
          <Button>Copy link</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
