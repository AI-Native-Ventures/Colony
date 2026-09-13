import * as React from "react";

import { resolveSelectionAfterRecordChange } from "./reviewLogic";
import type { WebsiteReviewRecord } from "./types";

export type WebsiteRevisionSelection = {
  selectedRevision: number;
  selectRevision: (revision: number) => void;
  /** Set when a record change moved or invalidated the previous selection. */
  notice?: string;
};

/**
 * Explicit version selection that survives record updates. If the viewer was
 * on the head, the selection follows the new head; an earlier version stays
 * selected while it exists; a vanished version falls back to the head.
 */
export function useRevisionSelection(
  record: WebsiteReviewRecord,
): WebsiteRevisionSelection {
  const [selected, setSelected] = React.useState(record.currentRevision);
  const [notice, setNotice] = React.useState<string | undefined>();
  const headerRef = React.useRef({
    currentRevision: record.currentRevision,
    revisions: record.revisions,
  });

  if (
    headerRef.current.currentRevision !== record.currentRevision ||
    headerRef.current.revisions !== record.revisions
  ) {
    const previous = headerRef.current;
    headerRef.current = {
      currentRevision: record.currentRevision,
      revisions: record.revisions,
    };
    const next = resolveSelectionAfterRecordChange({
      previousCurrentRevision: previous.currentRevision,
      nextCurrentRevision: record.currentRevision,
      nextRevisionNumbers: record.revisions.map((entry) => entry.revision),
      selectedRevision: selected,
    });
    if (next.revision !== selected) setSelected(next.revision);
    setNotice(next.invalidated ? next.message : undefined);
  }

  return {
    selectedRevision: selected,
    selectRevision: (revision: number) => {
      setSelected(revision);
      setNotice(undefined);
    },
    notice,
  };
}
