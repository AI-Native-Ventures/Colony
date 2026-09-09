import { useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ArrowRight } from "lucide-react";
import { FounderLayout } from "../FounderLayout";
import type { OnboardingServices } from "../../../contracts";
import { isWebsite, normaliseWebsite } from "../../../flow/validation";

export type CompanyStage = "live" | "building";
export type CompanyValues = {
  company: string;
  website: string;
  description: string;
  stage?: CompanyStage | null;
  hasWebsite?: boolean | null;
};
export function companyReady(values: CompanyValues): boolean {
  return (
    !!values.company.trim() &&
    (!values.website.trim() || isWebsite(values.website)) &&
    !!values.description.trim()
  );
}
export function companyBlockedReason(values: CompanyValues): string | null {
  if (!values.company.trim()) return "Enter your business name.";
  if (values.website.trim() && !isWebsite(values.website))
    return "Check the website address, or leave it blank.";
  if (!values.description.trim())
    return "Add a short description, or read your website.";
  return null;
}

export function CompanyScreen({
  values,
  onChange,
  onSubmit,
  onBack,
  onSignIn,
  businessOnly = false,
  isSubmitting = false,
  error,
  scrape,
}: {
  values: CompanyValues;
  onChange: (patch: Partial<CompanyValues>) => void;
  onSubmit: (normalisedWebsite: string | null) => void;
  onBack?: () => void;
  onSignIn?: () => void;
  businessOnly?: boolean;
  isSubmitting?: boolean;
  error?: string | null;
  scrape: OnboardingServices["scrape"];
}) {
  const [reading, setReading] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const editRevision = useRef(0);
  const requestId = useRef(0);
  const [websiteRead, setWebsiteRead] = useState<string | null>(null);
  async function readWebsite() {
    if (!isWebsite(values.website) || reading || isSubmitting) return;
    const id = ++requestId.current;
    const revision = editRevision.current;
    setReading(true);
    setScanNote(null);
    try {
      const result = await scrape.describeBusiness(
        normaliseWebsite(values.website),
      );
      if (id !== requestId.current) return;
      if (result.ok) {
        if (revision === editRevision.current) {
          onChange({ description: result.description });
          setWebsiteRead(normaliseWebsite(values.website));
          setScanNote(
            "Here is what we found. Edit the summary so it sounds like your business.",
          );
        } else
          setScanNote(
            "Your description changed while we read the site. We kept your wording.",
          );
      } else
        setScanNote(
          "We could not read that website. Describe your business below to continue.",
        );
    } catch {
      if (id === requestId.current)
        setScanNote(
          "We could not read that website. Describe your business below to continue.",
        );
    } finally {
      if (id === requestId.current) setReading(false);
    }
  }
  return (
    <FounderLayout
      step="company"
      onSignIn={onSignIn}
      navigationDisabled={isSubmitting}
      business={values.company}
      description={values.description}
      businessOnly={businessOnly}
    >
      <form
        className="onb-simple-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (companyReady(values) && !isSubmitting)
            onSubmit(
              values.website.trim() ? normaliseWebsite(values.website) : null,
            );
        }}
      >
        <div className="onb-simple-form-heading">
          <h2>Your business</h2>
          <p>Only the essentials. You can add more as you go.</p>
        </div>
        <div className="onb-simple-field">
          <label htmlFor="onb-company-name">Business name</label>
          <Input
            id="onb-company-name"
            required
            value={values.company}
            placeholder="Your business name"
            disabled={isSubmitting}
            onChange={(e) => onChange({ company: e.target.value })}
          />
        </div>
        <div className="onb-simple-field">
          <label htmlFor="onb-company-website">
            Website <span className="onb-simple-note">optional</span>
          </label>
          <Input
            id="onb-company-website"
            value={values.website}
            placeholder="yourbusiness.com"
            disabled={isSubmitting}
            onChange={(e) => {
              requestId.current += 1;
              editRevision.current += 1;
              setReading(false);
              setWebsiteRead(null);
              setScanNote(null);
              onChange({ website: e.target.value });
            }}
          />
          {values.website.trim() && (
            <button
              className="onb-simple-link onb-read-website"
              type="button"
              disabled={!isWebsite(values.website) || reading || isSubmitting}
              onClick={() => void readWebsite()}
            >
              {reading
                ? "Reading your website…"
                : websiteRead
                  ? "Read website again"
                  : "Read website"}
            </button>
          )}
        </div>
        <div className="onb-simple-field">
          <label htmlFor="onb-company-description">
            {values.website.trim()
              ? "Business summary"
              : "What does your business do?"}
          </label>
          <textarea
            id="onb-company-description"
            rows={3}
            required
            value={values.description}
            placeholder="We help…"
            disabled={isSubmitting}
            onChange={(e) => {
              editRevision.current += 1;
              onChange({ description: e.target.value });
            }}
          />
          <p className="onb-simple-note">
            {values.website.trim()
              ? "Review this summary before Scout uses it. You can edit every detail."
              : "One sentence gives Scout a useful starting point."}
          </p>
        </div>
        {scanNote && (
          <p className="onb-simple-note" role="status">
            {scanNote}
          </p>
        )}
        {error && (
          <p className="onb-simple-error" role="alert">
            {error}
          </p>
        )}
        <Button
          className="onb-simple-button onb-simple-primary"
          type="submit"
          disabled={!companyReady(values) || isSubmitting}
        >
          {isSubmitting ? "Preparing your business…" : "Continue"}
          {!isSubmitting && <ArrowRight aria-hidden="true" />}
        </Button>
        <p className="onb-simple-note">
          Your teammate will use this context for the first job.
        </p>
        {onBack && (
          <button
            className="onb-simple-link"
            type="button"
            onClick={onBack}
            disabled={isSubmitting}
          >
            Back to Colony
          </button>
        )}
      </form>
    </FounderLayout>
  );
}
