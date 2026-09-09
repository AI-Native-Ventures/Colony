import { parseCompanyReceipt } from "@/features/company/workRepository";
import type { RelayEvent } from "@/shared/api/types";
import type {
  CompanyActionOutcome,
  CompanyReceipt,
} from "@/features/company/workRepository";
import { FirstJobTaskRefused } from "./firstJobDispatch";

/** A failure authorizes another preparation only when the relay signed this exact request's outcome. */
export function readFirstJobTaskReceipt(
  action: RelayEvent,
  event: RelayEvent | null,
  relayPubkey: string,
) {
  const receipt = event && parseCompanyReceipt(event, relayPubkey, action.id);
  const tuple = action.tags.find((tag) => tag[0] === "company-action");
  const recipient = event?.tags.filter((tag) => tag[0] === "p");
  if (
    !receipt ||
    receipt.requestId !== tuple?.[3]?.toLowerCase() ||
    receipt.idempotencyKey !== tuple?.[4]?.toLowerCase() ||
    receipt.target !== action.tags.find((tag) => tag[0] === "a")?.[1] ||
    recipient?.length !== 1 ||
    recipient[0]?.[1] !== action.pubkey
  )
    return null;
  return receipt;
}

/** Recover accepted work before attempting to republish an action that may have expired. */
export async function resolveFirstJobTaskHead(
  actionId: string,
  deps: {
    readReceipt(): Promise<CompanyReceipt | null>;
    submit(): Promise<CompanyActionOutcome>;
  },
): Promise<string> {
  const appliedHead = async () => {
    const receipt = await deps.readReceipt();
    if (!receipt) return null;
    if (receipt.outcome !== "applied") throw new FirstJobTaskRefused(actionId);
    return receipt.headEventId;
  };
  const existing = await appliedHead();
  if (existing) return existing;
  let outcome: CompanyActionOutcome;
  try {
    outcome = await deps.submit();
  } catch (error) {
    const recovered = await appliedHead();
    if (recovered) return recovered;
    throw error;
  }
  if (outcome.status === "applied") return outcome.headEventId;
  if (outcome.status === "superseded" && outcome.winnerEventId !== actionId)
    throw new Error(
      "This job was started from another window or device. Check this thread for its progress; another instruction has not been sent.",
    );
  const recovered = await appliedHead();
  if (recovered) return recovered;
  throw new Error(
    outcome.status === "superseded"
      ? "The task receipt has not arrived yet. Retry this saved request."
      : outcome.message,
  );
}
