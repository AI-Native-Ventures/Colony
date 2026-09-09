import { splitStoredModel } from "../ui/modelEffortOptions";

export type ReplyModelSelection = { targetPubkey: string; modelId: string };

/** Only an advertised, exact model/effort pair may enter the signed request. */
export function replyModelTag(
  selection: ReplyModelSelection | null,
  recipientPubkeys: readonly string[],
  modelIds: readonly string[],
): string[] | undefined {
  if (!selection) return undefined;
  if (!recipientPubkeys.includes(selection.targetPubkey)) {
    throw new Error("Select a teammate who will receive this message.");
  }
  if (!modelIds.includes(selection.modelId)) {
    throw new Error(
      "That model and reasoning choice is unavailable. Choose again or use teammate defaults.",
    );
  }
  return ["agent-reply", "1", selection.targetPubkey, selection.modelId];
}

/** Normalize old and new catalog DTOs without adding provider capability facts. */
export function replyModelOptions(
  models: readonly { id: string; name?: string | null }[],
) {
  return models.map((model) => ({ ...model, ...splitStoredModel(model.id) }));
}

/** Recipients may change while an invite or upload is pending. Never reroute a pin. */
export function validateReplyModelRecipient(
  tags: readonly string[][] | undefined,
  recipients: readonly string[],
) {
  const request = tags?.find((tag) => tag[0] === "agent-reply");
  if (request && !recipients.includes(request[2])) {
    throw new Error(
      "The selected teammate was removed from this message. Restore the mention or send again using teammate defaults.",
    );
  }
}
