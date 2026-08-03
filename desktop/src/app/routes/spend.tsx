import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

const SpendRouteScreen = React.lazy(async () => {
  const module = await import("./SpendRouteScreen");
  return { default: module.SpendRouteScreen };
});

export const Route = createFileRoute("/spend")({
  component: SpendRouteComponent,
});

function SpendRouteComponent() {
  return (
    <React.Suspense
      fallback={
        <div
          aria-busy="true"
          className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
          role="status"
        >
          Loading Spend…
        </div>
      }
    >
      <SpendRouteScreen />
    </React.Suspense>
  );
}
