import { useEffect, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import type { AuthFailure } from "../../../authService";
import {
  PASSWORD_MIN,
  isEmail,
  passwordShortfall,
} from "../../../flow/validation";

export type AccountValues = {
  name: string;
  email: string;
  password: string;
  city: string;
};

export function accountReady(values: AccountValues): boolean {
  return (
    values.name.trim().length > 0 &&
    isEmail(values.email) &&
    passwordShortfall(values.password) === 0
  );
}

type Props = {
  values: AccountValues;
  onChange: (patch: Partial<AccountValues>) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  /** Why the last signup attempt failed, if one did. Cleared on any edit. */
  failure?: AuthFailure | null;
};

/** Seconds left on a lockout, ticking once per second while one is active. */
function useSecondsRemaining(totalSecs: number | null): number {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (totalSecs === null) return undefined;
    setRemaining(totalSecs);
    const id = setInterval(() => {
      setRemaining((current) => Math.max(0, current - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [totalSecs]);
  return remaining;
}

function clockFormat(totalSecs: number): string {
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function AccountScreen({
  values,
  onChange,
  onSubmit,
  isSubmitting,
  failure = null,
}: Props) {
  const [emailTouched, setEmailTouched] = useState(false);
  const ready = accountReady(values);
  const shortfall = passwordShortfall(values.password);
  const lockSeconds = useSecondsRemaining(
    failure?.kind === "locked" ? failure.retryAfterSecs : null,
  );

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">Welcome to the colony.</h1>
        <p className="onb-sub">
          A few quick questions and your workspace is ready.
        </p>
      </div>
      <div className="onb-panel">
        <label className="onb-field" htmlFor="onb-account-name">
          <span className="onb-label">Your name</span>
          <Input
            id="onb-account-name"
            value={values.name}
            placeholder="Aisha Bello"
            onChange={(e) => onChange({ name: e.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready && !isSubmitting) onSubmit();
            }}
          />
        </label>
        <label className="onb-field" htmlFor="onb-account-email">
          <span className="onb-label">Email</span>
          <Input
            id="onb-account-email"
            type="email"
            value={values.email}
            placeholder="you@company.com"
            onBlur={() => setEmailTouched(true)}
            onChange={(e) => onChange({ email: e.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready && !isSubmitting) onSubmit();
            }}
          />
          {failure?.kind === "email-taken" ? (
            <p className="onb-note onb-note-warn">
              That email already has an account.
            </p>
          ) : null}
          {emailTouched && values.email && !isEmail(values.email) ? (
            <p className="onb-note onb-note-warn">
              That does not look like an email address.
            </p>
          ) : null}
        </label>
        <label className="onb-field" htmlFor="onb-account-password">
          <span className="onb-label">Password</span>
          <Input
            id="onb-account-password"
            type="password"
            value={values.password}
            placeholder={`At least ${PASSWORD_MIN} characters`}
            onChange={(e) => onChange({ password: e.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready && !isSubmitting) onSubmit();
            }}
          />
          <Progress
            value={Math.min(100, (values.password.length / PASSWORD_MIN) * 100)}
          />
          <p className="onb-note">
            {shortfall === 0
              ? "Strong enough."
              : `${shortfall} more characters`}
          </p>
        </label>
        <label className="onb-field" htmlFor="onb-account-city">
          <span className="onb-label">City</span>
          <Input
            id="onb-account-city"
            value={values.city}
            onChange={(e) => onChange({ city: e.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready && !isSubmitting) onSubmit();
            }}
          />
          <p className="onb-note">Change it if we got it wrong.</p>
        </label>
      </div>
      {failure !== null && failure.kind !== "email-taken" ? (
        <p className="onb-note onb-note-warn" role="alert">
          {failure.kind === "invalid-credentials"
            ? "That information does not match an account. Check it and try again."
            : failure.kind === "locked"
              ? lockSeconds > 0
                ? `Too many attempts. Try again in ${clockFormat(lockSeconds)}.`
                : "You can try again now."
              : failure.kind === "update-required"
                ? "This version of Colony is out of date. Update the app, then try again."
                : "We could not reach your workspace. Check your connection and try again."}
        </p>
      ) : null}
      <div className="onb-actions">
        <Button size="lg" disabled={!ready || isSubmitting} onClick={onSubmit}>
          {isSubmitting ? "Creating your account" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
