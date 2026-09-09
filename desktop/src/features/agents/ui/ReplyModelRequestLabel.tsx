import { splitStoredModel } from "./modelEffortOptions";

/** Signed request provenance, deliberately distinct from an applied/runtime receipt. */
export function ReplyModelRequestLabel({ tags }: { tags?: string[][] }) {
  const tag = tags?.find(
    (entry) =>
      entry[0] === "agent-reply" && entry[1] === "1" && entry.length === 4,
  );
  if (!tag) return null;
  const { baseId, effort } = splitStoredModel(tag[3]);
  return (
    <p
      data-testid="reply-model-request"
      className="mt-1 text-xs text-muted-foreground"
    >
      Requested for teammate reply: {baseId}
      {effort ? ` · reasoning ${effort}` : ""}
    </p>
  );
}
