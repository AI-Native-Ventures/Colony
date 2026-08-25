import type * as React from "react";

import { PdfWorkspaceViewerView } from "./PdfWorkspaceViewerView";
import { pdfWorkspaceViewerRuntime } from "./pdfWorkspaceViewerRuntime";

export type PdfWorkspaceViewerProps = {
  bytesBase64: string;
  name: string;
  onRetry: () => void;
};

/** PDF viewer wired to the production PDF.js worker runtime. */
export function PdfWorkspaceViewer(
  props: PdfWorkspaceViewerProps,
): React.JSX.Element {
  return (
    <PdfWorkspaceViewerView {...props} runtime={pdfWorkspaceViewerRuntime} />
  );
}

export default PdfWorkspaceViewer;
