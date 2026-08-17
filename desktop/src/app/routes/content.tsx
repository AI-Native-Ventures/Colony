import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const ContentScreen = React.lazy(async () => {
  const module = await import("@/features/content/ui/ContentScreen");
  return { default: module.ContentScreen };
});

export const Route = createFileRoute("/content")({
  component: ContentRouteComponent,
});

function ContentRouteComponent() {
  usePreviewFeatureWarning("contentCalendar");
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="content" />}>
      <ContentScreen />
    </React.Suspense>
  );
}
