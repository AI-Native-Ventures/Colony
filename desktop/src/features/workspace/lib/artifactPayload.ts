export type ArtifactPayload = {
  content: string;
  reference: string;
  sourceEventId: string | null;
  sourceKind: "event" | "text";
};

/** Validate a persisted read-only artifact tab payload. */
export function readArtifactPayload(payload: unknown): ArtifactPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.content !== "string" ||
    typeof value.reference !== "string" ||
    (value.sourceEventId !== null && typeof value.sourceEventId !== "string") ||
    (value.sourceKind !== "event" && value.sourceKind !== "text")
  ) {
    return null;
  }
  return value as ArtifactPayload;
}

export function taskArtifactPayload(input: ArtifactPayload): ArtifactPayload {
  return input;
}
