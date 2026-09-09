import { useEffect, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ArrowRight } from "lucide-react";
import { FounderLayout } from "../FounderLayout";
import type { AuthFailure } from "../../../authService";
import type { FounderGender } from "../../../onboardingV2";
import { sanitizeDisplayName } from "../../../profileDraft";
import {
  PASSWORD_MIN,
  isEmail,
  passwordShortfall,
} from "../../../flow/validation";

export type AccountValues = {
  email: string;
  password: string;
  name?: string;
  city?: string;
  country?: string;
  gender?: FounderGender | null;
  selfDescribedGender?: string;
  avatarUrl?: string;
};

export function accountReady(values: AccountValues): boolean {
  return (
    sanitizeDisplayName(values.name).length > 0 &&
    isEmail(values.email) &&
    passwordShortfall(values.password) === 0
  );
}

export function accountFailureMessage(failure: AuthFailure): string {
  switch (failure.kind) {
    case "email-taken":
      return "That email already has an account. Sign in to continue.";
    case "identity-taken":
      return "This device already has an account. Sign in with its email to continue.";
    case "locked":
      return "Please wait before trying again.";
    case "unreachable":
      return "We could not connect to Colony. Check your connection and try again.";
    case "local-storage":
      return "We could not safely save your account recovery on this device. Try again, or sign in to your existing account.";
    case "local-identity":
      return "We could not prepare your account securely on this device. Try again.";
    case "server":
      return "Colony could not finish creating your account. Your details are still here. Try again.";
    case "update-required":
      return "Please update Colony to open this account.";
    default:
      return "Those details did not match. Check them and try again.";
  }
}

type Props = {
  values: AccountValues;
  onChange: (patch: Partial<AccountValues>) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  failure?: AuthFailure | null;
  onSignInRequest?: () => void;
  onUsePrivateKey?: () => void;
};

export function AccountScreen({
  values,
  onChange,
  onSubmit,
  isSubmitting,
  failure,
  onSignInRequest,
  onUsePrivateKey,
}: Props) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    setRemaining(failure?.kind === "locked" ? failure.retryAfterSecs : 0);
    if (failure?.kind !== "locked") return;
    const timer = setInterval(
      () => setRemaining((value) => Math.max(0, value - 1)),
      1000,
    );
    return () => clearInterval(timer);
  }, [failure]);
  return (
    <FounderLayout
      step="account"
      onSignIn={onSignInRequest}
      navigationDisabled={isSubmitting}
    >
      <form
        className="onb-simple-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (accountReady(values) && !isSubmitting && !remaining) onSubmit();
        }}
      >
        <div className="onb-simple-form-heading">
          <h2>Create your account</h2>
          <p>Start with your account. Then tell us about your business.</p>
        </div>
        <div className="onb-simple-field">
          <label htmlFor="onb-account-name">Your name</label>
          <Input
            id="onb-account-name"
            autoComplete="name"
            value={values.name ?? ""}
            placeholder="The name your team will see"
            required
            maxLength={100}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        <div className="onb-simple-field">
          <label htmlFor="onb-account-email">Email</label>
          <Input
            id="onb-account-email"
            type="email"
            autoComplete="email"
            value={values.email}
            placeholder="you@yourbusiness.com"
            required
            onChange={(e) => onChange({ email: e.target.value })}
          />
        </div>
        <div className="onb-simple-field">
          <label htmlFor="onb-account-password">Password</label>
          <Input
            id="onb-account-password"
            type="password"
            autoComplete="new-password"
            value={values.password}
            required
            minLength={PASSWORD_MIN}
            onChange={(e) => onChange({ password: e.target.value })}
            aria-describedby="onb-password-help"
          />
          <p id="onb-password-help" className="onb-simple-note">
            At least {PASSWORD_MIN} characters
          </p>
        </div>
        {failure && (
          <p className="onb-simple-error" role="alert">
            {accountFailureMessage(failure)}
            {remaining > 0 ? ` Try again in ${remaining} seconds.` : ""}
          </p>
        )}
        <Button
          className="onb-simple-button onb-simple-primary"
          type="submit"
          disabled={!accountReady(values) || isSubmitting || remaining > 0}
        >
          {isSubmitting ? "Creating your account…" : "Create account"}
          {!isSubmitting && <ArrowRight aria-hidden="true" />}
        </Button>
        {onUsePrivateKey && (
          <details className="onb-simple-options">
            <summary>More options</summary>
            <button
              type="button"
              onClick={onUsePrivateKey}
              disabled={isSubmitting}
            >
              Import an existing identity
            </button>
          </details>
        )}
        <p className="onb-simple-note">
          Agent work uses credits. You can explore before adding any.
        </p>
      </form>
    </FounderLayout>
  );
}
