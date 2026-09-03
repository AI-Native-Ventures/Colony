import { useCommunityOnboarding } from "@/features/onboarding/communityOnboarding";
import { MachineCanvas } from "@/features/onboarding/ui/new/MachineCanvas";
import { Button } from "@/shared/ui/button";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

/**
 * Acknowledge a community deep link received before machine onboarding is
 * complete. The transaction is already persisted; claiming and connecting
 * wait until setup finishes so only the user's final identity is admitted.
 *
 * It covers the machine flow's own canvas, so it wears the same one: this is
 * the first thing an invited teammate sees of Colony, and a different design
 * on top of the setup they are halfway through reads as a different app.
 */
export function PendingInviteGate() {
  const { transaction, update, clear } = useCommunityOnboarding();

  if (!transaction) return null;

  return (
    <MachineCanvas
      className="z-50"
      showStep={false}
      step="identity"
      testId="pending-invite-gate"
    >
      <StartupWindowDragRegion />
      <div className="onb-screen" data-solo="true">
        <div className="onb-hero">
          <div className="onb-col-head">
            <h1 className="onb-headline">
              Opening a <em>community</em> link
            </h1>
            <p className="onb-sub">
              You will connect to {transaction.communityName} once setup is
              finished.
            </p>
          </div>
          <div className="onb-actions">
            <Button
              data-testid="pending-invite-continue"
              onClick={() => update({ acknowledged: true })}
              size="lg"
              type="button"
            >
              Continue setup
            </Button>
            <button
              className="onb-quiet-action"
              data-testid="pending-invite-cancel"
              onClick={clear}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </MachineCanvas>
  );
}
