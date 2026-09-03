// desktop/src/features/onboarding/ui/new/screens/ProfileScreen.tsx
import { useState } from "react";

import { useAvatarPresentation } from "@/features/profile/avatarPresentationStore";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import {
  parseEmojiAvatarDataUrl,
  ProfileAvatarEditor,
} from "@/features/profile/ui/ProfileAvatarEditor";
import { OnboardingRelayConnectionErrorCard } from "@/features/onboarding/ui/OnboardingRelayConnectionErrorCard";
import { isRelayUnreachableError } from "@/shared/lib/relayError";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

export type ProfileValues = {
  displayName: string;
  /** Empty when no picture has been chosen; skipping costs nothing. */
  avatarUrl: string;
};

export function profileReady(values: ProfileValues): boolean {
  return values.displayName.trim().length > 0;
}

type Props = {
  values: ProfileValues;
  onChange: (patch: Partial<ProfileValues>) => void;
  onSubmit: () => void;
  isSaving: boolean;
  /** Why the last save failed, in the user's words. */
  error?: string | null;
  /** Offered when the save failed and there is no saved name to fall back on. */
  onSkip?: () => void;
  /** Offered when the save failed but a saved name already exists. */
  onContinueWithoutSaving?: () => void;
  /**
   * Leaves this screen entirely. The app gate has nowhere to go back to, so
   * it passes nothing; a community transaction passes its cancel, which is
   * how someone abandons a join they have started.
   */
  onBack?: () => void;
  /** What that exit is called, when "Back" is not what it does. */
  backLabel?: string;
};

/**
 * Name and photo for an identity that already exists.
 *
 * This is the canvas replacement for the previous flow's profile and avatar
 * steps, which asked the same two questions across two screens. It is a
 * separate screen from AccountScreen on purpose: that one signs somebody up
 * (email, password, a key to create), and this one only writes a profile for
 * a key the person already holds.
 */
export function ProfileScreen({
  values,
  onChange,
  onSubmit,
  isSaving,
  error = null,
  onSkip,
  onContinueWithoutSaving,
  onBack,
  backLabel = "Back",
}: Props) {
  const ready = profileReady(values);

  return (
    <div className="onb-screen" data-testid="onboarding-page-profile">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          What should we <em>call</em> you?
        </h1>
        <p className="onb-sub">
          The name and picture your people and your agents will see. Both can
          change later in Profile.
        </p>
      </div>
      <div className="onb-panel">
        <div className="onb-identity-row">
          <AvatarPicker
            avatarUrl={values.avatarUrl}
            disabled={isSaving}
            name={values.displayName}
            onChange={(avatarUrl) => onChange({ avatarUrl })}
          />
          <label className="onb-field" htmlFor="onboarding-display-name">
            <span className="onb-label">Your name</span>
            <Input
              data-testid="onboarding-display-name"
              disabled={isSaving}
              id="onboarding-display-name"
              onChange={(event) =>
                onChange({ displayName: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready && !isSaving) onSubmit();
              }}
              placeholder="Aisha Bello"
              value={values.displayName}
            />
          </label>
        </div>
        <p className="onb-note">A picture is optional.</p>
      </div>
      {error && isRelayUnreachableError(error) ? (
        // A relay that cannot be reached is a connection to fix rather than a
        // sentence to read, so this one failure gets a control instead of a
        // line of text.
        <OnboardingRelayConnectionErrorCard
          isSaving={isSaving}
          key={error}
          message={error}
        />
      ) : error ? (
        <p className="onb-note onb-note-warn" role="alert">
          {error}
        </p>
      ) : null}
      <div className="onb-actions">
        <Button
          data-testid="onboarding-next"
          disabled={!ready || isSaving}
          onClick={onSubmit}
          size="lg"
        >
          {isSaving ? "Saving" : "Continue"}
        </Button>
        {onContinueWithoutSaving ? (
          <button
            className="onb-quiet-action"
            data-testid="onboarding-next-without-saving"
            onClick={onContinueWithoutSaving}
            type="button"
          >
            Continue without saving
          </button>
        ) : null}
        {onSkip ? (
          <button
            className="onb-quiet-action"
            data-testid="onboarding-skip"
            onClick={onSkip}
            type="button"
          >
            Skip for now
          </button>
        ) : null}
        {onBack ? (
          <button
            className="onb-quiet-action"
            data-testid="onboarding-back"
            disabled={isSaving}
            onClick={onBack}
            type="button"
          >
            {backLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Emoji-picker colours, mapped onto the canvas's own variables so the editor
 *  does not arrive wearing the app's chat theme. */
const ONBOARDING_EMOJI_PICKER_THEME_VARS = {
  "--buzz-emoji-picker-rgb-background":
    "var(--buzz-onboarding-emoji-picker-background)",
  "--buzz-emoji-picker-rgb-color": "var(--buzz-onboarding-emoji-picker-color)",
  "--buzz-emoji-picker-rgb-input": "var(--buzz-onboarding-emoji-picker-input)",
} as React.CSSProperties;

/**
 * The photo, as a circle that opens the shared avatar editor: the same
 * `ProfileAvatarEditor` the previous avatar step used, so uploads, emoji
 * avatars and animated previews behave identically wherever a picture is set.
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
  const presentation = useAvatarPresentation(avatarUrl);
  // A picture whose upload never propagated is not a picture: the circle goes
  // back to empty so it can be replaced, and the profile is written without
  // it. Dropping this check left a failed upload showing initials as though
  // it had worked.
  const hasAvatar =
    avatarUrl.trim().length > 0 && presentation?.state !== "failed";
  const previewName = name.trim() || "Your profile";

  return (
    <>
      <button
        aria-label={hasAvatar ? "Change your photo" : "Add your photo"}
        className="onb-avatar-button"
        data-has-avatar={hasAvatar}
        data-testid="onboarding-profile-avatar"
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
            // Named so the pending-upload and failed-image states stay
            // assertable: an avatar that is still propagating is the whole
            // point of the deferred registration around this screen.
            testId="onboarding-avatar-circle"
          />
        ) : (
          <span
            className="onb-avatar-empty"
            data-testid="onboarding-avatar-empty"
          >
            Photo
          </span>
        )}
      </button>
      <Dialog onOpenChange={setIsOpen} open={isOpen}>
        <DialogContent
          className="buzz-onboarding-neutral-theme max-w-[34rem]"
          data-testid="onboarding-profile-avatar-editor"
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
            // Keeps the editor's controls named as they were on the avatar
            // step this screen replaces, so what the specs drive is the
            // control rather than the screen that happened to host it.
            testIdPrefix="onboarding-avatar"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
