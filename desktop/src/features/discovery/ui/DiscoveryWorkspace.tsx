import type { DiscoverySearch } from "@/app/routes/discovery";
import type { DiscoveryEntitlement } from "../entitlement";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type {
  CampaignDetail,
  Industry,
  LeadPage,
  VerticalDetail,
} from "../types";

/** The read models loaded by the route for the active addressable surface. */
export type DiscoveryRouteReadModel = {
  industries: Industry[];
  vertical: VerticalDetail | null;
  campaign: CampaignDetail | null;
  leads: LeadPage | null;
};

export type DiscoveryWorkspaceProps = {
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  error: Error | null;
  isLoading: boolean;
  readModel: DiscoveryRouteReadModel | null;
  search: DiscoverySearch;
};

/**
 * Typed handoff boundary for the Discovery workspace.
 *
 * Task 3 owns the visual workspace. Keeping this boundary inert here lets the
 * route and fixture adapter land independently without inventing a second UI
 * or provider integration.
 */
export function DiscoveryWorkspace(_props: DiscoveryWorkspaceProps) {
  return null;
}
