import type { ReactNode } from "react";

import type {
  ScoutApproveSetup,
  ScoutOnboardingDispatch,
  ScoutOnboardingState,
  ScoutOnboardingSummary,
} from "./types";
import { cn } from "@/shared/lib/cn";
import { ArrivalStage } from "./ArrivalStage";
import {
  ExistingBusinessStage,
  ExistingFollowUpStage,
  ExistingPersonStage,
} from "./ExistingRouteStages";
import {
  DecidingBusinessStage,
  DecidingFollowUpStage,
  DecidingPersonStage,
} from "./DecidingRouteStages";
import {
  NewBusinessStageView,
  NewFollowUpStage,
  NewPersonStage,
} from "./NewRouteStages";
import { SetupStage, SettingUpStage, ReadyStage } from "./SetupStages";
import { UnderstandingStage } from "./UnderstandingStage";

/**
 * Controlled integration boundary for the Scout Welcome conversation fragment.
 *
 * The parent owns the reducer, persistence, relay/channel scope, and actual
 * setup write. This view only dispatches typed owner actions and consumes the
 * proof returned by the runtime callback.
 */
export type ScoutChannelOnboardingProps = {
  state: ScoutOnboardingState;
  onChange: ScoutOnboardingDispatch;
  onConfirm?: (summary: ScoutOnboardingSummary) => void;
  onApproveSetup: ScoutApproveSetup;
  /** Optional retry-specific runtime callback; it receives the same input snapshot. */
  onRetry?: ScoutApproveSetup;
  onContinueInWelcome?: () => void;
  className?: string;
};

export function ScoutChannelOnboarding({
  state,
  onChange,
  onConfirm,
  onApproveSetup,
  onRetry,
  onContinueInWelcome,
  className,
}: ScoutChannelOnboardingProps) {
  let content: ReactNode;
  if (state.stage === "arrival") {
    content = <ArrivalStage onChange={onChange} state={state} />;
  } else if (state.stage === "understanding") {
    content = (
      <UnderstandingStage
        onChange={onChange}
        onConfirm={onConfirm}
        state={state}
      />
    );
  } else if (state.stage === "setup") {
    content = (
      <SetupStage
        onApproveSetup={onApproveSetup}
        onChange={onChange}
        onRetry={onRetry}
        state={state}
      />
    );
  } else if (state.stage === "setting-up") {
    content = (
      <SettingUpStage
        onApproveSetup={onApproveSetup}
        onChange={onChange}
        onRetry={onRetry}
        state={state}
      />
    );
  } else if (state.stage === "ready") {
    content = (
      <ReadyStage onContinueInWelcome={onContinueInWelcome} state={state} />
    );
  } else if (state.route === "new") {
    content =
      state.stage === "person" ? (
        <NewPersonStage onChange={onChange} state={state} />
      ) : state.stage === "business" ? (
        <NewBusinessStageView onChange={onChange} state={state} />
      ) : (
        <NewFollowUpStage onChange={onChange} state={state} />
      );
  } else if (state.route === "existing") {
    content =
      state.stage === "person" ? (
        <ExistingPersonStage onChange={onChange} state={state} />
      ) : state.stage === "business" ? (
        <ExistingBusinessStage onChange={onChange} state={state} />
      ) : (
        <ExistingFollowUpStage onChange={onChange} state={state} />
      );
  } else {
    content =
      state.stage === "person" ? (
        <DecidingPersonStage onChange={onChange} state={state} />
      ) : state.stage === "business" ? (
        <DecidingBusinessStage onChange={onChange} state={state} />
      ) : (
        <DecidingFollowUpStage onChange={onChange} state={state} />
      );
  }

  return <div className={cn("w-full", className)}>{content}</div>;
}
