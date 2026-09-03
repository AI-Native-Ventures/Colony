// desktop/src/features/onboarding/ui/new/screens/JoinWorkspaceScreen.tsx
import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { InviteRedeemForm } from "@/features/onboarding/ui/InviteRedeemForm";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";

export type JoinWorkspaceMode = "join" | "member";

const HEAD: Record<JoinWorkspaceMode, { headline: string; sub: string }> = {
  join: {
    headline: "Join a community",
    sub: "Enter the invite link or community URL you received.",
  },
  member: {
    headline: "Reconnect to your community",
    sub: "Enter the community URL or an invite link. Your role is restored when you connect.",
  },
};

type Props = {
  mode: JoinWorkspaceMode;
  /** Pre-fills the relay field when someone pastes a bare invite code. */
  defaultRelayUrl?: string;
  error: string | null;
  isRedeeming: boolean;
  onBack: () => void;
  onConnect: (relayWsUrl: string) => void;
  onRedeem: (relayWsUrl: string, code: string, policyReceipt?: string) => void;
  /** This identity's public ID, for the private-community handoff. */
  npub: string;
  /** Why the public ID could not be read, when it could not. */
  npubError?: string | null;
};

/**
 * "Join with an invite", on the canvas.
 *
 * Replaces the pastel WelcomeSetup join and member pages. The form itself is
 * the shared InviteRedeemForm in its canvas variant, so invite parsing, bare
 * codes and join policies stay in one place.
 */
export function JoinWorkspaceScreen({
  mode,
  defaultRelayUrl,
  error,
  isRedeeming,
  onBack,
  onConnect,
  onRedeem,
  npub,
  npubError = null,
}: Props) {
  const head = HEAD[mode];

  return (
    <div className="onb-screen" data-testid={`join-workspace-${mode}`}>
      <div className="onb-col-head">
        <h1 className="onb-headline">{head.headline}</h1>
        <p className="onb-sub">{head.sub}</p>
      </div>
      <div className="onb-panel">
        <InviteRedeemForm
          defaultRelayUrl={defaultRelayUrl}
          error={error}
          isRedeeming={isRedeeming}
          onCancel={onBack}
          onConnect={onConnect}
          onRedeem={onRedeem}
          variant="canvas"
        />
        {mode === "join" ? (
          <PrivateCommunityHandoff npub={npub} npubError={npubError} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Some communities admit people by public ID rather than by link. Without
 * this the only way through was to already know that, so it stays: a quiet
 * block under the field rather than a screen of its own.
 */
function PrivateCommunityHandoff({
  npub,
  npubError,
}: {
  npub: string;
  npubError: string | null;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="onb-stack">
      <p className="onb-note">
        Joining a private community? Some owners add you by hand. Send them your
        public ID.
      </p>
      <div className="onb-option-row">
        {/* Not `.onb-code`: that is the recovery screen's display treatment,
            sized for twelve words. An npub is 63 characters and overflows it. */}
        <code
          className="min-w-0 flex-1 truncate font-mono text-xs"
          data-testid="welcome-join-npub"
        >
          {npub || "Loading…"}
        </code>
        <Button
          aria-label="Copy public ID"
          disabled={!npub}
          onClick={() => {
            void writeTextToClipboard(npub).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {copied ? (
            <Check aria-hidden="true" className="h-4 w-4" />
          ) : (
            <Copy aria-hidden="true" className="h-4 w-4" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      {npubError ? <p className="onb-note onb-note-warn">{npubError}</p> : null}
    </div>
  );
}
