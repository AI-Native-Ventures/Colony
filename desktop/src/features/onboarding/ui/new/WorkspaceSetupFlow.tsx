// desktop/src/features/onboarding/ui/new/WorkspaceSetupFlow.tsx
import * as React from "react";

import {
  hasLegacyAutoConnectRecovery,
  restoreLegacyAutoConnectedCommunity,
} from "@/features/communities/communityStorage";
import { HostedCommunityOnboarding } from "@/features/communities/ui/HostedCommunityOnboarding";
import {
  type FirstCommunityPage,
  useCommunityOnboarding,
} from "@/features/onboarding/communityOnboarding";
import { OnboardingFooterProvider } from "@/features/onboarding/ui/OnboardingFooter";
import { useIdentityQuery } from "@/shared/api/hooks";
import { pubkeyToNpub } from "@/shared/lib/nostrUtils";
import { useSystemColorScheme } from "@/shared/theme/useSystemColorScheme";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

import { MachineCanvas } from "./MachineCanvas";
import { JoinWorkspaceScreen } from "./screens/JoinWorkspaceScreen";
import { WorkspaceChoiceScreen } from "./screens/WorkspaceChoiceScreen";

type WorkspaceSetupPage = "welcome" | "existing" | "join" | "member" | "owned";

type Props = {
  /** Restored after cancelling a transaction that started on that page. */
  initialPage?: FirstCommunityPage;
  /** Absent when there is nowhere behind this screen to go back to. */
  onBack?: () => void;
  /**
   * Starts the canvas founder walk for this identity. Absent only before the
   * identity resolves, which is also when nothing here can be clicked yet.
   */
  onCreateCommunity?: () => void;
};

/**
 * Everything before a first community exists, on the canvas.
 *
 * The screens are detours off the landing screen rather than steps of the
 * machine sequence, so they keep the landing hue and show no step marker:
 * a count here would promise a walk that does not exist.
 */
export function WorkspaceSetupFlow({
  initialPage,
  onBack,
  onCreateCommunity,
}: Props) {
  const [page, setPage] = React.useState<WorkspaceSetupPage>(
    initialPage ?? "welcome",
  );
  const communityOnboarding = useCommunityOnboarding();
  const identityQuery = useIdentityQuery();
  const systemColorScheme = useSystemColorScheme();
  const activePubkey = identityQuery.data?.pubkey;
  const npub = activePubkey ? pubkeyToNpub(activePubkey) : "";
  const npubError = identityQuery.error
    ? identityQuery.error instanceof Error
      ? identityQuery.error.message
      : "Could not load your public key."
    : null;
  const canRestorePreviousCommunity =
    hasLegacyAutoConnectRecovery(activePubkey);

  // Which page the transaction was started from decides where a cancel comes
  // back to, and whether this identity is treated as the community's owner.
  const firstCommunityPage: FirstCommunityPage =
    page === "member" ? "member" : "join";

  const startConnection = React.useCallback(
    (relayUrl: string) => {
      communityOnboarding.start({
        source: "first-community",
        firstCommunityPage,
        relayUrl,
      });
    },
    [communityOnboarding, firstCommunityPage],
  );

  const redeemInvite = React.useCallback(
    (relayUrl: string, code: string, policyReceipt?: string) => {
      communityOnboarding.start({
        source: "first-community",
        firstCommunityPage,
        relayUrl,
        inviteCode: code,
        policyReceipt,
      });
    },
    [communityOnboarding, firstCommunityPage],
  );

  if (page === "owned") {
    // Creating or reclaiming a hosted community still runs the previous
    // screen, in the shell it was drawn for. The canvas first run replaces
    // it in its own commit; dropping it onto the canvas in the meantime
    // would leave a pastel card floating on a coloured field.
    return (
      <div
        className="buzz-onboarding-neutral-theme buzz-startup-shell flex h-dvh items-start justify-center overflow-y-auto bg-background px-4 pb-36 pt-[106px] text-foreground"
        data-system-color-scheme={systemColorScheme}
      >
        <StartupWindowDragRegion />
        <OnboardingFooterProvider>
          <div className="relative flex min-h-0 w-full max-w-[920px] flex-1 flex-col items-center text-center">
            <HostedCommunityOnboarding onBack={() => setPage("welcome")} />
          </div>
        </OnboardingFooterProvider>
      </div>
    );
  }

  return (
    <MachineCanvas
      showStep={false}
      step="identity"
      testId="workspace-setup-gate"
    >
      <StartupWindowDragRegion />
      {page === "welcome" ? (
        <WorkspaceChoiceScreen
          mode="welcome"
          onBack={onBack}
          onChoose={(choice) => {
            if (choice === "create") {
              // Creating is the founder walk, not a form: it names the
              // company, claims the address and sets the agents up.
              if (onCreateCommunity) onCreateCommunity();
              else setPage("owned");
              return;
            }
            setPage(choice === "existing" ? "existing" : "join");
          }}
          onRestorePrevious={
            canRestorePreviousCommunity
              ? () => {
                  if (
                    activePubkey &&
                    restoreLegacyAutoConnectedCommunity(activePubkey)
                  ) {
                    window.location.reload();
                  }
                }
              : undefined
          }
        />
      ) : page === "existing" ? (
        <WorkspaceChoiceScreen
          mode="existing"
          onBack={() => setPage("welcome")}
          onChoose={(choice) =>
            setPage(choice === "owner" ? "owned" : "member")
          }
        />
      ) : (
        <JoinWorkspaceScreen
          error={null}
          isRedeeming={false}
          mode={page}
          npub={npub}
          npubError={npubError}
          onBack={() => setPage(page === "member" ? "existing" : "welcome")}
          onConnect={startConnection}
          onRedeem={redeemInvite}
        />
      )}
    </MachineCanvas>
  );
}
