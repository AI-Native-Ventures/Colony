import { useEffect, useRef, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { toast } from "sonner";
import { useIdentityQuery } from "@/shared/api/hooks";
import { DropdownMenuItem } from "@/shared/ui/dropdown-menu";
import { useCommunityOnboarding } from "@/features/onboarding/communityOnboarding";
import { assertFirstJobScope } from "@/features/onboarding/firstJobScope";
import {
  hostedCommunityRelayUrl,
  listColonyCommunities,
} from "../hostedCommunityApi";
import type { Community } from "../types";

/** Owner-only recovery for businesses older builds incorrectly marked complete. */
export function FinishBusinessSetup({
  community,
  plain = false,
  onOpen,
}: {
  community: Community | null;
  plain?: boolean;
  onOpen: () => void;
}) {
  const identity = useIdentityQuery();
  const ownerPubkey = identity.data?.pubkey;
  const relayUrl = community?.relayUrl;
  const onboarding = useCommunityOnboarding();
  const [verifiedScope, setVerifiedScope] = useState<string | null>(null);
  const key = JSON.stringify([ownerPubkey, relayUrl]);
  const latest = useRef(key);
  latest.current = key;
  useEffect(() => {
    if (!ownerPubkey || !relayUrl) return;
    let cancelled = false;
    const scope = { ownerPubkey, relayUrl };
    void (async () => {
      await assertFirstJobScope(scope);
      const mine = await listColonyCommunities();
      await assertFirstJobScope(scope);
      if (
        !cancelled &&
        mine.owner_pubkey === ownerPubkey &&
        mine.communities?.some(
          (entry) =>
            !entry.archived_at && hostedCommunityRelayUrl(entry) === relayUrl,
        )
      )
        setVerifiedScope(key);
    })().catch(() => {
      /* Unverified members never receive an owner setup action. */
    });
    return () => {
      cancelled = true;
    };
  }, [ownerPubkey, relayUrl, key]);
  if (!community || !ownerPubkey || !relayUrl || verifiedScope !== key)
    return null;
  const open = async () => {
    try {
      await assertFirstJobScope({ ownerPubkey, relayUrl });
      if (latest.current !== key) return;
      if (
        !onboarding.start({
          source: "create-community",
          ownerPubkey,
          relayUrl,
          communityName: community.name,
        })
      )
        throw new Error(
          "Finish the community connection already in progress, then try again.",
        );
      onOpen();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not reopen business setup.",
      );
    }
  };
  const content = (
    <>
      <ClipboardCheck className="h-4 w-4" />
      <span>Finish business setup</span>
    </>
  );
  return plain ? (
    <button
      className="flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted/50"
      data-testid="finish-business-setup"
      onClick={() => void open()}
      role="menuitem"
      type="button"
    >
      {content}
    </button>
  ) : (
    <DropdownMenuItem
      data-testid="finish-business-setup"
      onSelect={(event) => {
        event.preventDefault();
        void open();
      }}
    >
      {content}
    </DropdownMenuItem>
  );
}
