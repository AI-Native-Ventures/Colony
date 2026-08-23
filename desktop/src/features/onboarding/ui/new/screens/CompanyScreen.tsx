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
};

export function CompanyScreen({ values, onChange, onSubmit, onBack }: Props) {
  const ready = companyReady(values);

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Now, your company.</h1>
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
      </div>
      <div className="onb-actions">
        <Button size="lg" disabled={!ready} onClick={onSubmit}>
          Create workspace
        </Button>
        <button type="button" className="onb-quiet-action" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
