import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

const WorkRouteScreen = React.lazy(async () => {
  const module = await import("./WorkRouteScreen");
  return { default: module.WorkRouteScreen };
});

export type WorkRouteSearch = {
  view?: "list" | "board" | "queue";
  initiativeId?: string;
};

function validateWorkSearch(search: Record<string, unknown>): WorkRouteSearch {
  return {
    initiativeId:
      typeof search.initiativeId === "string" ? search.initiativeId : undefined,
    view:
      search.view === "board" || search.view === "queue"
        ? search.view
        : undefined,
  };
}

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
