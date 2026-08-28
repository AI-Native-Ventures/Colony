/**
 * The post head a render produces.
 *
 * Until now the desktop's only write into the content calendar was the
 * owner's decision, because the agent produced cards on its own machine. The
 * renderer moved into the app, so the app now writes the result of a render
 * back onto the post: the images it uploaded and the reports bound to their
 * bytes.
 *
 * **The existing body is merged, not rebuilt.** A post carries fields the
 * relay stores opaquely — `style` and anything a future template pack reads —
 * and reconstructing the body from the parsed `ContentPost` would drop every
 * one of them. So this takes the head's own JSON and replaces exactly three
 * keys.
 *
 * **Status is never raised here.** A rendered post whose gates all pass is
 * still a draft: `ready` is what the agent declares when it hands the card
 * over, and the owner's approval is a separate event again. Raising it
 * because pixels measured well would put a card past the one gate the product
 * is built on.
 */

import { KIND_CONTENT_POST } from "@/shared/constants/kinds";

import type { SignedEventInput } from "./contentDecisions";
import type { SlideReport } from "./render/pipeline";

/** Pinned schema for the post record; mirrors `buzz-core`. */
export const SCHEMA_CONTENT_POST = "colony/content-post/v1";

/** One uploaded slide, as the post body names it. */
export type RenderedImage = {
  url: string;
  sha256: string;
  width: number;
  height: number;
};

/**
 * A report on the wire.
 *
 * `content.rs` reads `image_hash`, and it derives the verdict from the gate
 * statuses rather than believing a declared one — a report that claimed
 * `pass` over a failing gate is refused, so nothing here declares a verdict
 * at all.
 */
export function reportToWire(
  report: SlideReport,
  styleVersion: string | null,
): Record<string, unknown> {
  return {
    gates: report.gates.map((gate) => ({
      bar: gate.bar,
      detail: gate.detail,
      id: gate.id,
      measured: gate.measured,
      status: gate.status,
    })),
    image_hash: report.imageHash,
    rendered_at: report.renderedAt,
    renderer: report.renderer,
    ...(styleVersion === null ? {} : { style_version: styleVersion }),
  };
}

export type RenderedPostRefusal = { ok: false; reason: string };
export type RenderedPostDraft = { ok: true; event: SignedEventInput };

/**
 * The unsigned post head carrying a render's result.
 *
 * `body` is the current head's own JSON. Refusals here are the relay's rules
 * reached one round trip early: a report must name bytes that were actually
 * uploaded, and a post with reports but no images is refused at ingest.
 */
export function buildRenderedPostEvent(
  address: string,
  body: Record<string, unknown>,
  images: RenderedImage[],
  reports: SlideReport[],
  styleVersion: string | null,
): RenderedPostDraft | RenderedPostRefusal {
  if (images.length === 0) {
    return { ok: false, reason: "The render produced no images to publish." };
  }
  if (reports.length !== images.length) {
    return {
      ok: false,
      reason: `The render produced ${images.length} image(s) but ${reports.length} report(s); every slide carries its own report.`,
    };
  }
  const uploaded = new Set(images.map((image) => image.sha256));
  for (const report of reports) {
    if (!uploaded.has(report.imageHash)) {
      return {
        ok: false,
        reason: `A report names image ${report.imageHash.slice(0, 12)}…, which was not uploaded.`,
      };
    }
  }
  const declared = body.schema;
  if (typeof declared === "string" && declared !== SCHEMA_CONTENT_POST) {
    return {
      ok: false,
      reason: `This head declares schema \`${declared}\`, which is not a content post.`,
    };
  }

  return {
    event: {
      content: JSON.stringify({
        ...body,
        gate_reports: reports.map((report) =>
          reportToWire(report, styleVersion),
        ),
        images: images.map((image) => ({
          height: image.height,
          sha256: image.sha256,
          url: image.url,
          width: image.width,
        })),
        schema: SCHEMA_CONTENT_POST,
      }),
      kind: KIND_CONTENT_POST,
      tags: [["d", address]],
    },
    ok: true,
  };
}
