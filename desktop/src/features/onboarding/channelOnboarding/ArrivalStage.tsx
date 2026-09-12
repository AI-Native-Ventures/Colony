import type {
  ScoutOnboardingDispatch,
  ScoutOnboardingState,
  ScoutRoute,
} from "./types";
import {
  ChoiceButton,
  ContextNote,
  InlineCard,
  ROUTE_LABELS,
  StageFrame,
  routeIcons,
} from "./shared";

const ROUTES: readonly ScoutRoute[] = ["new", "existing", "deciding"];

export function ArrivalStage({
  state,
  onChange,
}: {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
}) {
  const hasBusinessContext = Boolean(
    state.signupContext.businessName?.trim() ||
      state.signupContext.businessDescription?.trim(),
  );
  const hasWebsite = state.signupContext.websiteState === "provided";
  return (
    <StageFrame
      scoutMessage={
        <>
          Hi, I&apos;m Scout. Choose where to start and I&apos;ll ask one useful
          question at a time. Your answers stay editable before anything is set
          up.
        </>
      }
      state={state}
    >
      <InlineCard
        description="Pick the route that fits today. Choosing one does not create a business, add people, or start work."
        eyebrow="Choose a starting point"
        icon={routeIcons.new}
        title="Where should we begin?"
      >
        {hasBusinessContext ? (
          <ContextNote>
            <strong className="font-medium text-foreground">
              Earlier context is available for confirmation.
            </strong>{" "}
            {hasWebsite
              ? "Your business and website can be reused on the existing-business route."
              : "Your business details can be reused on the existing-business route."}
          </ContextNote>
        ) : null}
        <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
          {ROUTES.map((route) => {
            const Icon = routeIcons[route];
            const details =
              route === "new"
                ? "Choose a broad category, then describe the idea."
                : route === "existing"
                  ? "Reuse business details already supplied and confirm them."
                  : "Start with skills, experience, interests, and possibilities.";
            return (
              <ChoiceButton
                detail={details}
                icon={Icon}
                key={route}
                onClick={() => onChange({ type: "select-route", route })}
                testId={`scout-route-${route}`}
                title={ROUTE_LABELS[route]}
              />
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          You can change this route as you learn more.
        </p>
      </InlineCard>
    </StageFrame>
  );
}
