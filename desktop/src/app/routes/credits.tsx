import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

const CreditsRouteScreen = React.lazy(async () => {
  const module = await import("./CreditsRouteScreen");
  return { default: module.CreditsRouteScreen };
});

export const Route = createFileRoute("/credits")({
  component: CreditsRouteComponent,
});

function CreditsRouteComponent() {
  return (
    <React.Suspense
      fallback={
        <div
          aria-busy="true"
          className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
          role="status"
        >
          Loading Credits…
        </div>
      }
    >
      <CreditsRouteScreen />
    </React.Suspense>
  );
}
