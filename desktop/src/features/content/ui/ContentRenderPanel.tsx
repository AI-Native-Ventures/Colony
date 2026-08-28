import * as React from "react";

import { Button } from "@/shared/ui/button";

import type { ContentPost } from "../contracts";
import { useRenderContentPost } from "../hooks";
import type { RenderPostOutcome } from "../hooks";

/**
 * Draw the card.
 *
 * The renderer lives in the app because the app is already a WebKit view, and
 * this is where an owner reaches it. What the button does is not "generate":
 * every word on the card was authored before it was clicked, and the render
 * only decides whether those words can be drawn without breaking a gate.
 *
 * A blocked render is the normal outcome worth designing for, not an error.
 * The text gates run before any pixel is drawn, so a card with an unsourced
 * claim or a house-rule breach comes back in under a second with the reason,
 * having cost nothing. That readout is the panel's real job; the image is
 * shown above it either way.
 */
export function ContentRenderPanel({
  communityId,
  post,
}: {
  communityId: string;
  post: ContentPost;
}) {
  const render = useRenderContentPost(communityId);
  const [result, setResult] = React.useState<RenderPostOutcome | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleRender = React.useCallback(async () => {
    setError(null);
    setResult(null);
    try {
      setResult(await render.mutateAsync(post));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [post, render]);

  const blocking =
    result?.outcome.status === "blocked" ? result.outcome.blocking : [];
  const rendered = result?.outcome.status === "rendered";

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">
          {post.images.length > 0 ? "Re-render" : "Render"}
        </p>
        <Button
          disabled={render.isPending || post.style === null}
          onClick={handleRender}
          size="sm"
          variant={post.images.length > 0 ? "outline" : "default"}
        >
          {render.isPending ? "Drawing…" : "Draw the card"}
        </Button>
      </div>

      {post.style === null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This post has no style block, so there is nothing to draw. The agent
          that wrote it sets the family, hues and layout.
        </p>
      ) : null}

      {blocking.length > 0 ? (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2">
          <p className="text-xs font-medium text-destructive">
            Not drawn. Fix these first, and it costs nothing to try again.
          </p>
          <ul className="mt-1 list-inside list-disc">
            {blocking.map((gate) => (
              <li className="text-xs text-destructive" key={gate.id}>
                {gate.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rendered ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Drawn and measured. Every check is below, against the exact bytes that
          were uploaded.
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
