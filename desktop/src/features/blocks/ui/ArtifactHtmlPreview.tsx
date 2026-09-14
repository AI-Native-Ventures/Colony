import { useMemo, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { artifactPreviewDocument, readArtifactHtml } from "./artifactPreviewDocument";

/** A persisted artifact can carry a small static page alongside its source URL. */
export function ArtifactHtmlPreview({ data }: { data: unknown }) {
  const html = readArtifactHtml(data);
  const revision = data && typeof data === "object" ? (data as Record<string, unknown>).revision : null;
  const [mobile, setMobile] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    if (html === null) return null;
    try {
      return { document: artifactPreviewDocument(html), error: null };
    } catch (error) {
      return { document: null, error: error instanceof Error ? error.message : "Preview unavailable." };
    }
  }, [html]);
  if (!preview) return null;
  if (!preview.document) return <p role="alert">{preview.error}</p>;
  const frame = (large: boolean) => (
    <div className="overflow-auto rounded-lg border bg-white p-2">
      <iframe
        className="mx-auto block border-0 bg-white"
        referrerPolicy="no-referrer"
        sandbox=""
        srcDoc={preview.document ?? undefined}
        style={{ width: mobile ? 390 : "100%", maxWidth: "100%", height: large ? "70vh" : 460 }}
        title={mobile ? "Mobile HTML preview" : "Desktop HTML preview"}
      />
    </div>
  );
  return (
    <section aria-label="Website preview" className="mt-4 space-y-3">
      {Number.isSafeInteger(revision) && Number(revision) > 0 ? <p className="text-sm font-medium">Version {String(revision)}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button aria-pressed={!mobile} onClick={() => setMobile(false)} size="sm" variant="outline">Desktop</Button>
        <Button aria-pressed={mobile} onClick={() => setMobile(true)} size="sm" variant="outline">Mobile</Button>
        <Button onClick={() => setExpanded(true)} size="sm" variant="outline">Expand preview</Button>
      </div>
      {!expanded && frame(false)}
      <p className="text-xs text-muted-foreground">Static HTML preview. Scripts, forms and external assets are disabled. Reply in this thread to request changes.</p>
      <Dialog onOpenChange={setExpanded} open={expanded}>
        <DialogContent className="w-[95vw] max-w-6xl">
          <DialogTitle>Website preview</DialogTitle>
          {expanded && frame(true)}
        </DialogContent>
      </Dialog>
    </section>
  );
}
