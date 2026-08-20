import type * as React from "react";

import type { OnboardingV2Stage } from "@/features/onboarding/onboardingV2";
import { cn } from "@/shared/lib/cn";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { AntMark } from "@/shared/ui/colony-logo/AntMark";

const STAGE_INDEX: Record<OnboardingV2Stage, number> = {
  founder: 0,
  website: 1,
  scan: 1,
  summary: 2,
  description: 2,
  "runtime-check": 3,
  "runtime-ready": 3,
  "agent-install": 3,
  model: 4,
  scout: 5,
  "first-task": 6,
  entering: 6,
};

const STAGE_TRAIL = [
  { id: "founder", hue: "#7457e8" },
  { id: "business", hue: "#427ee8" },
  { id: "context", hue: "#e857a4" },
  { id: "runtime", hue: "#ed9f36" },
  { id: "model", hue: "#21a778" },
  { id: "scout", hue: "#7457e8" },
  { id: "task", hue: "#21a778" },
] as const;

export function OnboardingV2Shell({
  children,
  stage,
}: {
  children: React.ReactNode;
  stage: OnboardingV2Stage;
}) {
  const stageIndex = STAGE_INDEX[stage];
  return (
    <main
      className="buzz-onboarding-v2"
      data-testid="onboarding-v2"
      style={
        {
          "--onboarding-v2-accent": STAGE_TRAIL[stageIndex].hue,
        } as React.CSSProperties
      }
    >
      <StartupWindowDragRegion />
      <div className="buzz-onboarding-v2__glow" aria-hidden="true" />
      <header className="buzz-onboarding-v2__header">
        <div className="buzz-onboarding-v2__brand">
          <span className="buzz-onboarding-v2__mark">
            <AntMark />
          </span>
          <span>Colony</span>
        </div>
        <span className="buzz-onboarding-v2__eyebrow">
          Your company is waking up
        </span>
      </header>
      <div className="buzz-onboarding-v2__trail" aria-hidden="true">
        {STAGE_TRAIL.map(({ hue, id }, index) => (
          <span
            className={cn(
              "buzz-onboarding-v2__trail-node",
              index <= stageIndex && "is-active",
              index === stageIndex && "is-current",
            )}
            key={id}
            style={{ "--trail-hue": hue } as React.CSSProperties}
          />
        ))}
      </div>
      <section className="buzz-onboarding-v2__panel">{children}</section>
    </main>
  );
}

export function OnboardingV2Status({
  label,
  detail,
}: {
  label: string;
  detail?: string;
}) {
  return (
    <div className="buzz-onboarding-v2__status" role="status">
      <span className="buzz-onboarding-v2__spinner" aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
    </div>
  );
}
