import * as React from "react";
import { Plus, Target } from "lucide-react";

import { useActiveCompany } from "@/features/company/hooks";
import type {
  Initiative,
  InitiativeStatus,
} from "@/features/company/contracts";
import type { InitiativeRow } from "@/features/company/initiativesModel";
import { NewInitiativeDialog } from "@/features/company/ui/NewInitiativeDialog";
import type { Channel } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";

/**
 * The Initiatives tab: every initiative this community has, and the only
 * place in the app that can create one.
 *
 * A row opens the board scoped to that initiative, which is the surface the
 * board's own empty state used to send people to the sidebar for.
 */

const STATUS_PILL_CLASS: Record<InitiativeStatus, string> = {
  active: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  approved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  blocked: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  cancelled: "bg-red-500/15 text-red-600 dark:text-red-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  proposed: "bg-muted text-muted-foreground",
};

export function InitiativesScreen({
  channels,
  communityId,
  error,
  isLoading,
  onCreated,
  onOpenInitiative,
  rows,
}: {
  channels: Channel[];
  communityId: string;
  error: Error | null;
  isLoading: boolean;
  onCreated: (initiative: Initiative) => void;
  onOpenInitiative: (initiativeId: string) => void;
  rows: InitiativeRow[];
}) {
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const companyQuery = useActiveCompany(communityId);
  const profile = companyQuery.data?.ok ? companyQuery.data.value : null;
  const costCentres = React.useMemo(
    () => profile?.costCentres ?? [],
    [profile],
  );
  const costCentreNameById = React.useMemo(
    () => new Map(costCentres.map((centre) => [centre.id, centre.name])),
    [costCentres],
  );

  return (
    <div
      className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-7 sm:px-6 sm:py-8"
      data-testid="initiatives-page"
    >
      <div className="mx-auto w-full max-w-6xl">
        <PageHeader
          action={
            <Button
              data-testid="initiatives-new"
              onClick={() => setIsDialogOpen(true)}
            >
              <Plus aria-hidden />
              New initiative
            </Button>
          }
          description="Every body of work this company has named. Open one to see its board."
          title="Initiatives"
        />

        <div className="mt-6 space-y-3">
          {isLoading ? (
            <div aria-busy="true" className="space-y-3" role="status">
              {[0, 1, 2].map((index) => (
                <Skeleton className="h-16 w-full rounded-xl" key={index} />
              ))}
            </div>
          ) : null}

          {!isLoading && error ? (
            <div
              className="rounded-2xl border border-destructive/25 bg-destructive/5 px-5 py-8"
              data-testid="initiatives-error"
              role="alert"
            >
              <h2 className="text-base font-semibold text-foreground">
                Initiatives could not be loaded
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {error.message}
              </p>
            </div>
          ) : null}

          {!isLoading && !error && rows.length === 0 ? (
            <div
              className="rounded-2xl border border-dashed border-border/70 px-5 py-12 text-center"
              data-testid="initiatives-empty"
            >
              <Target
                aria-hidden
                className="mx-auto size-8 text-muted-foreground"
              />
              <h2 className="mt-3 text-base font-semibold text-foreground">
                No initiatives yet
              </h2>
              <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
                An initiative is a body of work tasks are charged to. Name one
                and it starts as proposed until you start it.
              </p>
              <Button
                className="mt-4"
                data-testid="initiatives-empty-new"
                onClick={() => setIsDialogOpen(true)}
                variant="outline"
              >
                New initiative
              </Button>
            </div>
          ) : null}

          {!isLoading && !error && rows.length > 0 ? (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    className="flex w-full items-center gap-3 rounded-xl border border-border/60 px-4 py-3 text-left transition-colors hover:border-muted-foreground/40 hover:bg-muted/40"
                    data-testid="initiative-row"
                    onClick={() => onOpenInitiative(row.id)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm font-medium text-foreground"
                        data-testid="initiative-row-title"
                      >
                        {row.title}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {costCentreNameById.get(row.costCentreId) ??
                          row.costCentreId}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium leading-none",
                        STATUS_PILL_CLASS[row.status],
                      )}
                      data-testid="initiative-row-status"
                    >
                      {row.status}
                    </span>
                    <span
                      className="w-20 shrink-0 text-right text-xs text-muted-foreground"
                      data-testid="initiative-row-task-count"
                    >
                      {row.taskCount} task{row.taskCount === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <NewInitiativeDialog
        channels={channels}
        costCentres={costCentres}
        onCreated={onCreated}
        onOpenChange={setIsDialogOpen}
        open={isDialogOpen}
      />
    </div>
  );
}
