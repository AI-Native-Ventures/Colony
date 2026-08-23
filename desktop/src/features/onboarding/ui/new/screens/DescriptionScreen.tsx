// desktop/src/features/onboarding/ui/new/screens/DescriptionScreen.tsx
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import { descriptionShortfall } from "../../../flow/validation";
import type { ScrapeFailureReason } from "../../../contracts";

/**
 * Every failure gets the same plain sentence. A user whose site sits behind a
 * bot wall does not need to be taught what a bot wall is.
 */
const UNREACHABLE = "We couldn't reach that site.";

export const SCRAPE_FAILURE_COPY: Record<ScrapeFailureReason, string> = {
  unreachable: UNREACHABLE,
  blocked: UNREACHABLE,
  empty: UNREACHABLE,
  timeout: UNREACHABLE,
};

export function descriptionCopy(input: {
  hasWebsite: boolean;
  scrapeFailed: boolean;
}): { title: string; sub: string } {
  // Two separate reasons the generated text is absent: nothing was read, or
  // reading failed. Either way the app must not claim it found something.
  if (!input.hasWebsite) {
    return {
      title: "Tell us what you do.",
      sub: "A line or two is enough. Your helpers work from this.",
    };
  }
  if (input.scrapeFailed) {
    return {
      title: "Tell us what you do.",
      sub: `${UNREACHABLE} Write a line or two about your business instead.`,
    };
  }
  return {
    title: "Here is what we found.",
    sub: "Change anything we got wrong. Your helpers work from this.",
  };
}

type Props = {
  hasWebsite: boolean;
  scrapeFailed: boolean;
  value: string;
  onChange: (value: string) => void;
  onContinue: () => void;
  onBack: () => void;
};

export function DescriptionScreen({
  hasWebsite,
  scrapeFailed,
  value,
  onChange,
  onContinue,
  onBack,
}: Props) {
  const copy = descriptionCopy({ hasWebsite, scrapeFailed });
  const shortfall = descriptionShortfall(value);

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">{copy.title}</h1>
        <p className="onb-sub">{copy.sub}</p>
      </div>
      <div className="onb-panel">
        <Textarea
          rows={5}
          value={value}
          placeholder="We repair and service cars in Johannesburg."
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="onb-note">
          {shortfall === 0
            ? `${value.trim().length} characters`
            : `${shortfall} more characters`}
        </p>
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={shortfall > 0} onClick={onContinue}>
          Looks right
        </Button>
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
