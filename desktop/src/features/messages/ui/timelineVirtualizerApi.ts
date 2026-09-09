export type TimelineVirtualizerApi = {
  cancelBottomIntent: (reason?: "navigation" | "scroll") => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  settleAtBottom: () => void;
  scrollToMessage: (
    messageId: string,
    options?: { behavior?: ScrollBehavior },
  ) => boolean;
};
