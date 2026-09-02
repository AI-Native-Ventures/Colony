import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { validateWorkSearch } from "./workSearch";

const WorkRouteScreen = React.lazy(async () => {
  const module = await import("./WorkRouteScreen");
  return { default: module.WorkRouteScreen };
});

export type { WorkRouteSearch, WorkView } from "./workSearch";

export const Route = createFileRoute("/work")({
  validateSearch: validateWorkSearch,
  component: WorkRouteComponent,
});

function WorkRouteComponent() {
  return (
    <React.Suspense
      fallback={
        <div
          aria-busy="true"
          className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
          role="status"
        >
          Loading tasks…
        </div>
      }
    >
      <WorkRouteScreen />
    </React.Suspense>
  );
}
