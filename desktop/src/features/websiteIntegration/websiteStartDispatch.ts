import type { WebsiteStartRequest } from "../website/types";

export type WebsiteStartScope = Pick<
  WebsiteStartRequest,
  "jobId" | "taskId" | "channel"
>;

/**
 * Dispatch one start request only while it still addresses the rendered job.
 *
 * The caller owns the transport. Keeping the scope check here makes the stale
 * request failure testable without mounting the attachment or contacting a
 * relay, and ensures a stale click cannot be reported as a successful start.
 */
export async function dispatchWebsiteStart(
  request: WebsiteStartRequest,
  expected: WebsiteStartScope,
  submit: () => Promise<unknown>,
): Promise<void> {
  if (
    request.jobId !== expected.jobId ||
    request.taskId !== expected.taskId ||
    request.channel !== expected.channel
  ) {
    throw new Error(
      "This website job changed before the start request could be sent. Refresh and try again.",
    );
  }
  await submit();
}
