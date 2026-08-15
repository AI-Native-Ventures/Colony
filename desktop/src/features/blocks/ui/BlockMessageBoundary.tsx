import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";

import { BlockFallback } from "./BlockFallback";

const BlockMessage = React.lazy(() => import("./BlockMessage"));

/** Loads the Block renderer without delaying ordinary message rows. */
export function BlockMessageBoundary({
  message,
}: {
  message: TimelineMessage;
}) {
  return (
    <React.Suspense
      fallback={<BlockFallback state="loading" text={message.body} />}
    >
      <BlockMessage message={message} />
    </React.Suspense>
  );
}
