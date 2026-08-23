import { Button, Popover, PopoverContent, PopoverTrigger } from "buzz";

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Option({ label, selected }: { label: string; selected?: boolean }) {
  return (
    <div
      className={
        selected
          ? "flex items-center justify-between rounded-md bg-accent px-2 py-1.5 text-sm text-accent-foreground"
          : "flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-foreground"
      }
    >
      <span>{label}</span>
      {selected ? <CheckIcon /> : null}
    </div>
  );
}

export function Default() {
  return (
    <div className="flex h-80 justify-center pt-2">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline">Notifications</Button>
        </PopoverTrigger>
        <PopoverContent align="center" side="bottom">
          <div className="grid gap-3">
            <div className="grid gap-1">
              <p className="text-sm font-semibold text-foreground">
                Notify me in #engineering
              </p>
              <p className="text-2xs text-muted-foreground">
                Applies to this channel only.
              </p>
            </div>
            <div className="grid">
              <Option label="Every message" selected />
              <Option label="Mentions and replies" />
              <Option label="Nothing" />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
