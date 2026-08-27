// desktop/src/features/onboarding/ui/new/screens/InviteScreen.tsx
import { useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { isEmail } from "../../../flow/validation";

/**
 * Pasting a list is the normal way people do this, so split before judging.
 * Rejected entries come back so the screen can name them instead of silently
 * swallowing what the user typed.
 */
export function parseInviteEntry(
  raw: string,
  existing: readonly string[],
): { added: string[]; rejected: string[] } {
  const seen = new Set(existing.map((entry) => entry.toLowerCase()));
  const added: string[] = [];
  const rejected: string[] = [];

  for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
    if (!isEmail(part)) {
      rejected.push(part);
      continue;
    }
    if (seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    added.push(part);
  }

  return { added, rejected };
}

type Props = {
  invites: string[];
  onChange: (invites: string[]) => void;
  onSend: () => void;
  onSkip: () => void;
  onBack: () => void;
  /** Onboarding is handing off to the app; the actions wait it out. */
  finishing?: boolean;
  /** Why the handoff failed, in the user's words. */
  finishError?: string | null;
  /** Retries a failed handoff without redoing the flow. */
  onRetryFinish?: () => void;
};

export function InviteScreen({
  invites,
  onChange,
  onSend,
  onSkip,
  onBack,
  finishing = false,
  finishError = null,
  onRetryFinish,
}: Props) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState("");

  const commit = () => {
    if (!draft.trim()) return;
    const { added, rejected } = parseInviteEntry(draft, invites);
    if (added.length) onChange([...invites, ...added]);
    setDraft(rejected.join(" "));
    setProblem(rejected.length ? `Could not read: ${rejected.join(", ")}` : "");
  };

  return (
    <div className="onb-screen">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Who else is <em>coming</em>?
        </h1>
        <p className="onb-sub">
          They get an email with a link that brings them straight into your
          workspace.
        </p>
      </div>
      <div className="onb-panel">
        {invites.length ? (
          <div className="onb-pills">
            {invites.map((entry) => (
              <span key={entry} className="onb-pill">
                {entry}
                <button
                  type="button"
                  aria-label={`Remove ${entry}`}
                  onClick={() =>
                    onChange(invites.filter((item) => item !== entry))
                  }
                >
                  x
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <Input
          value={draft}
          placeholder="name@company.com"
          onChange={(event) => {
            setDraft(event.target.value);
            if (problem) setProblem("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
        />
        <p className={`onb-note${problem ? " onb-note-warn" : ""}`}>
          {problem || "Press enter after each address."}
        </p>
      </div>
      {finishError && onRetryFinish ? (
        <p className="onb-note onb-note-warn">
          {finishError}{" "}
          <button
            type="button"
            className="onb-quiet-action"
            onClick={onRetryFinish}
          >
            Try again
          </button>
        </p>
      ) : null}
      <div className="onb-actions">
        <Button
          size="lg"
          disabled={!invites.length || finishing}
          onClick={onSend}
        >
          {invites.length ? "Send invites" : "Add an address to send invites"}
        </Button>
        <button
          type="button"
          className="onb-quiet-action"
          disabled={finishing}
          onClick={onSkip}
        >
          {finishing ? "Opening your workspace" : "It is just me for now"}
        </button>
        <button
          type="button"
          className="onb-quiet-action"
          disabled={finishing}
          onClick={onBack}
        >
          Back
        </button>
      </div>
    </div>
  );
}
