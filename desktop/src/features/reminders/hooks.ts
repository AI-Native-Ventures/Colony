import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import {
  cancelReminder,
  completeReminder,
  createReminder,
  fetchReminders,
  snoozeReminder,
} from "@/features/reminders/lib/reminderService";
import { countDue, isDue } from "@/features/reminders/lib/reminderFilters";
import type {
  Reminder,
  ReminderTarget,
} from "@/features/reminders/lib/reminderTypes";

export const remindersQueryKey = (pubkey: string, communityId?: string) =>
  communityId
    ? (["reminders", pubkey, communityId] as const)
    : (["reminders", pubkey] as const);

/** Re-exported so the inbox badge has one import for the due count. */
export const countDueReminders = countDue;

/**
 * The single source of truth for a user's reminders. Badge, channel overlay,
 * panel, and fire-on-due detection all read this one query, so invalidating it
 * (see {@link useReminderMutations}) keeps every surface consistent.
 */
export function useRemindersQuery(pubkey: string | undefined) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  return useQuery({
    enabled: Boolean(pubkey) && communityId !== "",
    queryKey: remindersQueryKey(pubkey ?? "", communityId),
    queryFn: () => fetchReminders(pubkey ?? ""),
    staleTime: 30_000,
  });
}

/**
 * The due-reminder contribution to the in-app Inbox nav badge, as relay event
 * ids rather than a count. Reminders are a separate stream from the feed badge
 * machinery, so they are folded in at the sidebar wiring point rather than
 * threaded through homeBadge.ts. The ids are what makes that fold correct: a
 * due reminder is also an open Action Center item, so a count could only be
 * added and would show one reminder as two.
 *
 * Reads the shared query above, so the useReminderNotifications poll's
 * invalidate keeps it live and `isDue` re-evaluates as reminders cross due.
 * The caller uses this raw (no isHomeActive suppression), mirroring the inbox
 * filter badge, which persists while the Inbox is open.
 *
 * `enabled` mirrors the homeBadgeEnabled contract: when the home badge toggle
 * is off, the feed contribution is empty, so the reminder contribution must be
 * too, otherwise a disabled badge would still show a reminder `(1)`.
 */
export function useDueReminderEventIds(
  pubkey: string | undefined,
  enabled: boolean,
): string[] {
  const remindersQuery = useRemindersQuery(pubkey);
  const reminders = remindersQuery.data;
  return React.useMemo(() => {
    if (!enabled) return [];
    const now = Math.floor(Date.now() / 1_000);
    return (reminders ?? [])
      .filter((reminder) => isDue(reminder, now))
      .map((reminder) => reminder.eventId);
  }, [enabled, reminders]);
}

/**
 * Wraps every reminder write so the shared query is invalidated on success —
 * the consistency spine the panel/badge/overlay all depend on. A mutation that
 * skipped invalidation would leave those surfaces stale until the next refetch.
 */
export function useReminderMutations(pubkey: string) {
  const { activeCommunity } = useCommunities();
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: remindersQueryKey(pubkey, activeCommunity?.id ?? ""),
    });

  const create = useMutation({
    mutationFn: (input: {
      target: ReminderTarget;
      notBefore: number;
      note?: string;
    }) => createReminder(input.target, input.notBefore, input.note),
    onSuccess: invalidate,
  });
  const complete = useMutation({
    mutationFn: (reminder: Reminder) => completeReminder(pubkey, reminder),
    onSuccess: invalidate,
  });
  const snooze = useMutation({
    mutationFn: (input: { reminder: Reminder; notBefore: number }) =>
      snoozeReminder(pubkey, input.reminder, input.notBefore),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: (reminder: Reminder) => cancelReminder(pubkey, reminder),
    onSuccess: invalidate,
  });

  return { create, complete, snooze, cancel };
}
