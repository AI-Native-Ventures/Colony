import { listen } from "@/shared/api/nativeBridge";
import { useEffect } from "react";
import { toast } from "sonner";

const MIGRATION_TOAST_KEY = "buzz-legacy-nest-migrated-notified";

interface StuckEventSyncPayload {
  kind: number;
  d_tag: string;
  error: string;
}

/**
 * Surface nest-related backend events as toasts.
 *
 * - `repos-dir-error`: a configured `repos_dir` failed to validate or its
 *   symlink could not be applied (invalid path, downgrade refused, external
 *   target gone). Emitted by `apply_workspace` on both the validate-reject
 *   and the runtime symlink-failure paths, so a bad `repos_dir` is always
 *   visibly surfaced rather than silently logged to console.
 * - `legacy-nest-migrated`: the agent's knowledge was carried over from a
 *   legacy `~/.sprout` nest. Shown once per machine (deduped via
 *   localStorage); the backend re-emits each launch while `~/.sprout` exists,
 *   which also covers the event being emitted before this listener mounts.
 * - `event-sync-stuck`: a retained persona/team/agent event has been refused
 *   by the relay for 3 consecutive 30s sweeps (~90s). Before this, a
 *   permanently refused event and an unreachable relay looked identical from
 *   the UI — both just logged to a console the user never opens — which is
 *   why a stuck coordination team (kind 30176) could sit failing silently
 *   until every chat Task in the community broke with "missing reference in
 *   task.owningTeamId" and nothing on screen explained why.
 *
 * Mounted at the app root ahead of the community-init effect so the listener
 * is registered before the first `apply_workspace` call.
 */
export function useNestNotifications(): void {
  useEffect(() => {
    const unlistenReposError = listen<string>("repos-dir-error", (event) => {
      toast.error("Repos directory not applied", {
        description: event.payload,
      });
    });

    const unlistenMigrated = listen("legacy-nest-migrated", () => {
      if (localStorage.getItem(MIGRATION_TOAST_KEY) === "true") {
        return;
      }
      localStorage.setItem(MIGRATION_TOAST_KEY, "true");
      toast.success("Migrated notes from ~/.sprout", {
        description: "You can delete it to reclaim disk space.",
      });
    });

    const unlistenSyncStuck = listen<StuckEventSyncPayload>(
      "event-sync-stuck",
      (event) => {
        toast.error("Couldn't sync to the relay", {
          description: `${event.payload.d_tag}: ${event.payload.error}`,
        });
      },
    );

    return () => {
      void unlistenReposError.then((fn) => fn());
      void unlistenMigrated.then((fn) => fn());
      void unlistenSyncStuck.then((fn) => fn());
    };
  }, []);
}
