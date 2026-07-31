import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

const BlocksRouteScreen = React.lazy(async () => {
  const module = await import("./BlocksRouteScreen");
  return { default: module.BlocksRouteScreen };
});

export const Route = createFileRoute("/blocks")({
  component: BlocksRouteComponent,
});

function BlocksRouteComponent() {
  return (
    <React.Suspense
      fallback={
        <div
          aria-busy="true"
          className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
          role="status"
        >
          Loading Blocks…
        </div>
      }
    >
      <BlocksRouteScreen />
    </React.Suspense>
  );
}
