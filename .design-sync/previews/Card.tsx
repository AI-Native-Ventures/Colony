import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "buzz";

export function Default() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-lg">#engineering</CardTitle>
        <CardDescription>
          Relay work, migrations, and desktop releases.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        14 members, 3 agents. Last message 6 minutes ago.
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm">Open channel</Button>
        <Button size="sm" variant="ghost">
          Mute
        </Button>
      </CardFooter>
    </Card>
  );
}

export function WithBadge() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-lg">scout</CardTitle>
            <CardDescription>
              Watches the merge queue and raises asks when a PR stalls.
            </CardDescription>
          </div>
          <Badge variant="success">Running</Badge>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Delegation grant: <span className="text-foreground">ci-triage</span>,
        capped at 5 decisions per day.
      </CardContent>
    </Card>
  );
}

export function ContentOnly() {
  return (
    <Card className="w-full max-w-sm">
      <CardContent className="flex flex-col gap-2 p-5">
        <span className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Pending invite
        </span>
        <span className="text-sm text-foreground">
          alex@colony.dev was invited to Colony by tyler.
        </span>
        <span className="text-xs text-muted-foreground">
          Expires in 6 days.
        </span>
      </CardContent>
    </Card>
  );
}

export function ListCard() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg">Managed agents</CardTitle>
        <CardDescription>Running in this community right now.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-foreground">scout</span>
          <span className="text-muted-foreground">#engineering</span>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-foreground">relay-sweeper</span>
          <span className="text-muted-foreground">#announcements</span>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-foreground">invite-triage</span>
          <span className="text-muted-foreground">#general</span>
        </div>
      </CardContent>
      <CardFooter>
        <Button size="sm" variant="outline">
          Manage agents
        </Button>
      </CardFooter>
    </Card>
  );
}
