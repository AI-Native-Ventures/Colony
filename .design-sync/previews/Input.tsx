import { Button, Input } from "buzz";

export function Default() {
  return (
    <Input
      className="max-w-sm"
      defaultValue="engineering"
      placeholder="Channel name"
    />
  );
}

export function WithLabel() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5">
      <label
        className="text-xs font-medium text-foreground"
        htmlFor="preview-relay-url"
      >
        Relay URL
      </label>
      <Input
        defaultValue="wss://relay.colony.dev"
        id="preview-relay-url"
        placeholder="wss://relay.example.com"
      />
      <span className="text-xs text-muted-foreground">
        The community you join is derived from this host.
      </span>
    </div>
  );
}

export function WithIcon() {
  return (
    <div className="relative w-full max-w-sm">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" strokeLinecap="round" />
      </svg>
      <Input className="pl-9" placeholder="Search messages and threads" />
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5">
      <label
        className="text-xs font-medium text-muted-foreground"
        htmlFor="preview-pubkey"
      >
        Public key
      </label>
      <Input
        defaultValue="npub1q8s7z4rk09v3xw2m6ltd5hpc4ne0yjf"
        disabled
        id="preview-pubkey"
      />
      <span className="text-xs text-muted-foreground">
        Derived from your signing key and cannot be edited.
      </span>
    </div>
  );
}

export function InviteRow() {
  return (
    <div className="flex w-full max-w-md items-center gap-2">
      <Input placeholder="Email or npub to invite" />
      <Button size="sm">Send invite</Button>
    </div>
  );
}
