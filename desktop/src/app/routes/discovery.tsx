import { createFileRoute } from "@tanstack/react-router";

import { DiscoveryRouteScreen } from "@/features/discovery/ui/DiscoveryRouteScreen";
import { validateDiscoverySearch } from "./discoverySearch";

export type {
  DiscoveryEntity,
  DiscoverySearch,
  DiscoverySurface,
  DiscoveryTab,
} from "./discoverySearch";

export const Route = createFileRoute("/discovery")({
  validateSearch: validateDiscoverySearch,
  component: DiscoveryRouteComponent,
});

function DiscoveryRouteComponent() {
  return <DiscoveryRouteScreen search={Route.useSearch()} />;
}
