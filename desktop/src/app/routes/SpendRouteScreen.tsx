import { useCommunities } from "@/features/communities/useCommunities";
import { useLedgerReport } from "@/features/ledger/hooks";
import { LedgerScreen } from "@/features/ledger/ui/LedgerScreen";

export function SpendRouteScreen() {
  const { activeCommunity } = useCommunities();
  const reportQuery = useLedgerReport(activeCommunity?.id ?? "");

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <LedgerScreen
        error={reportQuery.error instanceof Error ? reportQuery.error : null}
        isLoading={activeCommunity !== null && reportQuery.isLoading}
        report={reportQuery.data ?? null}
      />
    </div>
  );
}
