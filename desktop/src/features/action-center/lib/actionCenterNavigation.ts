import { getThreadReference } from "@/features/messages/lib/threading";
import { resolveReminderDestination } from "@/features/reminders/lib/reminderNavigation";
import type { ActionItem } from "../contracts";

export type ActionCenterMessageDestination = {
  channelId: string;
  messageId: string;
  threadRootId: string | null;
};

export function actionCenterSourceDestination(
  item: ActionItem,
): ActionCenterMessageDestination | null {
  if (item.source.kind === "ask") {
    if (!item.source.ask.channelId || !item.source.ask.threadId) return null;
    return {
      channelId: item.source.ask.channelId,
      messageId: item.source.ask.threadId,
      threadRootId: item.source.ask.threadId,
    };
  }
  if (item.source.kind === "block") {
    const channelId = item.source.item.channelId;
    if (!channelId) return null;
    return {
      channelId,
      messageId: item.source.item.id,
      threadRootId: item.source.threadRootId,
    };
  }
  if (item.source.kind === "ping") {
    return {
      channelId: item.source.ping.channelId,
      messageId: item.source.ping.id,
      threadRootId: item.source.ping.threadId,
    };
  }
  return null;
}

export async function reminderSourceDestination(item: ActionItem) {
  if (item.source.kind !== "reminder") return null;
  return resolveReminderDestination(item.source.reminder.content.target);
}

export function threadRootForMessage(tags: readonly string[][]): string | null {
  return getThreadReference(tags.map((tag) => [...tag])).rootId;
}
