import { Button, Spinner } from "buzz";

export function Default() {
  return <Spinner aria-label="Connecting to relay" />;
}

export function Sizes() {
  return (
    <div className="flex items-end gap-6">
      <Spinner aria-hidden="true" className="h-4 w-4 border-2" />
      <Spinner aria-hidden="true" />
      <Spinner aria-hidden="true" className="h-8 w-8" />
      <Spinner aria-hidden="true" size={40} />
    </div>
  );
}

export function InlineWithLabel() {
  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      <Spinner aria-hidden="true" className="h-4 w-4 border-2" />
      <span className="text-sm">Reconnecting to relay.colony.ventures…</span>
    </div>
  );
}

export function InButton() {
  return (
    <div className="flex items-center gap-3">
      <Button disabled>
        <Spinner
          aria-hidden="true"
          className="mr-2 h-4 w-4 border-2 text-current"
        />
        Creating channel
      </Button>
      <Button disabled variant="outline">
        <Spinner
          aria-hidden="true"
          className="mr-2 h-4 w-4 border-2 text-current"
        />
        Minting invite
      </Button>
    </div>
  );
}

export function LoadingPane() {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-background px-6 py-10">
      <Spinner className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">Loading #engineering</p>
      <p className="text-2xs text-muted-foreground">
        Fetching the last 200 messages from the relay
      </p>
    </div>
  );
}
