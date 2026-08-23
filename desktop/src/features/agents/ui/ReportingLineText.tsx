import type { ReportingLine } from "@/features/agents/reportingLine";
import { cn } from "@/shared/lib/cn";

type ReportingLineTextProps = {
  className?: string;
  line: ReportingLine;
  /**
   * When set, the manager's name renders as a button that opens the
   * manager's profile. When absent, the name stays plain text.
   */
  onOpenManager?: ((pubkey: string) => void) | null;
  testId?: string;
};

/**
 * The muted words that read naturally right after a rank badge:
 * "Worker  reports to Rivet". An agent nobody manages says so plainly
 * rather than rendering a blank; a member with no rank shows nothing at
 * all, which callers decide.
 */
export function ReportingLineText({
  className,
  line,
  onOpenManager,
  testId = "agent-reporting-line",
}: ReportingLineTextProps) {
  const managerPubkey = line.managerPubkey;
  if (!managerPubkey || !line.managerLabel) {
    return (
      <span
        className={cn(
          "inline-flex min-w-0 items-center text-xs leading-4 text-muted-foreground",
          className,
        )}
        data-testid={testId}
      >
        no manager
      </span>
    );
  }
  const { managerLabel } = line;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground",
        className,
      )}
      data-testid={testId}
    >
      reports to
      {onOpenManager ? (
        // Sidebar rows wrap their content in a pointer-events-none layer so
        // the card behind stays one click target; re-enable events just for
        // this link so the click opens the manager, not the member.
        <button
          className="pointer-events-auto cursor-pointer truncate underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-hidden"
          data-testid={`${testId}-manager`}
          onClick={() => onOpenManager(managerPubkey)}
          type="button"
        >
          {managerLabel}
        </button>
      ) : (
        <span className="truncate">{managerLabel}</span>
      )}
    </span>
  );
}
