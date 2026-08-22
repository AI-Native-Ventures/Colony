import { Button } from "buzz";

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button>Create channel</Button>
      <Button variant="secondary">Invite people</Button>
      <Button variant="outline">Manage members</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="destructive">Leave community</Button>
      <Button variant="link">View the audit log</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="lg">Large</Button>
      <Button size="default">Default</Button>
      <Button size="sm">Small</Button>
      <Button size="xs">Extra small</Button>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled>Publishing…</Button>
      <Button disabled variant="secondary">
        Invite people
      </Button>
      <Button disabled variant="outline">
        Manage members
      </Button>
      <Button disabled variant="destructive">
        Leave community
      </Button>
    </div>
  );
}

export function WithIcon() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        New thread
      </Button>
      <Button variant="outline" size="icon" aria-label="Add reaction">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
        </svg>
      </Button>
    </div>
  );
}
