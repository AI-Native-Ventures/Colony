import { invokeTauri } from "@/shared/api/tauri";

type RawOutreachSendOutcome =
  | {
      status: "sent";
      sent_at: number;
      to: string;
      subject: string;
    }
  | { status: "failed"; failure_reason: string };

export type OutreachSendOutcome =
  | { status: "sent"; sentAt: number; to: string; subject: string }
  | { status: "failed"; failureReason: string };

export type OutreachSendPayload = {
  destination: string;
  content: { subject: string; body: string };
};

/**
 * Run the approved outreach email through the owner's own open Gmail tab.
 *
 * The card's recipient, subject, and body travel verbatim: what the owner
 * read on the card is what Gmail sends.
 */
export async function executeOutreachSend(input: {
  instanceEventId: string;
  actionEventId: string;
  data: OutreachSendPayload;
}): Promise<OutreachSendOutcome> {
  const result = await invokeTauri<RawOutreachSendOutcome>(
    "execute_outreach_send",
    {
      instanceEventId: input.instanceEventId,
      actionEventId: input.actionEventId,
      data: input.data,
    },
  );
  return result.status === "sent"
    ? {
        status: "sent",
        sentAt: result.sent_at,
        to: result.to,
        subject: result.subject,
      }
    : { status: "failed", failureReason: result.failure_reason };
}
