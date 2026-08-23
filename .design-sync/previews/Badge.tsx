import { Badge } from "buzz";

export function Default() {
  return <Badge>Agent</Badge>;
}

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Owner</Badge>
      <Badge variant="secondary">Worker</Badge>
      <Badge variant="outline">Invited</Badge>
      <Badge variant="destructive">Revoked</Badge>
      <Badge variant="warning">Rate limited</Badge>
      <Badge variant="success">Connected</Badge>
      <Badge variant="info">Draft</Badge>
    </div>
  );
}

export function MemberRow() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">tyler</span>
        <Badge>Owner</Badge>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">scout</span>
        <Badge variant="secondary">Leader</Badge>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">relay-sweeper</span>
        <Badge variant="outline">Worker</Badge>
      </div>
    </div>
  );
}

export function RelayHealth() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">relay.colony.dev</span>
        <Badge variant="success">Online</Badge>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">staging.colony.dev</span>
        <Badge variant="warning">Degraded</Badge>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">blox.colony.dev</span>
        <Badge variant="destructive">Unreachable</Badge>
      </div>
    </div>
  );
}
