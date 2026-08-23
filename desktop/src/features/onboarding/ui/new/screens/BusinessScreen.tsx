// desktop/src/features/onboarding/ui/new/screens/BusinessScreen.tsx
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { isWebsite, normaliseWebsite } from "../../../flow/validation";

export type BusinessStage = "live" | "building";

export type BusinessPatch = {
  stage?: BusinessStage;
  hasWebsite?: boolean;
  website?: string;
};

type Props = {
  stage: BusinessStage | null;
  hasWebsite: boolean | null;
  website: string;
  onChange: (patch: BusinessPatch) => void;
  /** Hands up the normalised web address, or null when there is no site. */
  onContinue: (normalisedWebsite: string | null) => void;
  onBack: () => void;
};

const STAGE_OPTIONS: ReadonlyArray<{ id: BusinessStage; label: string }> = [
  { id: "live", label: "Yes, we are open and making money" },
  { id: "building", label: "Not yet, we are still building" },
];

export function BusinessScreen({
  stage,
  hasWebsite,
  website,
  onChange,
  onContinue,
  onBack,
}: Props) {
  const [siteTouched, setSiteTouched] = useState(false);
  const siteOk = isWebsite(website);
  const ready = Boolean(
    stage && (hasWebsite === false || (hasWebsite === true && siteOk)),
  );

  // A disabled primary button always says what is missing. Here that is one
  // of the two unanswered questions, or a web address that does not read as one.
  const blocked =
    !stage || hasWebsite === null
      ? "Answer both questions to continue."
      : "Check the web address above to continue.";

  const submit = () => {
    if (!ready) return;
    onContinue(hasWebsite ? normaliseWebsite(website) : null);
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Tell us about the work.</h1>
      </div>
      <div className="onb-panel">
        <div className="onb-stack">
          <fieldset
            className="onb-options"
            aria-label="Is your company up and running?"
          >
            <p className="onb-label">Is your company up and running?</p>
            {STAGE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                className="onb-option"
                data-selected={stage === option.id}
                onClick={() => onChange({ stage: option.id })}
              >
                <span className="onb-option__title">{option.label}</span>
              </button>
            ))}
          </fieldset>
          <fieldset className="onb-options" aria-label="Do you have a website?">
            <p className="onb-label">Do you have a website?</p>
            <div className="onb-row">
              <button
                type="button"
                className="onb-option"
                data-selected={hasWebsite === true}
                onClick={() => onChange({ hasWebsite: true })}
              >
                <span className="onb-option__title">Yes</span>
              </button>
              <button
                type="button"
                className="onb-option"
                data-selected={hasWebsite === false}
                onClick={() => onChange({ hasWebsite: false, website: "" })}
              >
                <span className="onb-option__title">No</span>
              </button>
            </div>
            {hasWebsite ? (
              <div className="onb-field">
                <Input
                  value={website}
                  placeholder="rosebankautocare.co.za"
                  onChange={(event) =>
                    onChange({ website: event.target.value })
                  }
                  onBlur={() => setSiteTouched(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && ready) submit();
                  }}
                />
                {siteTouched && website && !siteOk ? (
                  <p className="onb-note onb-note-warn">
                    That does not look like a web address. It should look like
                    rosebankautocare.co.za
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>
        </div>
        {!ready ? <p className="onb-note">{blocked}</p> : null}
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!ready} onClick={submit}>
          Continue
        </Button>
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
