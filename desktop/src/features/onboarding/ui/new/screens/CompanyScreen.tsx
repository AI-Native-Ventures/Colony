// desktop/src/features/onboarding/ui/new/screens/CompanyScreen.tsx
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

export type CompanyValues = {
  company: string;
};

export function companyReady(values: CompanyValues): boolean {
  return values.company.trim().length > 0;
}

type Props = {
  values: CompanyValues;
  onChange: (patch: Partial<CompanyValues>) => void;
  onSubmit: () => void;
  onBack: () => void;
  /** The workspace is being claimed right now. */
  isSubmitting?: boolean;
  /** Why the last attempt did not work, in the user's words. */
  error?: string | null;
};

export function CompanyScreen({
  values,
  onChange,
  onSubmit,
  onBack,
  isSubmitting = false,
  error = null,
}: Props) {
  const ready = companyReady(values) && !isSubmitting;

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
        <label className="onb-field" htmlFor="onb-company-name">
          <span className="onb-label">Company name</span>
          <Input
            id="onb-company-name"
            value={values.company}
            placeholder="Rosebank Auto Care"
            onChange={(e) => onChange({ company: e.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) onSubmit();
            }}
          />
        </label>
        {error ? <p className="onb-note onb-note-warn">{error}</p> : null}
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!ready} onClick={onSubmit}>
          {isSubmitting ? "Creating your workspace" : "Create workspace"}
        </Button>
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
