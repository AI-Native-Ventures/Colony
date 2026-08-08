import * as React from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";

import {
  checkColonyCommunityName,
  createColonyCommunity,
  hostedCommunityRelayUrl,
  listColonyCommunities,
  VALID_HOSTED_COMMUNITY_NAME,
} from "@/features/communities/hostedCommunityApi";
import { useColonyProvisioning } from "@/features/communities/useColonyProvisioning";
import { useCommunityOnboarding } from "@/features/onboarding/communityOnboarding";
import {
  CHANNEL_FORM_FIELD_CONTROL_CLASS,
  CHANNEL_FORM_FIELD_SHELL_CLASS,
} from "@/features/channels/ui/channelFormStyles";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

type HostedCommunityCreateFlowProps = {
  onComplete: () => void;
};

/**
 * Create a community on the connected Colony relay.
 *
 * The relay's `/api/communities` surface authenticates the request with the
 * local identity's NIP-98 signature, so there is no separate sign-in or
 * identity-binding step: if you belong to the community you're connected
 * to, you can create new ones and you become their owner.
 */
export function HostedCommunityCreateFlow({
  onComplete,
}: HostedCommunityCreateFlowProps) {
  const onboarding = useCommunityOnboarding();
  const provisioning = useColonyProvisioning();
  const [ownedCount, setOwnedCount] = React.useState<number | null>(null);
  const [name, setName] = React.useState("");
  const [availability, setAvailability] = React.useState<boolean | null>(null);
  const [checkingName, setCheckingName] = React.useState(false);
  const [action, setAction] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    void listColonyCommunities()
      .then((response) => {
        if (!active) return;
        const live = (response.communities ?? []).filter(
          (community) => !community.archived_at,
        );
        setOwnedCount(live.length);
      })
      .catch(() => {
        // Non-fatal: the relay enforces the limit either way; the count only
        // improves the upfront message.
        if (active) setOwnedCount(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const normalizedName = name.trim().toLowerCase();
  const validName =
    normalizedName.length <= 63 &&
    VALID_HOSTED_COMMUNITY_NAME.test(normalizedName);
  const atCommunityLimit =
    ownedCount !== null && ownedCount >= provisioning.maxPerOwner;
  // A relay with no provisioning domain rejects every create.
  const canCreate = provisioning.selfServe;

  React.useEffect(() => {
    // A relay that cannot provision 404s this per keystroke; do not ask.
    if (!canCreate || !normalizedName || !validName) {
      setCheckingName(false);
      return;
    }
    let cancelled = false;
    setCheckingName(true);
    const handle = window.setTimeout(() => {
      void checkColonyCommunityName(normalizedName)
        .then((response) => {
          if (!cancelled) setAvailability(response.available ?? false);
        })
        .catch(() => {
          if (!cancelled) setAvailability(null);
        })
        .finally(() => {
          if (!cancelled) setCheckingName(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [canCreate, normalizedName, validName]);

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate || !validName || atCommunityLimit || action) return;
    setAction("Creating community…");
    setError(null);
    void (async () => {
      try {
        const response = await createColonyCommunity(normalizedName);
        if (!response.community) {
          throw new Error("Could not create the community.");
        }
        const relayUrl = hostedCommunityRelayUrl(response.community);
        if (!relayUrl) {
          throw new Error(
            "The community was created, but the relay did not return its address. Add it from Add community with its URL.",
          );
        }
        const started = onboarding.start({
          source: "add-community",
          relayUrl,
          communityName: response.community.name ?? response.community.slug,
        });
        if (!started) {
          throw new Error(
            "Finish connecting the community already in progress, then try again.",
          );
        }
        onComplete();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message.startsWith("taken:")) setAvailability(false);
        setError(message);
      } finally {
        setAction(null);
      }
    })();
  };

  const feedback = provisioning.loading
    ? "Asking the relay for its community address…"
    : provisioning.unreachable
      ? "Could not reach the relay to check how it creates communities."
      : !canCreate
        ? "This relay does not offer self-serve community creation. Add an existing community with its URL instead."
        : atCommunityLimit
          ? `You’ve reached the limit of ${provisioning.maxPerOwner} hosted communities.`
          : name && !validName
            ? "Use lowercase letters, numbers, and single hyphens."
            : checkingName
              ? "Checking availability…"
              : availability === false
                ? "That address is already taken."
                : availability === true
                  ? "That address is available."
                  : "You can’t change this address after creating the community.";

  return (
    <form className="space-y-5" onSubmit={create}>
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="hosted-community-create-name"
        >
          Community address
        </label>
        <div
          className={cn(
            "flex min-h-11 items-center px-3",
            CHANNEL_FORM_FIELD_SHELL_CLASS,
          )}
        >
          <Input
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            className={cn(
              "h-8 min-w-0 px-0 py-0 leading-6",
              CHANNEL_FORM_FIELD_CONTROL_CLASS,
            )}
            data-testid="hosted-community-create-name"
            disabled={Boolean(action) || atCommunityLimit || !canCreate}
            id="hosted-community-create-name"
            maxLength={63}
            onChange={(event) => {
              setName(event.target.value.toLowerCase());
              setAvailability(null);
              setError(null);
            }}
            placeholder="north-star"
            spellCheck={false}
            value={name}
          />
          {provisioning.domain ? (
            <span
              className="shrink-0 text-sm text-muted-foreground/70"
              data-testid="hosted-community-create-suffix"
            >
              .{provisioning.domain}
            </span>
          ) : null}
        </div>
        <p
          className={cn(
            "text-xs leading-5",
            availability === false || (name && !validName)
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {feedback}
        </p>
      </div>
      {error ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm leading-5 text-destructive">{error}</p>
        </div>
      ) : null}
      <div className="flex justify-end pt-1">
        <Button
          data-testid="hosted-community-create-submit"
          disabled={
            !canCreate ||
            !validName ||
            availability === false ||
            checkingName ||
            Boolean(action) ||
            atCommunityLimit
          }
          type="submit"
        >
          {action ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          {action ?? "Create community"}
        </Button>
      </div>
    </form>
  );
}
