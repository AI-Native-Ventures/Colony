import type { RelayEvent } from "@/shared/api/types";

/** ACP subscribes from startup minus five seconds; old uncertain sends need owner review. */
export function assertFirstJobRetryCanReachReceiver(
  message: RelayEvent | null | undefined,
  nowSeconds: number,
) {
  if (message && nowSeconds - message.created_at > 5)
    throw new Error(
      "We could not confirm delivery of this earlier request. Check this thread before asking your team to continue. Colony will not start it again automatically.",
    );
}
