// site/src/brand/shots.ts
// Product screenshots, one set per brand hue.
//
// The page rolls a hue on every load and the shots sit directly on it, so a
// single violet set clashed on four loads in five. The desktop app's chrome
// follows its accent (applyChromeTint in
// desktop/src/shared/theme/ThemeProvider.tsx), so each set is captured with
// the accent set to that hue and the workspace tints to match the page.
//
// Regenerating, from desktop/:
//   pnpm build:e2e
//   for pair in violet:#895AF6 blue:#3B82F6 pink:#EC4899 amber:#F59E0B green:#2EB88A; do
//     hue=${pair%%:*}; acc=${pair##*:}
//     SITE_SHOT_ACCENT="$acc" SITE_SHOT_SUFFIX="-$hue" pnpm exec playwright test \
//       tests/e2e/site-feature-screenshots.spec.ts --project=smoke
//     SITE_SHOT_ACCENT="$acc" SITE_SHOT_SUFFIX="-$hue" pnpm exec playwright test \
//       tests/e2e/discovery.spec.ts --project=smoke -g SalesTeams
//   done
// Playwright empties test-results at the start of every run, so copy each set
// out before starting the next one.
import channelAmber from "@/assets/shots/product-channel-amber.jpg";
import channelBlue from "@/assets/shots/product-channel-blue.jpg";
import channelGreen from "@/assets/shots/product-channel-green.jpg";
import channelPink from "@/assets/shots/product-channel-pink.jpg";
import channelViolet from "@/assets/shots/product-channel-violet.jpg";
import deliveredAmber from "@/assets/shots/work-delivered-amber.jpg";
import deliveredBlue from "@/assets/shots/work-delivered-blue.jpg";
import deliveredGreen from "@/assets/shots/work-delivered-green.jpg";
import deliveredPink from "@/assets/shots/work-delivered-pink.jpg";
import deliveredViolet from "@/assets/shots/work-delivered-violet.jpg";
import industriesAmber from "@/assets/shots/discovery-industries-amber.jpg";
import industriesBlue from "@/assets/shots/discovery-industries-blue.jpg";
import industriesGreen from "@/assets/shots/discovery-industries-green.jpg";
import industriesPink from "@/assets/shots/discovery-industries-pink.jpg";
import industriesViolet from "@/assets/shots/discovery-industries-violet.jpg";
import pipelineAmber from "@/assets/shots/discovery-pipeline-amber.jpg";
import pipelineBlue from "@/assets/shots/discovery-pipeline-blue.jpg";
import pipelineGreen from "@/assets/shots/discovery-pipeline-green.jpg";
import pipelinePink from "@/assets/shots/discovery-pipeline-pink.jpg";
import pipelineViolet from "@/assets/shots/discovery-pipeline-violet.jpg";
import sidebarAmber from "@/assets/shots/feature-channels-amber.jpg";
import sidebarBlue from "@/assets/shots/feature-channels-blue.jpg";
import sidebarGreen from "@/assets/shots/feature-channels-green.jpg";
import sidebarPink from "@/assets/shots/feature-channels-pink.jpg";
import sidebarViolet from "@/assets/shots/feature-channels-violet.jpg";
import { getActiveHue, type HueName } from "./hue";

export type ShotName =
  | "channel"
  | "delivered"
  | "industries"
  | "pipeline"
  | "sidebar";

const SHOTS: Record<HueName, Record<ShotName, string>> = {
  violet: {
    channel: channelViolet,
    delivered: deliveredViolet,
    industries: industriesViolet,
    pipeline: pipelineViolet,
    sidebar: sidebarViolet,
  },
  blue: {
    channel: channelBlue,
    delivered: deliveredBlue,
    industries: industriesBlue,
    pipeline: pipelineBlue,
    sidebar: sidebarBlue,
  },
  pink: {
    channel: channelPink,
    delivered: deliveredPink,
    industries: industriesPink,
    pipeline: pipelinePink,
    sidebar: sidebarPink,
  },
  amber: {
    channel: channelAmber,
    delivered: deliveredAmber,
    industries: industriesAmber,
    pipeline: pipelineAmber,
    sidebar: sidebarAmber,
  },
  green: {
    channel: channelGreen,
    delivered: deliveredGreen,
    industries: industriesGreen,
    pipeline: pipelineGreen,
    sidebar: sidebarGreen,
  },
};

/**
 * The screenshot set matching the hue index.html already picked. Reads the
 * same stamped attribute the rest of the brand code does, so the shots can
 * never disagree with the background they sit on.
 */
export function shotsForActiveHue(): Record<ShotName, string> {
  return SHOTS[getActiveHue()];
}
