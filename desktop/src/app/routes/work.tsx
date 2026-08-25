import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

const WorkRouteScreen = React.lazy(async () => {
  const module = await import("./WorkRouteScreen");
  return { default: module.WorkRouteScreen };
});

export const Route = createFileRoute("/work")({
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
