/** Pending authentication for one native relay socket connection. */
export type RelaySessionAuthRequest = {
  pendingEventId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
};
