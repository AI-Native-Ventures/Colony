import { topChromeInset } from "@/shared/layout/chromeLayout";
import { UnreadPill, unreadCountLabel } from "@/shared/ui/UnreadPill";

/**
 * The floating "N new" pill that hovers over the top or bottom edge of the
 * sidebar's scroll area.
 *
 * It sits above the list rather than in it, so whatever renders the list must
 * reserve room for it at the end (`pb-9` on the sidebar's scroll content).
 * Without that reserve the last row sits underneath the pill: the pill wins
 * the hit test, and the row can neither be clicked nor dropped on — which is
 * exactly how a section drag released over the last header silently fails to
 * commit.
 */
export function MoreUnreadButton({
  bottomClassName = "bottom-0",
  count,
  label,
  onClick,
  position,
  testId,
}: {
  bottomClassName?: string;
  count: number;
  label?: string;
  onClick: () => void;
  position: "top" | "bottom";
  testId: string;
}) {
  const positionClassName =
    position === "top" ? topChromeInset.top : bottomClassName;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-10 flex justify-center py-1 ${positionClassName}`}
    >
      <UnreadPill
        direction={position === "top" ? "up" : "down"}
        emphasis="primary"
        label={label ?? unreadCountLabel(count)}
        onClick={onClick}
        testId={testId}
      />
    </div>
  );
}
