// desktop/src/features/onboarding/ui/new/screens/BrainScreen.tsx
import type { BrainCandidate } from "../../../flow/track";
import { Button } from "@/shared/ui/button";

type Props = {
  /** Every brain Colony knows about, ready or not. */
  brains: BrainCandidate[];
  selected: string | null;
  onSelect: (name: string) => void;
  onContinue: () => void;
};

/**
 * What each status says to someone who has never installed a developer tool.
 * Never the runtime's own vocabulary, never an instruction they cannot follow
 * from this screen.
 */
const STATUS_COPY: Record<BrainCandidate["status"], string> = {
  ready: "Ready to go",
  "needs-login": "Found, needs you to sign in",
  "not-installed": "Not on this computer yet",
};

export function BrainScreen({ brains, selected, onSelect, onContinue }: Props) {
  const anyReady = brains.some((brain) => brain.status === "ready");

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Pick who does the <em>thinking</em>.
        </h1>
        <p className="onb-sub">
          {anyReady
            ? "Your agents need a brain to think with. We found one already on your computer, so this costs you nothing."
            : "Your agents need a brain to think with. Colony can set one up for you."}
        </p>
      </div>
      <div className="onb-options" role="listbox" aria-label="Your agents">
        {brains.map((brain) => {
          const ready = brain.status === "ready";
          return (
            <button
              type="button"
              key={brain.label}
              role="option"
              className="onb-option"
              aria-selected={selected === brain.label}
              data-selected={selected === brain.label}
              data-status={brain.status}
              // Everything is listed so the set reads as a choice, but only a
              // brain that can actually think is selectable. Offering an
              // unusable one would be a dead end dressed as an option.
              disabled={!ready}
              onClick={() => onSelect(brain.label)}
            >
              <span className="onb-pulse" />
              <span>
                <span className="onb-option__title">{brain.label}</span>
                <span className="onb-option__meta">
                  {STATUS_COPY[brain.status]}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="onb-actions">
        <Button size="lg" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
