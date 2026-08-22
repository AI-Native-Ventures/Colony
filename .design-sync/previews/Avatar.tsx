import { Avatar, AvatarFallback } from "buzz";

export function Default() {
  return (
    <div className="flex items-center gap-3">
      <Avatar>
        <AvatarFallback>TC</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Tyler Cowen</p>
        <p className="text-2xs text-muted-foreground">npub1q4f…8xk2</p>
      </div>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex items-end gap-4">
      <Avatar className="h-6 w-6">
        <AvatarFallback className="text-2xs">AL</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback className="text-xs">BR</AvatarFallback>
      </Avatar>
      <Avatar className="h-12 w-12">
        <AvatarFallback className="text-base">CM</AvatarFallback>
      </Avatar>
      <Avatar className="h-16 w-16">
        <AvatarFallback className="text-lg">DK</AvatarFallback>
      </Avatar>
    </div>
  );
}

export function AgentIdentity() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <Avatar className="h-10 w-10 rounded-lg">
          <AvatarFallback className="rounded-lg bg-primary/15 text-sm font-semibold text-primary">
            SC
          </AvatarFallback>
        </Avatar>
        <span className="absolute -bottom-0.5 -right-0.5 block h-3 w-3 rounded-full border-2 border-background bg-emerald-500" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">scout-agent</p>
        <p className="text-2xs text-muted-foreground">
          worker tier &middot; running in #engineering
        </p>
      </div>
    </div>
  );
}

export function Stack() {
  const members = ["JW", "MA", "PS", "RO"];

  return (
    <div className="flex items-center gap-3">
      <div className="flex -space-x-2">
        {members.map((initials) => (
          <Avatar
            className="h-8 w-8 ring-2 ring-background"
            key={initials}
          >
            <AvatarFallback className="text-2xs">{initials}</AvatarFallback>
          </Avatar>
        ))}
        <Avatar className="h-8 w-8 ring-2 ring-background">
          <AvatarFallback className="bg-muted text-2xs text-muted-foreground">
            +9
          </AvatarFallback>
        </Avatar>
      </div>
      <p className="text-sm text-muted-foreground">13 members in #general</p>
    </div>
  );
}

export function WithImage() {
  return (
    <div className="flex items-center gap-3">
      <Avatar>
        {/* Inline SVG data URI, remote avatar hosts are unreachable here. */}
        <img
          alt="Priya Shah"
          className="aspect-square h-full w-full"
          src="data:image/svg+xml;utf8,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2064%2064'%3E%3Crect%20width%3D'64'%20height%3D'64'%20fill%3D'%234c6ef5'%2F%3E%3Ccircle%20cx%3D'32'%20cy%3D'25'%20r%3D'11'%20fill%3D'%23dbe4ff'%2F%3E%3Cpath%20d%3D'M10%2064c0-13%2010-21%2022-21s22%208%2022%2021z'%20fill%3D'%23dbe4ff'%2F%3E%3C%2Fsvg%3E"
        />
        <AvatarFallback>PS</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Priya Shah</p>
        <p className="text-2xs text-muted-foreground">
          Verified avatar &middot; owner
        </p>
      </div>
    </div>
  );
}
