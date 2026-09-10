import * as React from "react";

import { parseQaReportText } from "./qaReport";
import { useVerifiedArtifact } from "./useVerifiedArtifact";
import type { WebsiteArtifactLoader, WebsiteQaEvidence } from "./types";
import type { WebsiteQaReportState } from "./viewLogic";

/**
 * Load and parse the reviewer report artifact referenced by QA evidence.
 *
 * The bytes always come from `useVerifiedArtifact`: the loader downloads and
 * hash-verifies them and returns a local object URL. Until the loader exists
 * (or while bytes are in flight) the state is an explicit unavailable/loading
 * state, never a fabricated checklist.
 */
export function useQaReport(options: {
  loader?: WebsiteArtifactLoader;
  qa?: WebsiteQaEvidence;
  enabled?: boolean;
}): WebsiteQaReportState {
  const { loader, qa, enabled = true } = options;
  const artifact = qa?.report ?? null;
  const verified = useVerifiedArtifact({
    loader,
    artifact,
    enabled: enabled && Boolean(qa),
  });
  const objectUrl = verified.status === "ready" ? verified.objectUrl : null;
  const [parsed, setParsed] = React.useState<{
    key: string;
    state: WebsiteQaReportState;
  } | null>(null);

  React.useEffect(() => {
    if (!objectUrl) return;
    let cancelled = false;
    const controller = new AbortController();
    const read = async () => {
      try {
        const response = await fetch(objectUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`The report request returned ${response.status}.`);
        }
        const text = await response.text();
        if (cancelled) return;
        const result = parseQaReportText(text);
        setParsed({
          key: objectUrl,
          state: result.ok
            ? { status: "ready", report: result.report }
            : { status: "error", message: result.message },
        });
      } catch (cause) {
        if (cancelled || controller.signal.aborted) return;
        setParsed({
          key: objectUrl,
          state: {
            status: "error",
            message: "The reviewer checklist could not be read.",
            diagnostics: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }
    };
    void read();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [objectUrl]);

  if (!loader) {
    return {
      status: "unavailable",
      message:
        "This build cannot open the reviewer checklist. The report artifact is linked below.",
    };
  }
  if (verified.status === "idle") {
    return {
      status: "unavailable",
      message:
        "This build cannot open the reviewer checklist. The report artifact is linked below.",
    };
  }
  if (verified.status === "loading") return { status: "loading" };
  if (verified.status === "error") {
    return {
      status: "error",
      message: verified.message,
      diagnostics: verified.diagnostics,
    };
  }
  if (parsed && parsed.key === verified.objectUrl) return parsed.state;
  return { status: "loading" };
}
