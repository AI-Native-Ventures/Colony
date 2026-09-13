/** A proof is tied to one owner request, never presence or startup alone. */
export type ProofFrame = {
  kind: string;
  turnId: string | null;
  channelId: string | null;
  payload: unknown;
};
export function responseProof(requestId: string, channelId: string) {
  const frames: ProofFrame[] = [];
  return {
    accept(frame: ProofFrame): "waiting" | "success" | "failed" {
      if (frame.channelId !== channelId) return "waiting";
      if (
        ![
          "turn_started",
          "turn_completed",
          "turn_error",
          "agent_panic",
          "acp_read",
        ].includes(frame.kind)
      )
        return "waiting";
      if (frames.length >= 1000) return "failed";
      frames.push(frame);
      const start = frames.find(
        (f) =>
          f.kind === "turn_started" &&
          (
            f.payload as { triggeringEventIds?: string[] }
          )?.triggeringEventIds?.includes(requestId),
      );
      if (!start?.turnId) return "waiting";
      const turn = frames.filter((f) => f.turnId === start.turnId);
      if (turn.some((f) => f.kind === "turn_error" || f.kind === "agent_panic"))
        return "failed";
      const ended = turn.some((f) => {
        if (f.kind !== "acp_read") return false;
        const p = f.payload as {
          result?: { stopReason?: string };
          message?: { result?: { stopReason?: string } };
        };
        return (
          (p?.result?.stopReason ?? p?.message?.result?.stopReason) ===
          "end_turn"
        );
      });
      return ended && turn.some((f) => f.kind === "turn_completed")
        ? "success"
        : "waiting";
    },
  };
}
