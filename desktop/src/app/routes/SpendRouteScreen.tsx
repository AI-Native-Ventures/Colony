import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import {
  useLedgerReport,
  usePublishPrice,
  useRecordCorrection,
} from "@/features/ledger/hooks";
import type { LedgerEntry } from "@/features/ledger/report";
import { CorrectionDialog } from "@/features/ledger/ui/CorrectionDialog";
import { PriceDialog } from "@/features/ledger/ui/PriceDialog";
import { LedgerScreen } from "@/features/ledger/ui/LedgerScreen";

export function SpendRouteScreen() {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const reportQuery = useLedgerReport(communityId);
  const correction = useRecordCorrection(communityId);
  const [correcting, setCorrecting] = React.useState<LedgerEntry | null>(null);
  const price = usePublishPrice(communityId);
  const [pricing, setPricing] = React.useState(false);

  const closePriceDialog = React.useCallback(
    (open: boolean) => {
      if (open) return;
      setPricing(false);
      price.reset();
    },
    [price.reset],
  );

  const closeDialog = React.useCallback(
    (open: boolean) => {
      if (open) return;
      setCorrecting(null);
      correction.reset();
    },
    [correction.reset],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <LedgerScreen
        error={reportQuery.error instanceof Error ? reportQuery.error : null}
        isLoading={activeCommunity !== null && reportQuery.isLoading}
        onAddPrice={() => setPricing(true)}
        onAttribute={setCorrecting}
        report={reportQuery.data ?? null}
      />
      <PriceDialog
        isSubmitting={price.isPending}
        onOpenChange={closePriceDialog}
        onSubmit={(request) =>
          price.mutate(request, { onSuccess: () => setPricing(false) })
        }
        open={pricing}
        submitError={price.error instanceof Error ? price.error : null}
      />
      <CorrectionDialog
        entry={correcting}
        isSubmitting={correction.isPending}
        onOpenChange={closeDialog}
        onSubmit={(request) =>
          correction.mutate(request, { onSuccess: () => setCorrecting(null) })
        }
        submitError={
          correction.error instanceof Error ? correction.error : null
        }
      />
    </div>
  );
}
