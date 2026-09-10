/**
 * One community-boundary reset for every module-level cache in the website
 * integration. Wired into `resetCommunityState()` so a community switch never
 * carries verified heads, receipt waiters, or cached instance refs across.
 */

import { resetWebsiteHeadsLiveSubscriptions } from "./useWebsiteHeads";
import { resetWebsiteHeadsState } from "./websiteHeads";
import { resetWebsiteInstanceRefCache } from "./websiteTransport";

export function resetWebsiteIntegrationState(): void {
  resetWebsiteHeadsLiveSubscriptions();
  resetWebsiteHeadsState();
  resetWebsiteInstanceRefCache();
}
