import * as React from "react";

/**
 * Thread follow state for the shell: whether a thread still notifies, and the
 * two actions that pair follow with unmute and unfollow with mute so the two
 * stores can never disagree. Split out of `AppShell.tsx` for the desktop
 * file-size ratchet.
 */
export function useThreadFollowActions({
  authoredRootIds,
  followThread,
  followedRootIds,
  mentionedRootIds,
  muteThread,
  mutedRootIds,
  participatedRootIds,
  unfollowThread,
  unmuteThread,
}: {
  authoredRootIds: ReadonlySet<string>;
  followThread: (rootId: string) => void;
  followedRootIds: ReadonlySet<string>;
  mentionedRootIds: ReadonlySet<string>;
  muteThread: (rootId: string) => void;
  mutedRootIds: ReadonlySet<string>;
  participatedRootIds: ReadonlySet<string>;
  unfollowThread: (rootId: string) => void;
  unmuteThread: (rootId: string) => void;
}) {
  const isNotifiedForThread = React.useCallback(
    (rootId: string) =>
      !mutedRootIds.has(rootId) &&
      (followedRootIds.has(rootId) ||
        participatedRootIds.has(rootId) ||
        authoredRootIds.has(rootId) ||
        mentionedRootIds.has(rootId)),
    [
      authoredRootIds,
      followedRootIds,
      mentionedRootIds,
      mutedRootIds,
      participatedRootIds,
    ],
  );

  const handleFollowThread = React.useCallback(
    (rootId: string) => {
      followThread(rootId);
      unmuteThread(rootId);
    },
    [followThread, unmuteThread],
  );

  const handleUnfollowThread = React.useCallback(
    (rootId: string) => {
      unfollowThread(rootId);
      muteThread(rootId);
    },
    [muteThread, unfollowThread],
  );

  return { handleFollowThread, handleUnfollowThread, isNotifiedForThread };
}
