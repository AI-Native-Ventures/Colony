import { Skeleton, SkeletonReveal } from "buzz";

export function Default() {
  return (
    <div className="flex w-[420px] items-start gap-3">
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" pulsing={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
        <Skeleton className="h-3 w-32" pulsing={false} />
        <Skeleton className="h-3 w-full" pulsing={false} />
        <Skeleton className="h-3 w-3/5" pulsing={false} />
      </div>
    </div>
  );
}

export function MessageList() {
  return (
    <div className="flex w-[420px] flex-col gap-5">
      {[
        { body: "w-full", second: "w-2/3" },
        { body: "w-5/6", second: "w-1/3" },
        { body: "w-3/4", second: "w-1/2" },
      ].map((row) => (
        <div className="flex items-start gap-3" key={row.body}>
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" pulsing={false} />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <Skeleton className="h-3 w-24" pulsing={false} />
            <Skeleton className={`h-3 ${row.body}`} pulsing={false} />
            <Skeleton className={`h-3 ${row.second}`} pulsing={false} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChannelSidebar() {
  return (
    <div className="flex w-[260px] flex-col gap-3 rounded-lg border border-border p-3">
      <Skeleton className="h-3 w-20" pulsing={false} />
      {["w-32", "w-24", "w-40", "w-28", "w-36"].map((width) => (
        <div className="flex items-center gap-2" key={width}>
          <Skeleton className="h-4 w-4 shrink-0 rounded-sm" pulsing={false} />
          <Skeleton className={`h-3 ${width}`} pulsing={false} />
        </div>
      ))}
    </div>
  );
}

const memberSkeleton = (
  <div className="flex flex-col gap-3">
    {["w-40", "w-32", "w-36"].map((width) => (
      <div className="flex items-center gap-3" key={width}>
        <Skeleton className="h-8 w-8 shrink-0 rounded-full" pulsing={false} />
        <Skeleton className={`h-3 ${width}`} pulsing={false} />
      </div>
    ))}
  </div>
);

const memberContent = (
  <div className="flex flex-col gap-3">
    {[
      { initials: "TB", name: "Tyler Bennett", role: "Owner" },
      { initials: "AR", name: "Amara Ruiz", role: "Member" },
      { initials: "SP", name: "Sprig", role: "Agent" },
    ].map((member) => (
      <div className="flex items-center gap-3" key={member.name}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {member.initials}
        </div>
        <span className="text-sm text-foreground">{member.name}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {member.role}
        </span>
      </div>
    ))}
  </div>
);

export function Reveal() {
  return (
    <div className="flex w-[520px] items-start gap-6">
      <div className="flex w-[240px] flex-col gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          loading
        </span>
        <SkeletonReveal loading skeleton={memberSkeleton}>
          {memberContent}
        </SkeletonReveal>
      </div>
      <div className="flex w-[240px] flex-col gap-3">
        <span className="text-xs font-medium text-muted-foreground">
          loaded
        </span>
        <SkeletonReveal loading={false} skeleton={memberSkeleton}>
          {memberContent}
        </SkeletonReveal>
      </div>
    </div>
  );
}

export function Pulsing() {
  return (
    <div className="flex w-[420px] flex-col gap-3 rounded-lg border border-border p-4">
      <Skeleton className="h-4 w-44" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
    </div>
  );
}
