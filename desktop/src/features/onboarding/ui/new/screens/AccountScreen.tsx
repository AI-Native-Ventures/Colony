import { useEffect, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import type { AuthFailure } from "../../../authService";
import { FOUNDER_GENDERS, type FounderGender } from "../../../onboardingV2";
import {
  PASSWORD_MIN,
  isEmail,
  passwordShortfall,
} from "../../../flow/validation";

export type AccountValues = {
  name: string;
  email: string;
  password: string;
  /**
   * No longer asked for here, and always empty for a fresh signup.
   *
   * The screen used to end on two bare underlines labelled City and Country,
   * with no placeholder and no stated reason, and a photo circle with no
   * affordance. Signing up needs a name, an email and a password; where
   * someone lives and what they look like are profile details, and profile
   * details belong in Profile settings, after the account exists.
   *
   * The three fields stay declared because the flow that owns this screen
   * carries them into `OnboardingAnswers.founder`, and every reader downstream
   * already treats them as optional: the founder brief omits the location line
   * when it is blank, and the kind:0 write omits an empty avatar rather than
   * publishing one.
   */
  city: string;
  country: string;
  gender: FounderGender | null;
  selfDescribedGender: string;
  avatarUrl: string;
};

/** What each gender option says on the chip. */
const GENDER_LABEL: Record<FounderGender, string> = {
  woman: "Woman",
  man: "Man",
  "non-binary": "Non-binary",
  "self-describe": "Self-describe",
  "prefer-not-to-say": "Prefer not to say",
};

export function accountReady(values: AccountValues): boolean {
  // Gender stays optional, exactly as it was before, but choosing
  // self-describe and leaving it blank is an unfinished answer rather than a
  // declined one.
  if (
    values.gender === "self-describe" &&
    values.selfDescribedGender.trim().length === 0
  ) {
    return false;
  }
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
  /**
   * Explicit exit toward the email sign-in screen: a user who just learned
   * their address is taken goes back the other way instead of guessing that
   * key import is the answer. Optional so plain flows stay unchanged.
   */
  onSignInRequest?: () => void;
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
  onSignInRequest,
}: Props) {
  const [emailTouched, setEmailTouched] = useState(false);
  const ready = accountReady(values);
  const shortfall = passwordShortfall(values.password);
  const lockSeconds = useSecondsRemaining(
    failure?.kind === "locked" ? failure.retryAfterSecs : null,
  );
  // Both failures mean an account already exists, one under this address and
  // one under this computer's identity. Each states that next to the field it
  // concerns and offers the sign-in door, so neither takes the generic banner
  // that tells the user to check a connection that is working.
  const alreadyHasAccount =
    failure?.kind === "email-taken" || failure?.kind === "identity-taken";

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Let's get your <em>colony</em> started.
        </h1>
        <p className="onb-sub">
          Two minutes. We'll set up your workspace and get your first agents
          working.
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
          {failure?.kind === "identity-taken" ? (
            <p
              className="onb-note onb-note-warn"
              data-testid="onboarding-account-identity-taken"
            >
              This computer already has a Colony account under another email.
              Sign in with that email instead.
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
        <fieldset className="onb-field">
          <legend className="onb-label">Gender (optional)</legend>
          <div className="onb-chips">
            {FOUNDER_GENDERS.map((option) => (
              <button
                type="button"
                key={option}
                className="onb-chip"
                data-selected={values.gender === option}
                aria-pressed={values.gender === option}
                data-testid={`onb-gender-${option}`}
                onClick={() =>
                  onChange({
                    gender: values.gender === option ? null : option,
                    ...(option === "self-describe"
                      ? {}
                      : { selfDescribedGender: "" }),
                  })
                }
              >
                {GENDER_LABEL[option]}
              </button>
            ))}
          </div>
          {values.gender === "self-describe" ? (
            <Input
              aria-label="Describe your gender"
              data-testid="onb-gender-self-described"
              value={values.selfDescribedGender}
              onChange={(e) =>
                onChange({ selfDescribedGender: e.target.value })
              }
            />
          ) : null}
        </fieldset>
      </div>
      {failure !== null && !alreadyHasAccount ? (
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
        {alreadyHasAccount && onSignInRequest ? (
          <button
            className="onb-quiet-action"
            data-testid="onb-account-taken-sign-in"
            onClick={onSignInRequest}
            type="button"
          >
            I already have an account - sign in
          </button>
        ) : null}
        <Button size="lg" disabled={!ready || isSubmitting} onClick={onSubmit}>
          {isSubmitting ? "Creating your account" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
