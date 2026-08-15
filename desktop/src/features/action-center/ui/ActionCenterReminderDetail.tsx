import type { Reminder } from "@/features/reminders/lib/reminderTypes";
import { ReminderDetailPane } from "@/features/reminders/ui/RemindersPanel";

export function ActionCenterReminderDetail({
  onBack,
  pubkey,
  reminder,
}: {
  onBack: () => void;
  pubkey: string;
  reminder: Reminder;
}) {
  return (
    <div data-testid="action-center-reminder-detail">
      <ReminderDetailPane onBack={onBack} pubkey={pubkey} reminder={reminder} />
    </div>
  );
}
