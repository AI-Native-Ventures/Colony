// desktop/src/features/onboarding/ui/new/screens/OwnedCommunitiesScreen.tsx
import { useEffect, useState } from "react";

import {
  type HostedCommunity,
  hostedCommunityRelayUrl,
  listColonyCommunities,
} from "@/features/communities/hostedCommunityApi";

export type OwnedCommunityRow = {
  key: string;
  name: string;
  host: string;
  relayUrl: string;
};

/**
 * The communities on this relay that this key can actually reconnect to.
 *
 * Archived ones are gone, and one whose host the relay did not return has no
 * address to connect to: offering either is offering a door that does not
 * open. Pure, so the rule is testable without a relay.
 */
export function ownedCommunityRows(
  communities: readonly HostedCommunity[],
): OwnedCommunityRow[] {
  return communities.flatMap((community, index) => {
    if (community.archived_at) return [];
    const relayUrl = hostedCommunityRelayUrl(community);
    if (!relayUrl) return [];
    return [
      {
        key: community.id ?? community.normalized_host ?? String(index),
        name: community.name ?? community.slug ?? "Hosted community",
        host: community.normalized_host ?? "",
        relayUrl,
      },
    ];
  });
}

type Props = {
  /** Connect the picked community, which starts the owner-led transaction. */
  onConnect: (row: OwnedCommunityRow) => void;
  /** Nothing to reconnect, or nothing they want: run the founder walk. */
  onCreate?: () => void;
  onBack: () => void;
  /** Why the last connect attempt did not work, in the user's words. */
  error?: string | null;
  /** A connect is in flight, so nothing else on the screen should start one. */
  busy?: boolean;
};

/**
 * "Reconnect a community you own", on the canvas.
 *
 * Replaces the reclaim half of the pastel `HostedCommunityOnboarding`. Its
 * other half asked for an address to create a new community, which is what
 * the founder walk does now, so this screen only lists and reconnects and
 * hands creating over to that walk.
 */
export function OwnedCommunitiesScreen({
  onConnect,
  onCreate,
  onBack,
  error = null,
  busy = false,
}: Props) {
  const [rows, setRows] = useState<OwnedCommunityRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listColonyCommunities()
      .then((response) => {
        if (active) setRows(ownedCommunityRows(response.communities ?? []));
      })
      .catch((cause: unknown) => {
        // An empty list and a relay that would not answer are different
        // things, and telling someone they own nothing when the question was
        // never answered is the worse of the two mistakes.
        if (!active) return;
        setRows([]);
        setLoadError(
          cause instanceof Error
            ? cause.message
            : "Could not ask this relay which communities you own.",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="onb-screen" data-testid="owned-communities">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Communities you <em>own</em>.
        </h1>
        <p className="onb-sub">
          Pick the one to reconnect. Your role and everything in it are exactly
          where you left them.
        </p>
      </div>
      <div
        aria-label="Communities you own"
        className="onb-options"
        role="listbox"
        tabIndex={-1}
      >
        {rows === null ? (
          <p className="onb-note" role="status">
            Asking this relay which communities you own.
          </p>
        ) : rows.length === 0 ? (
          <p className="onb-note">
            {loadError ??
              "This key does not own a community on this relay yet. Create one and it will be here next time."}
          </p>
        ) : (
          rows.map((row) => (
            <button
              aria-selected={false}
              className="onb-option"
              data-testid={`owned-community-${row.key}`}
              disabled={busy}
              key={row.key}
              onClick={() => onConnect(row)}
              role="option"
              type="button"
            >
              <span>
                <span className="onb-option__title">{row.name}</span>
                <span className="onb-option__meta">{row.host}</span>
              </span>
            </button>
          ))
        )}
        {error ? <p className="onb-note onb-note-warn">{error}</p> : null}
      </div>
      <div className="onb-actions">
        {onCreate ? (
          <button
            className="onb-quiet-action"
            data-testid="owned-communities-create"
            disabled={busy}
            onClick={onCreate}
            type="button"
          >
            Create a new one
          </button>
        ) : null}
        <button
          className="onb-quiet-action"
          data-testid="owned-communities-back"
          disabled={busy}
          onClick={onBack}
          type="button"
        >
          Back
        </button>
      </div>
    </div>
  );
}
