// desktop/src/features/onboarding/ui/new/WorkspaceSetupFlow.tsx
import * as React from "react";

import {
  hasLegacyAutoConnectRecovery,
  restoreLegacyAutoConnectedCommunity,
} from "@/features/communities/communityStorage";
import {
  type FirstCommunityPage,
  useCommunityOnboarding,
} from "@/features/onboarding/communityOnboarding";
import { useIdentityQuery } from "@/shared/api/hooks";
import { pubkeyToNpub } from "@/shared/lib/nostrUtils";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

import { MachineCanvas } from "./MachineCanvas";
import { JoinWorkspaceScreen } from "./screens/JoinWorkspaceScreen";
import {
  OwnedCommunitiesScreen,
  type OwnedCommunityRow,
} from "./screens/OwnedCommunitiesScreen";
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

  /**
   * Reconnect a community this key owns.
   *
   * `owned` is the page's own source of truth about the owner: a transaction
   * started from here is owner-led, which is what decides whether this device
   * writes its agent defaults during the walk.
   */
  const [ownedError, setOwnedError] = React.useState<string | null>(null);
  const connectOwnedCommunity = React.useCallback(
    (row: OwnedCommunityRow) => {
      setOwnedError(null);
      const started = communityOnboarding.start({
        source: "first-community",
        firstCommunityPage: "owned",
        relayUrl: row.relayUrl,
        communityName: row.name,
      });
      if (!started) {
        setOwnedError(
          "Onboarding is already in progress for another community. Finish or cancel that one, then connect this community.",
        );
      }
    },
    [communityOnboarding],
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
      ) : page === "owned" ? (
        <OwnedCommunitiesScreen
          error={ownedError}
          onBack={() => setPage("welcome")}
          onConnect={connectOwnedCommunity}
          onCreate={onCreateCommunity}
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
