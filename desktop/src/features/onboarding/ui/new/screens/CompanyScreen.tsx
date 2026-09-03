// desktop/src/features/onboarding/ui/new/screens/CompanyScreen.tsx
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { isWebsite, normaliseWebsite } from "../../../flow/validation";

export type CompanyStage = "live" | "building";

export type CompanyValues = {
  company: string;
  stage: CompanyStage | null;
  hasWebsite: boolean | null;
  website: string;
};

export function companyReady(values: CompanyValues): boolean {
  if (values.company.trim().length === 0) return false;
  if (!values.stage) return false;
  if (values.hasWebsite === null) return false;
  return values.hasWebsite === false || isWebsite(values.website);
}

/**
 * What a disabled primary action says is missing.
 *
 * The rule the redesign exists to honour: never a dead button with no reason.
 * The three questions are asked in the order they are answered, so the note
 * names the first one still open rather than the last one touched.
 */
export function companyBlockedReason(values: CompanyValues): string | null {
  if (companyReady(values)) return null;
  if (values.company.trim().length === 0)
    return "Enter your company name to continue.";
  if (!values.stage || values.hasWebsite === null) {
    return "Answer both questions to continue.";
  }
  return "Check the web address above to continue.";
}

const STAGE_OPTIONS: ReadonlyArray<{ id: CompanyStage; label: string }> = [
  { id: "live", label: "Yes, we are open and making money" },
  { id: "building", label: "Not yet, we are still building" },
];

type Props = {
  values: CompanyValues;
  onChange: (patch: Partial<CompanyValues>) => void;
  /** Hands up the normalised web address, or null when there is no site. */
  onSubmit: (normalisedWebsite: string | null) => void;
  onBack: () => void;
  /** The workspace is being claimed right now. */
  isSubmitting?: boolean;
  /** Why the last attempt did not work, in the user's words. */
  error?: string | null;
};

/**
 * Company name, stage and website, on one screen.
 *
 * These were two screens with the probe and the brain picker between them,
 * which asked a founder to describe the same company twice in one sitting
 * with an unrelated question in the middle. They are three plain questions
 * about one thing, so they are asked together.
 */
export function CompanyScreen({
  values,
  onChange,
  onSubmit,
  onBack,
  isSubmitting = false,
  error = null,
}: Props) {
  const [siteTouched, setSiteTouched] = useState(false);
  const siteOk = isWebsite(values.website);
  const ready = companyReady(values) && !isSubmitting;
  const blocked = companyBlockedReason(values);

  const submit = () => {
    if (!ready) return;
    onSubmit(values.hasWebsite ? normaliseWebsite(values.website) : null);
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Now, your <em>company</em>.
        </h1>
        <p className="onb-sub">
          This becomes your workspace. You can change the name later.
        </p>
      </div>
      <div className="onb-panel">
        <div className="onb-stack">
          <label className="onb-field" htmlFor="onb-company-name">
            <span className="onb-label">Company name</span>
            <Input
              id="onb-company-name"
              value={values.company}
              placeholder="Rosebank Auto Care"
              onChange={(e) => onChange({ company: e.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready) submit();
              }}
            />
          </label>
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
                data-selected={values.stage === option.id}
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
                data-selected={values.hasWebsite === true}
                onClick={() => onChange({ hasWebsite: true })}
              >
                <span className="onb-option__title">Yes</span>
              </button>
              <button
                type="button"
                className="onb-option"
                data-selected={values.hasWebsite === false}
                onClick={() => onChange({ hasWebsite: false, website: "" })}
              >
                <span className="onb-option__title">No</span>
              </button>
            </div>
            {values.hasWebsite ? (
              <div className="onb-field">
                <Input
                  value={values.website}
                  placeholder="rosebankautocare.co.za"
                  onChange={(event) =>
                    onChange({ website: event.target.value })
                  }
                  onBlur={() => setSiteTouched(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && ready) submit();
                  }}
                />
                {siteTouched && values.website && !siteOk ? (
                  <p className="onb-note onb-note-warn">
                    That does not look like a web address. It should look like
                    rosebankautocare.co.za
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>
        </div>
        {error ? <p className="onb-note onb-note-warn">{error}</p> : null}
        {blocked && !error ? <p className="onb-note">{blocked}</p> : null}
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!ready} onClick={submit}>
          {isSubmitting ? "Creating your workspace" : "Create workspace"}
        </Button>
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
