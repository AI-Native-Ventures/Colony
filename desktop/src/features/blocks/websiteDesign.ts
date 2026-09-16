import { verifyEvent } from "nostr-tools/pure";
import type { TimelineMessage } from "@/features/messages/types";
import type { BlockInstanceRef } from "./contracts";
import { parseBlockAction } from "./blockTags";

/** Facts signed by the owner for design review; never publication permission. */
export function websiteDesignInput(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const bundle = value.website_bundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
    return null;
  const digest = (bundle as Record<string, unknown>).sha256;
  if (
    value.status !== "ready-for-review" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(digest)
  )
    return null;
  return {
    scope: "design-only",
    revision: value.revision,
    manifest_sha256: digest,
  };
}

/** Find the designated decision maker's signed approval of this exact instance. */
export function websiteDesignDecision(
  message: TimelineMessage,
  instance: BlockInstanceRef,
  data: unknown,
): string | null {
  const expected = websiteDesignInput(data);
  if (!expected || !instance.decisionMakerPubkey || !instance.processorPubkey)
    return null;
  for (const event of message.blockState?.actions ?? []) {
    const parsed = parseBlockAction(event.tags);
    if (
      event.kind !== 40010 ||
      event.pubkey !== instance.decisionMakerPubkey ||
      !parsed.ok ||
      parsed.value.actionId !== "artifact.approve-design" ||
      parsed.value.instanceEventId !== message.id ||
      parsed.value.instanceId !== instance.instanceId ||
      parsed.value.manifestId !== instance.manifestId ||
      parsed.value.processorPubkey !== instance.processorPubkey
    )
      continue;
    try {
      const input = JSON.parse(event.content);
      if (
        input.scope !== expected.scope ||
        input.revision !== expected.revision ||
        input.manifest_sha256 !== expected.manifest_sha256
      )
        continue;
      if (
        verifyEvent({
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags.map((tag) => [...tag]),
          content: event.content,
          sig: event.sig,
        })
      )
        return event.id;
    } catch {
      /* Malformed or unsigned events cannot establish approval. */
    }
  }
  return null;
}
