import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  hostedCommunityRelayUrl,
  listColonyCommunities,
} from "@/features/communities/hostedCommunityApi";
import { useCommunityOnboarding } from "./communityOnboarding";
import { assertFirstJobScope } from "./firstJobScope";

/** Resume once when entering an owner's business; leaving the walk does not reopen it immediately. */
export function useBusinessOnboardingResume(
  ownerPubkey: string | null,
  relayUrl: string | undefined,
  ready: boolean,
): void {
  const onboarding = useCommunityOnboarding();
  const checked = useRef<string | null>(null);
  const latest = useRef(onboarding);
  latest.current = onboarding;
  useEffect(() => {
    if (!ownerPubkey || !relayUrl || !ready) return;
    const key = JSON.stringify([ownerPubkey, relayUrl]);
    if (checked.current === key) return;
    let cancelled = false;
    const scope = { ownerPubkey, relayUrl };
    void (async () => {
      await assertFirstJobScope(scope);
      if (cancelled) return;
      checked.current = key;
      const current = latest.current.transaction;
      if (
        current?.ownerPubkey === ownerPubkey &&
        (current.relayUrl === relayUrl ||
          current.stage === "connecting" ||
          current.stage === "claiming")
      )
        return;
      if (
        current?.source === "create-community" &&
        current.ownerPubkey &&
        current.relayUrl !== relayUrl
      )
        latest.current.suspend(current.id);
      if (latest.current.resume(ownerPubkey, relayUrl)) return;
      // An older build stored creation without its owner. Adopt only after the
      // current signed owner listing confirms this exact community.
      if (
        current?.source !== "create-community" ||
        current.ownerPubkey ||
        current.relayUrl !== relayUrl
      )
        return;
      const mine = await listColonyCommunities();
      await assertFirstJobScope(scope);
      if (cancelled || latest.current.transaction?.id !== current.id) return;
      if (
        mine.owner_pubkey !== ownerPubkey ||
        !mine.communities?.some(
          (entry) =>
            !entry.archived_at && hostedCommunityRelayUrl(entry) === relayUrl,
        )
      )
        return;
      latest.current.start({
        source: "create-community",
        ...scope,
        communityName: current.communityName,
      });
    })().catch((error) => {
      if (!cancelled)
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not restore business setup.",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [ownerPubkey, relayUrl, ready]);
}
