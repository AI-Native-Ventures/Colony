// desktop/src/features/onboarding/ui/new/screens/BrainScreen.tsx
import { Button } from "@/shared/ui/button";

type Props = {
  /** Labels of runtimes the probe found ready on this computer. */
  installed: string[];
  selected: string | null;
  onSelect: (name: string) => void;
  onContinue: () => void;
};

export function BrainScreen({
  installed,
  selected,
  onSelect,
  onContinue,
}: Props) {
  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Pick who does the <em>thinking</em>.
        </h1>
        <p className="onb-sub">
          Your helpers need a brain to think with. We found these on your
          computer. You can change it any time.
        </p>
      </div>
      <div className="onb-options" role="listbox" aria-label="Your helpers">
        {installed.map((name) => (
          <button
            type="button"
            key={name}
            role="option"
            className="onb-option"
            aria-selected={selected === name}
            data-selected={selected === name}
            onClick={() => onSelect(name)}
          >
            <span className="onb-pulse" />
            <span>
              <span className="onb-option__title">{name}</span>
              <span className="onb-option__meta">Ready</span>
            </span>
          </button>
        ))}
      </div>
      <div className="onb-actions">
        <Button size="lg" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
