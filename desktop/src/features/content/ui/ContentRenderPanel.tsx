import * as React from "react";

import { Button } from "@/shared/ui/button";

import type { ContentPost } from "../contracts";
import {
  useDraftVariantTakes,
  useRecordStylePick,
  useRenderContentPost,
} from "../hooks";
import type { DrawnTake, RenderPostOutcome } from "../hooks";

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
 *
 * "Show me choices" is the taste loop's zero-articulation input: the owner
 * taps the take they like, the tap is recorded on the style record, and only
 * the picked take is uploaded. Nobody is ever asked to describe anything.
 */
export function ContentRenderPanel({
  communityId,
  post,
}: {
  communityId: string;
  post: ContentPost;
}) {
  const render = useRenderContentPost(communityId);
  const draftTakes = useDraftVariantTakes(communityId);
  const recordPick = useRecordStylePick(communityId);
  const [result, setResult] = React.useState<RenderPostOutcome | null>(null);
  const [takes, setTakes] = React.useState<DrawnTake[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [blocking, setBlocking] = React.useState<
    { id: string; detail: string }[]
  >([]);

  const handleRender = React.useCallback(async () => {
    setError(null);
    setResult(null);
    setTakes(null);
    setBlocking([]);
    try {
      const outcome = await render.mutateAsync({ post });
      setResult(outcome);
      if (outcome.outcome.status === "blocked") {
        setBlocking(outcome.outcome.blocking);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [post, render]);

  const handleShowTakes = React.useCallback(async () => {
    setError(null);
    setResult(null);
    setTakes(null);
    setBlocking([]);
    try {
      const outcome = await draftTakes.mutateAsync(post);
      if (outcome.status === "blocked") {
        setBlocking(outcome.blocking);
      } else {
        setTakes(outcome.takes);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [draftTakes, post]);

  const handlePick = React.useCallback(
    async (take: DrawnTake) => {
      setError(null);
      try {
        // The real render first: the pick is only worth recording as taste if
        // the take actually became the card.
        const outcome = await render.mutateAsync({ post, style: take.style });
        setResult(outcome);
        setTakes(null);
        await recordPick.mutateAsync({ post, style: take.style });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [post, recordPick, render],
  );

  const busy = render.isPending || draftTakes.isPending;
  const rendered = result?.outcome.status === "rendered";

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">
          {post.images.length > 0 ? "Re-render" : "Render"}
        </p>
        <div className="flex gap-2">
          <Button
            disabled={busy || post.style === null}
            onClick={handleShowTakes}
            size="sm"
            variant="outline"
          >
            {draftTakes.isPending ? "Drawing…" : "Show me choices"}
          </Button>
          <Button
            disabled={busy || post.style === null}
            onClick={handleRender}
            size="sm"
            variant={post.images.length > 0 ? "outline" : "default"}
          >
            {render.isPending ? "Drawing…" : "Draw the card"}
          </Button>
        </div>
      </div>

      {post.style === null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This post has no style block, so there is nothing to draw. The agent
          that wrote it sets the family, hues and layout.
        </p>
      ) : null}

      {takes && takes.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">
            Tap the one you like. It becomes the card, and your agent learns
            from the choice.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            {takes.map((take) => (
              <button
                className="group w-32 text-left"
                data-testid={`content-take-${take.label.toLowerCase().replace(/\s+/g, "-")}`}
                disabled={render.isPending}
                key={take.label}
                onClick={() => handlePick(take)}
                type="button"
              >
                <img
                  alt={take.label}
                  className="w-full rounded-lg border border-border/60 transition group-hover:border-primary"
                  src={take.imageUri}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  {take.label}
                </span>
              </button>
            ))}
          </div>
        </div>
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
