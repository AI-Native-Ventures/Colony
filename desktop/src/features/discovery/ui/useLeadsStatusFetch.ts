import * as React from "react";

import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { LeadFunnelStatus, LeadPage } from "../types";

/**
 * The leads fetch for a workspace, driven by the selected funnel status.
 *
 * Two behaviors keep the relay status filter live instead of decorative:
 * - the fetch re-runs when `status` changes, and
 * - it stops short-circuiting on `initialLeads` once a status is selected.
 *
 * Without the status, an already-loaded `initialLeads` page is used as-is
 * (the route screen fetched the unfiltered workspace), so the normal route
 * keeps its instant first paint and no extra request fires.
 */
export function useLeadsStatusFetch({
  campaignId,
  dataSource,
  initialLeads,
  scope,
  status,
}: {
  campaignId?: string;
  dataSource: DiscoveryDataSource;
  initialLeads: LeadPage | null | undefined;
  scope: "campaign" | "global";
  status: LeadFunnelStatus | undefined;
}) {
  const pageSize = scope === "campaign" ? 100 : 500;
  const [page, setPage] = React.useState<LeadPage | null>(initialLeads ?? null);
  const [isLoading, setIsLoading] = React.useState(!initialLeads);

  React.useEffect(() => {
    let cancelled = false;
    if (!status && initialLeads) {
      setPage(initialLeads);
      setIsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setIsLoading(true);
    void dataSource
      .getLeads({
        scope,
        ...(campaignId ? { campaignId } : {}),
        ...(status ? { status } : {}),
        page: 1,
        pageSize,
      })
      .then((nextPage) => {
        if (cancelled) return;
        setPage(nextPage);
        setIsLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setPage({
            leads: [],
            total: 0,
            page: 1,
            pageSize,
            hasNextPage: false,
          });
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, dataSource, initialLeads, pageSize, scope, status]);

  return { isLoading, page };
}
