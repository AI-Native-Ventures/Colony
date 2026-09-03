// desktop/src/features/onboarding/ui/new/screens/WorkspaceChoiceScreen.tsx

/**
 * "Join or create a community", on the canvas.
 *
 * Replaces the pastel WelcomeSetup's first two pages. Both are the same
 * shape (a headline over a short list of doors), so they are one component
 * with two modes rather than two screens that would drift apart.
 */
export type WorkspaceChoiceMode = "welcome" | "existing";

export type WorkspaceChoice =
  | "join"
  | "create"
  | "existing"
  | "owner"
  | "member";

export type WorkspaceChoiceOption = {
  id: WorkspaceChoice;
  title: string;
  meta: string;
  testId: string;
};

const WELCOME_OPTIONS: WorkspaceChoiceOption[] = [
  {
    id: "join",
    title: "Join with an invite",
    meta: "Paste the link someone on the team sent you.",
    testId: "community-choice-join",
  },
  {
    id: "create",
    title: "Create a community",
    meta: "Set up a new one and bring your people in.",
    testId: "community-choice-create",
  },
  {
    id: "existing",
    title: "Reconnect one I already have",
    meta: "Sign back into a community you have used before.",
    testId: "community-choice-existing",
  },
];

const EXISTING_OPTIONS: WorkspaceChoiceOption[] = [
  {
    id: "owner",
    title: "I own the community",
    meta: "You set it up, so we can take you straight back to it.",
    testId: "existing-choice-owner",
  },
  {
    id: "member",
    title: "I am a member or admin",
    meta: "Your role is restored the moment you connect.",
    testId: "existing-choice-member",
  },
];

export function workspaceChoiceOptions(
  mode: WorkspaceChoiceMode,
): WorkspaceChoiceOption[] {
  return mode === "welcome" ? WELCOME_OPTIONS : EXISTING_OPTIONS;
}

const HEAD: Record<WorkspaceChoiceMode, { headline: string; sub: string }> = {
  welcome: {
    headline: "Join or create a community",
    sub: "Join with an invite, create your own, or reconnect one you already have.",
  },
  existing: {
    headline: "Reconnect to your community",
    sub: "Tell us your role so we can find the fastest way back in.",
  },
};

type Props = {
  mode: WorkspaceChoiceMode;
  onChoose: (choice: WorkspaceChoice) => void;
  /** Back out of this screen entirely; absent when there is nowhere to go. */
  onBack?: () => void;
  /**
   * Offered only when a community this identity auto-connected to before is
   * still recoverable from local storage.
   */
  onRestorePrevious?: () => void;
};

export function WorkspaceChoiceScreen({
  mode,
  onChoose,
  onBack,
  onRestorePrevious,
}: Props) {
  const head = HEAD[mode];

  return (
    <div className="onb-screen" data-testid={`workspace-choice-${mode}`}>
      <div className="onb-col-head">
        <h1 className="onb-headline">{head.headline}</h1>
        <p className="onb-sub">{head.sub}</p>
      </div>
      <div
        className="onb-options"
        role="listbox"
        aria-label={head.headline}
        tabIndex={-1}
      >
        {workspaceChoiceOptions(mode).map((option) => (
          <button
            aria-selected={false}
            className="onb-option"
            data-testid={option.testId}
            key={option.id}
            onClick={() => onChoose(option.id)}
            role="option"
            type="button"
          >
            <span>
              <span className="onb-option__title">{option.title}</span>
              <span className="onb-option__meta">{option.meta}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="onb-actions">
        {onRestorePrevious ? (
          <button
            className="onb-quiet-action"
            data-testid="restore-previous-community"
            onClick={onRestorePrevious}
            type="button"
          >
            Restore previous community
          </button>
        ) : null}
        {onBack ? (
          <button
            className="onb-quiet-action"
            data-testid={
              mode === "welcome" ? "welcome-setup-back" : "existing-back"
            }
            onClick={onBack}
            type="button"
          >
            Back
          </button>
        ) : null}
      </div>
    </div>
  );
}
