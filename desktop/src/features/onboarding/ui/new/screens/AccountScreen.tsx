import { useEffect, useState } from "react";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import {
  parseEmojiAvatarDataUrl,
  ProfileAvatarEditor,
} from "@/features/profile/ui/ProfileAvatarEditor";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
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
  city: string;
  /** Carried over from the previous first-run flow: Scout's brief uses it. */
  country: string;
  gender: FounderGender | null;
  selfDescribedGender: string;
  /**
   * Profile picture, empty when skipped. Collected here rather than on a
   * screen of its own: this is where the founder says who they are, and the
   * previous flow's dedicated avatar step is one of the screens the redesign
   * folded away.
   */
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
        <div className="onb-identity-row">
          <AvatarPicker
            avatarUrl={values.avatarUrl}
            disabled={isSubmitting}
            name={values.name}
            onChange={(avatarUrl) => onChange({ avatarUrl })}
          />
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
        </div>
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
        <div className="onb-row">
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
          </label>
          <label className="onb-field" htmlFor="onb-account-country">
            <span className="onb-label">Country</span>
            <Input
              id="onb-account-country"
              value={values.country}
              onChange={(e) => onChange({ country: e.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready && !isSubmitting) onSubmit();
              }}
            />
          </label>
        </div>
        <p className="onb-note">Change these if we got them wrong.</p>
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
        {failure?.kind === "email-taken" && onSignInRequest ? (
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

/** Emoji-picker colours, mapped onto the onboarding canvas's own variables so
 *  the editor does not arrive wearing the app's chat theme. */
const ONBOARDING_EMOJI_PICKER_THEME_VARS = {
  "--buzz-emoji-picker-rgb-background":
    "var(--buzz-onboarding-emoji-picker-background)",
  "--buzz-emoji-picker-rgb-color": "var(--buzz-onboarding-emoji-picker-color)",
  "--buzz-emoji-picker-rgb-input": "var(--buzz-onboarding-emoji-picker-input)",
} as React.CSSProperties;

/**
 * The profile picture, as a circle that opens the shared avatar editor.
 *
 * The same `ProfileAvatarEditor` the previous flow's avatar step and the
 * community profile stage both used, so uploads, emoji avatars and animated
 * previews behave identically wherever someone sets a picture. Skipping is
 * silent and costs nothing: the circle just stays empty, and the profile is
 * written without an avatar.
 */
function AvatarPicker({
  avatarUrl,
  disabled,
  name,
  onChange,
}: {
  avatarUrl: string;
  disabled: boolean;
  name: string;
  onChange: (avatarUrl: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const emojiAvatar = parseEmojiAvatarDataUrl(avatarUrl);
  const hasAvatar = avatarUrl.trim().length > 0;
  const previewName = name.trim() || "Your profile";

  return (
    <>
      <button
        aria-label={hasAvatar ? "Change your photo" : "Add your photo"}
        className="onb-avatar-button"
        data-has-avatar={hasAvatar}
        data-testid="onboarding-account-avatar"
        disabled={disabled}
        onClick={() => setIsOpen(true)}
        type="button"
      >
        {emojiAvatar ? (
          <span
            aria-hidden="true"
            className="onb-avatar-emoji"
            style={{ backgroundColor: emojiAvatar.color }}
          >
            {emojiAvatar.emoji}
          </span>
        ) : hasAvatar ? (
          <ProfileAvatar
            avatarUrl={avatarUrl}
            className="h-full w-full"
            label={previewName}
          />
        ) : (
          <span className="onb-avatar-empty">Photo</span>
        )}
      </button>
      <Dialog onOpenChange={setIsOpen} open={isOpen}>
        <DialogContent
          className="buzz-onboarding-neutral-theme max-w-[34rem]"
          data-testid="onboarding-account-avatar-editor"
          surface="textured"
        >
          <DialogTitle className="px-2 pt-2 text-2xl font-normal">
            Add your photo
          </DialogTitle>
          <ProfileAvatarEditor
            avatarUrl={avatarUrl}
            disabled={disabled}
            donePending={isUploading}
            emojiPickerTheme="auto"
            emojiPickerThemeVars={ONBOARDING_EMOJI_PICKER_THEME_VARS}
            onDone={() => setIsOpen(false)}
            onUploadingChange={setIsUploading}
            onUrlChange={onChange}
            presentation="onboarding-modal"
            previewName={previewName}
            showInlineUploadPreview
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
