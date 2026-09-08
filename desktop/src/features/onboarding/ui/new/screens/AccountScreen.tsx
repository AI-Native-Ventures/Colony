import { useEffect, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { AuthFailure } from "../../../authService";
import type { FounderGender } from "../../../onboardingV2";
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
  return isEmail(values.email) && passwordShortfall(values.password) === 0;
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
    <section className="onb-simple" data-testid="onboarding-account">
      <header className="onb-simple-heading">
        <p className="onb-eyebrow">Your business, with a helping hand</p>
        <h1>Welcome to Colony</h1>
        <p>
          Bring your business and your AI teammates into one place. Start with
          your account.
        </p>
      </header>
      <form
        className="onb-simple-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (accountReady(values) && !isSubmitting && !remaining) onSubmit();
        }}
      >
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
          Use at least {PASSWORD_MIN} characters.
        </p>
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
        </Button>
        {onSignInRequest && (
          <p className="onb-simple-signin">
            Already have an account?{" "}
            <button
              type="button"
              onClick={onSignInRequest}
              disabled={isSubmitting}
            >
              Sign in
            </button>
          </p>
        )}
        {onUsePrivateKey && (
          <details className="onb-simple-options">
            <summary>More options</summary>
            <button type="button" onClick={onUsePrivateKey}>
              Import an existing identity
            </button>
          </details>
        )}
      </form>
    </section>
  );
}
