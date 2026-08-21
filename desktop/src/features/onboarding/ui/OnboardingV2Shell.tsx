import type * as React from "react";

import type {
  OnboardingV2Journey,
  OnboardingV2Stage,
} from "@/features/onboarding/onboardingV2";
import { cn } from "@/shared/lib/cn";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { AntMark } from "@/shared/ui/colony-logo/AntMark";

const FIRST_COMMUNITY_STEPS: readonly OnboardingV2Stage[] = [
  "founder",
  "company",
  "scout-task",
  "entering",
];
const ADDITIONAL_COMMUNITY_STEPS: readonly OnboardingV2Stage[] = [
  "company",
  "scout-task",
  "entering",
];

export function OnboardingV2Shell({
  children,
  journey = "first-community",
  stage,
}: {
  children: React.ReactNode;
  journey?: OnboardingV2Journey;
  stage: OnboardingV2Stage;
}) {
  const isAdditionalCommunity = journey === "additional-community";
  const steps = isAdditionalCommunity
    ? ADDITIONAL_COMMUNITY_STEPS
    : FIRST_COMMUNITY_STEPS;
  const stepIndex = Math.max(0, steps.indexOf(stage));
  return (
    <main
      className="relative flex min-h-dvh flex-col items-center justify-center overflow-y-auto bg-background px-4 py-20 text-foreground"
      data-testid="onboarding-v2"
    >
      <StartupWindowDragRegion />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed -top-32 right-[-6rem] h-80 w-80 rounded-full bg-primary/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed -bottom-40 left-[-8rem] h-96 w-96 rounded-full bg-primary/5 blur-3xl"
      />
      <header className="absolute inset-x-7 top-7 z-2 flex items-center justify-between">
        <div className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
          <span className="flex h-7.5 w-7.5 items-center justify-center rounded-lg bg-foreground text-background">
            <AntMark />
          </span>
          <span>Colony</span>
        </div>
        <span className="text-3xs uppercase tracking-[0.08em] text-muted-foreground">
          {isAdditionalCommunity
            ? "Your new company is waking up"
            : "Your company is waking up"}
        </span>
      </header>
      <div
        aria-hidden="true"
        className="absolute top-[4.25rem] z-2 flex items-center gap-2"
        data-testid="onboarding-v2-progress"
      >
        {steps.map((step, index) => (
          <span
            className={cn(
              "h-1 rounded-full transition-all duration-200",
              index === stepIndex && "w-9 bg-primary",
              index < stepIndex && "w-4 bg-primary/50",
              index > stepIndex && "w-4 bg-foreground/15",
            )}
            key={step}
          />
        ))}
      </div>
      <section className="relative z-1 w-full max-w-xl">
        <div className="rounded-3xl border border-border/70 bg-card/85 p-7 shadow-[0_18px_50px_rgb(0_0_0/0.06)] backdrop-blur-sm">
          {children}
        </div>
      </section>
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
    <div
      className="mt-7 flex items-center gap-4 rounded-2xl border border-border/60 bg-background p-5"
      role="status"
    >
      <span
        aria-hidden="true"
        className="h-7 w-7 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none"
      />
      <div>
        <strong className="block text-sm font-semibold">{label}</strong>
        {detail ? (
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
