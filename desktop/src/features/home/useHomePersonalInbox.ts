import * as React from "react";

import { useReportingLineLookup } from "@/features/agents/reportingLine";
import {
  askRoutingSummary,
  classifyAskRouting,
  effectiveFilerPubkey,
} from "@/features/asks/lib/askRouting";
import { askToInboxItem } from "@/features/asks/lib/askInboxItem";
import { useOpenAsks } from "@/features/asks/useOpenAsks";
import { useHomeDrafts } from "@/features/home/useHomeDrafts";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import {
  countDueReminders,
  useRemindersQuery,
} from "@/features/reminders/hooks";
import { groupReminders } from "@/features/reminders/lib/reminderFilters";

type UseHomePersonalInboxOptions = {
  allowMixedSelection: boolean;
  currentPubkey?: string;
  isDrafts: boolean;
  isNarrowHomeViewport: boolean;
  isReminders: boolean;
  viewportWidthPx: number;
};

export function useHomePersonalInbox({
  allowMixedSelection,
  currentPubkey,
  isDrafts,
  isNarrowHomeViewport,
  isReminders,
  viewportWidthPx,
}: UseHomePersonalInboxOptions) {
  const remindersQuery = useRemindersQuery(currentPubkey);
  const openAsks = useOpenAsks();
  const askPubkeys = React.useMemo(
    () => [...new Set(openAsks.asks.map((ask) => ask.filerPubkey))],
    [openAsks.asks],
  );
  const askProfilesQuery = useUsersBatchQuery(askPubkeys, {
    enabled: askPubkeys.length > 0,
  });
  const askProfiles = askProfilesQuery.data?.profiles;
  // How each ask reached the owner: the filer's manager as the reporting
  // lines resolve it decides auto-routed vs explicitly addressed.
  const { activeCommunity } = useCommunities();
  const { lookup: reportingLineLookup } = useReportingLineLookup(
    activeCommunity?.id ?? "",
  );
  const askItems = React.useMemo(
    () =>
      openAsks.asks.map((ask) => {
        const routing = classifyAskRouting(
          ask,
          reportingLineLookup(effectiveFilerPubkey(ask)).managerPubkey,
        );
        return askToInboxItem(
          ask,
          resolveUserLabel({
            currentPubkey,
            profiles: askProfiles,
            pubkey: ask.filerPubkey,
          }),
          askRoutingSummary(routing),
        );
      }),
    [askProfiles, currentPubkey, openAsks.asks, reportingLineLookup],
  );
  const dueReminderCount = countDueReminders(remindersQuery.data ?? []);
  const pendingReminders = React.useMemo(
    () =>
      groupReminders(remindersQuery.data ?? []).flatMap(
        (group) => group.reminders,
      ),
    [remindersQuery.data],
  );
  const [selectedReminderId, selectReminder] = React.useState<string | null>(
    null,
  );
  const selectedReminder =
    pendingReminders.find((reminder) => reminder.id === selectedReminderId) ??
    null;

  React.useEffect(() => {
    const selectionEnabled = isReminders || allowMixedSelection;
    if (!selectionEnabled) {
      selectReminder(null);
      return;
    }
    if (
      selectedReminderId !== null &&
      !pendingReminders.some((reminder) => reminder.id === selectedReminderId)
    ) {
      selectReminder(null);
      return;
    }
    if (!isReminders) return;
    if (viewportWidthPx === 0 || selectedReminder !== null) return;
    selectReminder(
      isNarrowHomeViewport ? null : (pendingReminders[0]?.id ?? null),
    );
  }, [
    allowMixedSelection,
    isNarrowHomeViewport,
    isReminders,
    pendingReminders,
    selectedReminderId,
    selectedReminder,
    viewportWidthPx,
  ]);

  // Drafts are only listed (and selectable) under the dedicated Drafts
  // filter — they never appear in the mixed All view.
  const drafts = useHomeDrafts({
    autoSelect: isDrafts,
    isNarrowHomeViewport,
    selectionEnabled: isDrafts,
    viewportWidthPx,
  });

  return {
    askItems,
    drafts,
    dueReminderCount,
    pendingReminders,
    reminders: {
      selectedId: selectedReminderId,
      selectedItem: selectedReminder,
      select: selectReminder,
    },
  };
}
