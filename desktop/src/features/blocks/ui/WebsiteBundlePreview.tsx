import { useEffect, useMemo, useRef, useState } from "react";
import { useCommunities } from "@/features/communities/useCommunities";
import { electronDesktop } from "@/shared/api/electronNativeBridge";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";

/** Mount a verified website in an isolated native view, never the app DOM. */
function WebsiteView({
  request,
  large,
  approved,
}: {
  request: Record<string, unknown>;
  large: boolean;
  approved: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [downloadHandle, setDownloadHandle] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const download = async () => {
    if (!downloadHandle || saving) return;
    setSaving(true);
    setDownloadNotice("");
    try {
      const result = await electronDesktop()?.request<{ saved: boolean }>(
        "preview:export",
        {
          ...request,
          handle: downloadHandle,
        },
      );
      setDownloadNotice(
        result?.saved ? "Website files saved." : "Save cancelled.",
      );
    } catch (failure) {
      setDownloadNotice(
        failure instanceof Error
          ? failure.message
          : "Could not save website files.",
      );
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const desktop = electronDesktop();
    const node = element.current;
    if (!desktop || !node) return;
    let closed = false;
    let handle: string | null = null;
    let scheduled = 0;
    const geometry = () => {
      const rect = node.getBoundingClientRect();
      let left = Math.max(0, rect.left);
      let top = Math.max(0, rect.top);
      let right = Math.min(innerWidth, rect.right);
      let bottom = Math.min(innerHeight, rect.bottom);
      for (
        let parent = node.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        const box = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, box.left);
          right = Math.min(right, box.right);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, box.top);
          bottom = Math.min(bottom, box.bottom);
        }
      }
      const covered = [...document.querySelectorAll('[role="dialog"]')].some(
        (dialog) => !dialog.contains(node),
      );
      return {
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        clip: {
          left,
          top,
          right: covered ? left : right,
          bottom: covered ? top : bottom,
        },
      };
    };
    const update = () => {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        if (handle && !closed)
          void desktop
            .request("preview:bounds", { ...request, handle, ...geometry() })
            .catch(() => {});
      });
    };
    setReady(false);
    setDownloadHandle(null);
    setError(null);
    void desktop
      .request<{ handle: string }>("preview:open", {
        ...request,
        ...geometry(),
      })
      .then((state) => {
        handle = state.handle;
        if (closed) {
          void desktop
            .request("preview:close", { ...request, handle })
            .catch(() => {});
        } else {
          setReady(true);
          setDownloadHandle(handle);
          update();
        }
      })
      .catch((failure) => {
        if (!closed)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    const resize = new ResizeObserver(update);
    resize.observe(node);
    const changes = new MutationObserver(update);
    changes.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      closed = true;
      cancelAnimationFrame(scheduled);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      if (handle)
        void desktop
          .request("preview:close", { ...request, handle })
          .catch(() => {});
    };
  }, [request]);
  return (
    <>
      <div
        ref={element}
        className="relative overflow-hidden rounded-lg border bg-white"
        style={{ height: large ? "65vh" : 340 }}
      >
        {error ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {error}
          </p>
        ) : !ready ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading saved website…
          </p>
        ) : null}
      </div>
      {approved && ready ? (
        <div className="mt-3 space-y-2">
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => void download()}
          >
            {saving ? "Preparing files…" : "Download website files"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Exact preview files and assets. Original project sources and backend
            services may be separate.
          </p>
          {downloadNotice ? (
            <p role="status" className="text-sm">
              {downloadNotice}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function WebsiteBundlePreview({
  bundle,
  artifactId,
  threadRoot,
  revision,
  approved = false,
}: {
  bundle: { url: string; sha256: string };
  artifactId: string;
  threadRoot: string;
  revision: number;
  approved?: boolean;
}) {
  const { activeCommunity } = useCommunities();
  const [mobile, setMobile] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useMemo(
    () => ({
      communityId: activeCommunity?.id,
      artifactId,
      threadRoot,
      revision,
      manifest: { url: bundle.url, sha256: bundle.sha256 },
      viewport: mobile ? "mobile" : "desktop",
    }),
    [
      activeCommunity?.id,
      artifactId,
      threadRoot,
      revision,
      bundle.url,
      bundle.sha256,
      mobile,
    ],
  );
  if (!electronDesktop())
    return (
      <p className="mt-3 text-sm">
        Open this saved website in the Colony desktop app to review it.
      </p>
    );
  return (
    <section aria-label="Saved website preview" className="mt-4 space-y-3">
      <p className="text-sm font-medium">Version {revision}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          aria-pressed={!mobile}
          onClick={() => setMobile(false)}
        >
          Desktop
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={mobile}
          onClick={() => setMobile(true)}
        >
          Mobile
        </Button>
        <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
          Expand preview
        </Button>
      </div>
      {!expanded && (
        <WebsiteView request={request} large={false} approved={approved} />
      )}
      <p className="text-xs text-muted-foreground">
        Saved website preview. Reply in this thread to request changes. This
        does not publish the website.
      </p>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="w-[95vw] max-w-6xl">
          <DialogTitle>Website preview · Version {revision}</DialogTitle>
          {expanded && (
            <WebsiteView request={request} large approved={approved} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
