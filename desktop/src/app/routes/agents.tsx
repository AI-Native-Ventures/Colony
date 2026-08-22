import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { validateAgentsSearch } from "./agentsSearch";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const AgentsScreen = React.lazy(async () => {
  const module = await import("@/features/agents/ui/AgentsScreen");
  return { default: module.AgentsScreen };
});

export const Route = createFileRoute("/agents")({
  validateSearch: validateAgentsSearch,
  component: AgentsRouteComponent,
});

function AgentsRouteComponent() {
  const search = Route.useSearch();
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="agents" />}>
      <AgentsScreen focusSection={search.section} />
    </React.Suspense>
  );
}
