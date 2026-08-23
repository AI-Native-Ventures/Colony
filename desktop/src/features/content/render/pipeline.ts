/**
 * The render pipeline: text gates, then pixels, then a report bound to those
 * pixels.
 *
 * The ordering is the product. Text gates run before anything is drawn, so a
 * card with an unsourced claim or a house-rule breach costs nothing; only once
 * they pass does a slide get rendered, measured, and given a report naming the
 * exact bytes it measured.
 *
 * **One report per slide.** `content.rs` binds a report to the SHA-256 of the
 * image it measured and refuses a mismatch, and a ready post needs a passing
 * report for every slide. So a four-slide carousel produces four reports, each
 * naming its own slide.
 *
 * **The card-level gates appear in every slide's report.** Canvas, house style
 * and claims are properties of the card, not of one slide, but `REQUIRED_GATES`
 * is checked per report: a report missing one of the six ids leaves the post
 * unable to be ready. Copying the card-level verdicts into each slide's report
 * is what keeps every report complete, and it is honest, because those gates
 * did pass for the card that slide belongs to.
 */

import type { GateEntry, HouseRules } from "./houseStyle";
import { mayRender, preRenderTextGates } from "./houseStyle";
import type { CardText } from "./houseStyle";
import { AA_BODY } from "./contrast";
import type { ContrastMeasurement } from "./contrast";
import { worstRatio } from "./contrast";
import type { GrainRange, GrainReport } from "./grain";
import { grainWithin } from "./grain";
import type { FontGateResult } from "./fontGate";

/** What one rendered slide brings back from the capture path. */
export type RenderedSlide = {
  png: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  contrast: ContrastMeasurement[];
  grain: GrainReport;
  font: FontGateResult;
};

/** A report, shaped as `contracts.ts` parses it. */
export type SlideReport = {
  imageHash: string;
  renderedAt: string;
  renderer: Record<string, unknown>;
  gates: GateEntry[];
};

/** What the pipeline returns, rendered or refused. */
export type PipelineOutcome =
  | { status: "blocked"; gates: GateEntry[]; blocking: GateEntry[] }
  | { status: "rendered"; reports: SlideReport[] };

/** The contrast gate entry for one slide. */
export function contrastGateEntry(
  measurements: ContrastMeasurement[],
  bar: number = AA_BODY,
): GateEntry {
  const worst = worstRatio(measurements);
  const loser = measurements.find((m) => m.ratio === worst);
  return {
    bar,
    detail:
      worst >= bar
        ? `Worst run "${loser?.label ?? "?"}" at ${worst}:1 against a ${bar}:1 floor.`
        : `Run "${loser?.label ?? "?"}" measures ${worst}:1 on ${loser?.worstBackground ?? "the ground"}, under the ${bar}:1 floor.`,
    id: "contrast",
    measured: worst,
    status: worst >= bar ? "pass" : "fail",
  };
}

/** The grain gate entry for one slide. */
export function grainGateEntry(
  report: GrainReport,
  range: GrainRange,
): GateEntry {
  const verdict = grainWithin(report, range);
  return {
    bar: range,
    detail:
      verdict.reason ??
      `Ground grain ${verdict.measured}, inside the kit range ${range.min} to ${range.max}.`,
    id: "grain",
    measured: verdict.measured,
    status: verdict.pass ? "pass" : "fail",
  };
}

/** The font-fallback gate entry for one slide. */
export function fontGateEntry(result: FontGateResult): GateEntry {
  return {
    bar: 0,
    detail:
      result.reason ??
      `The kit face reached the raster: removing it moves the text box by ${result.delta} luminance units.`,
    id: "fonts",
    measured: result.delta,
    status: result.pass ? "pass" : "fail",
  };
}

/**
 * Assemble one slide's report.
 *
 * `cardGates` are the pre-render verdicts, shared by every slide of the card;
 * the pixel gates are this slide's own.
 */
export function slideReport(
  slide: RenderedSlide,
  cardGates: GateEntry[],
  grainRange: GrainRange,
  renderedAt: string,
  renderer: Record<string, unknown>,
  contrastBar: number = AA_BODY,
): SlideReport {
  return {
    gates: [
      ...cardGates,
      contrastGateEntry(slide.contrast, contrastBar),
      grainGateEntry(slide.grain, grainRange),
      fontGateEntry(slide.font),
    ],
    imageHash: slide.sha256,
    renderedAt,
    renderer,
  };
}

/**
 * Whether a report clears every gate it carries.
 *
 * A post is ready only when every slide's report passes, which `content.rs`
 * enforces at ingest; this is the same question asked locally so the UI can
 * answer before a write is attempted.
 */
export function reportPasses(report: SlideReport): boolean {
  return report.gates.every((gate) => gate.status === "pass");
}

/**
 * Run the text gates, and say whether pixels may be drawn.
 *
 * `claimGate` comes from `../claimVerifier`: the claim-verifier ticket exported
 * `claimGateResult` for exactly this call, and duplicating claim checking here
 * would mean two answers to one question.
 */
export function preRender(
  text: CardText,
  width: number,
  height: number,
  rules: HouseRules,
  claimGate: GateEntry,
): { gates: GateEntry[]; ok: boolean; blocking: GateEntry[] } {
  const gates = [...preRenderTextGates(text, width, height, rules), claimGate];
  const verdict = mayRender(gates);
  return { blocking: verdict.blocking, gates, ok: verdict.ok };
}

/**
 * The whole pipeline for one card.
 *
 * `render` is the caller's bridge to the capture path: it is only invoked once
 * the text gates have passed, which is what makes a failing card free.
 */
export async function renderCard(
  text: CardText,
  width: number,
  height: number,
  rules: HouseRules,
  claimGate: GateEntry,
  grainRange: GrainRange,
  render: () => Promise<RenderedSlide[]>,
  renderedAt: string,
  renderer: Record<string, unknown>,
  contrastBar: number = AA_BODY,
): Promise<PipelineOutcome> {
  const pre = preRender(text, width, height, rules, claimGate);
  if (!pre.ok) {
    return { blocking: pre.blocking, gates: pre.gates, status: "blocked" };
  }
  const slides = await render();
  if (slides.length === 0) {
    throw new Error("pipeline: the renderer returned no slides");
  }
  const seen = new Set<string>();
  for (const slide of slides) {
    if (seen.has(slide.sha256)) {
      // Two slides with one hash would let a report describe the wrong bytes,
      // and the carousel's approval digest would not notice one being swapped
      // for the other.
      throw new Error(
        `pipeline: two slides share the hash ${slide.sha256.slice(0, 12)}…`,
      );
    }
    seen.add(slide.sha256);
  }
  return {
    reports: slides.map((slide) =>
      slideReport(
        slide,
        pre.gates,
        grainRange,
        renderedAt,
        renderer,
        contrastBar,
      ),
    ),
    status: "rendered",
  };
}
