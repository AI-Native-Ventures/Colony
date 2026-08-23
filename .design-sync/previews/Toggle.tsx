import { Toggle } from "buzz";

function BellIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.7 21a2 2 0 0 1-3.4 0"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        d="M12 17v5M9 10.76V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v5.76l2 3.24H7z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Default() {
  return (
    <Toggle aria-label="Mute channel" defaultPressed>
      <BellIcon />
      Muted
    </Toggle>
  );
}

export function Variants() {
  return (
    <div className="flex flex-col gap-3 w-[420px]">
      {(["default", "ghost", "outline"] as const).map((variant) => (
        <div className="flex items-center gap-3" key={variant}>
          <span className="w-16 text-xs text-muted-foreground">{variant}</span>
          <Toggle defaultPressed variant={variant}>
            <PinIcon />
            Pinned
          </Toggle>
          <Toggle variant={variant}>
            <PinIcon />
            Pin
          </Toggle>
        </div>
      ))}
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex items-center gap-3">
      {(["xs", "sm", "default", "lg"] as const).map((size) => (
        <Toggle defaultPressed key={size} size={size} variant="outline">
          <CheckIcon />
          {size}
        </Toggle>
      ))}
    </div>
  );
}

export function IconGroup() {
  return (
    <div className="flex w-[420px] items-center gap-1 rounded-lg border border-border p-1">
      <Toggle aria-label="Show prompt context" defaultPressed size="sm">
        <CheckIcon />
      </Toggle>
      <Toggle aria-label="Pin thread" size="sm">
        <PinIcon />
      </Toggle>
      <Toggle aria-label="Mute thread" size="sm" variant="ghost">
        <BellIcon />
      </Toggle>
      <span className="ml-auto pr-2 text-xs text-muted-foreground">
        Thread controls
      </span>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex items-center gap-3">
      <Toggle disabled pressed variant="outline">
        <BellIcon />
        Muted by owner
      </Toggle>
      <Toggle disabled pressed={false} variant="outline">
        <PinIcon />
        Pin
      </Toggle>
    </div>
  );
}
