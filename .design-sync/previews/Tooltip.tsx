import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "buzz";

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

export function Default() {
  return (
    <TooltipProvider>
      {/* Inline height: the bundled stylesheet only carries Tailwind classes
          that desktop/src already uses, so an unused h-* utility no-ops and
          the tooltip flips below its trigger for lack of room. */}
      <div
        className="flex items-center justify-center"
        style={{ height: 200 }}
      >
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-background p-1 shadow-sm">
          <Button size="icon" variant="ghost">
            <Icon>
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" strokeLinecap="round" />
              <path d="M9 9h.01M15 9h.01" strokeLinecap="round" />
            </Icon>
            <span className="sr-only">Add reaction</span>
          </Button>
          <Button size="icon" variant="ghost">
            <Icon>
              <path
                d="M9 17 4 12l5-5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M20 18v-2a4 4 0 0 0-4-4H4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Icon>
            <span className="sr-only">Reply in thread</span>
          </Button>
          <Tooltip open>
            <TooltipTrigger asChild>
              <Button size="icon" variant="ghost">
                <Icon>
                  <path
                    d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <rect height="4" rx="1" width="8" x="8" y="2" />
                </Icon>
                <span className="sr-only">Copy message link</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Copy message link</TooltipContent>
          </Tooltip>
          <Button size="icon" variant="ghost">
            <Icon>
              <circle cx="5" cy="12" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
            </Icon>
            <span className="sr-only">More actions</span>
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
