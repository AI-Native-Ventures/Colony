import { Progress } from "buzz";

export function Default() {
  return (
    <div className="flex w-[420px] flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">design-review.mp4</span>
        <span className="text-muted-foreground">64%</span>
      </div>
      <Progress value={64} />
    </div>
  );
}

export function Steps() {
  return (
    <div className="flex w-[420px] flex-col gap-4">
      {[
        { label: "Queued", value: 0 },
        { label: "Hashing blob", value: 25 },
        { label: "Uploading to relay", value: 72 },
        { label: "Published", value: 100 },
      ].map((row) => (
        <div className="flex flex-col gap-1.5" key={row.label}>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{row.label}</span>
            <span>{row.value}%</span>
          </div>
          <Progress value={row.value} />
        </div>
      ))}
    </div>
  );
}

export function Indeterminate() {
  return (
    <div className="flex w-[420px] flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground">Transcoding video</span>
        <span className="text-muted-foreground">No byte count yet</span>
      </div>
      <Progress value={null} />
    </div>
  );
}

export function InAttachmentRow() {
  return (
    <div className="flex w-[420px] items-center gap-3 rounded-lg border border-border p-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground">
        PNG
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm text-foreground">
            relay-latency-chart.png
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            1.2 MB of 2.8 MB
          </span>
        </div>
        <Progress className="h-1.5" value={43} />
      </div>
    </div>
  );
}
