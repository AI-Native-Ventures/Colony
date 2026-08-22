// desktop/src/features/onboarding/ui/new/screens/InstallScreen.tsx
import { Button } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";
import { WalkingAnt } from "../WalkingAnt";

export type InstallState = "running" | "failed" | "degraded" | "done";

export type InstallEvent =
  | { type: "succeeded" }
  | { type: "failed" }
  | { type: "retry" }
  | { type: "skip" };

export function nextInstallState(
  current: InstallState,
  event: InstallEvent,
): InstallState {
  switch (event.type) {
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "retry":
      return "running";
    case "skip":
      return "degraded";
    default:
      return current;
  }
}

type Props = {
  state: InstallState;
  onRetry: () => void;
  onContinueAnyway: () => void;
};

export function InstallScreen({ state, onRetry, onContinueAnyway }: Props) {
  if (state === "failed") {
    return (
      <div className="onb-screen" data-solo="true">
        <div className="onb-col-head">
          <h1 className="onb-headline">That did not work.</h1>
          <p className="onb-sub">
            We could not finish setting up your agent. Check your internet
            connection and try again.
          </p>
        </div>
        <div className="onb-actions">
          <Button size="lg" onClick={onRetry}>
            Try again
          </Button>
          <button
            type="button"
            className="onb-quiet-action"
            onClick={onContinueAnyway}
          >
            Continue without it for now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="onb-screen" data-solo="true">
      <div className="onb-col-head">
        <h1 className="onb-headline">Setting up your agent.</h1>
        <p className="onb-sub">
          Colony is putting an agent to work for you. Nothing for you to do.
        </p>
      </div>
      <div className="onb-install">
        <WalkingAnt className="onb-install-ant" />
        <Progress value={null} />
      </div>
    </div>
  );
}
