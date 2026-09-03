import * as React from "react";
import { Check, Copy } from "lucide-react";

import { useCommunityOnboarding } from "@/features/onboarding/communityOnboarding";
import { nsecToNpub, pubkeyToNpub } from "@/shared/lib/nostrUtils";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { InviteRedeemForm } from "./InviteRedeemForm";
import { MachineCanvas } from "./new/MachineCanvas";
import { writeTextToClipboard } from "@/shared/lib/clipboard";

type MembershipDeniedProps = {
  /** The relay that denied membership, and the target for bare-code invites. */
  activeRelayUrl: string;
  onBack: () => void;
  onChangeCommunity: () => void;
  onImportKey: (nsec: string) => Promise<void>;
  onRetry: () => void;
  pubkey: string;
};

export function MembershipDenied({
  activeRelayUrl,
  onBack,
  onChangeCommunity,
  onImportKey,
  onRetry,
  pubkey,
}: MembershipDeniedProps) {
  const npub = React.useMemo(() => {
    if (!pubkey) {
      return "Unknown public key";
    }

    try {
      return pubkeyToNpub(pubkey);
    } catch {
      return pubkey;
    }
  }, [pubkey]);
  const [copied, setCopied] = React.useState(false);
  const [importError, setImportError] = React.useState<string | null>(null);
  const [isImportFormOpen, setIsImportFormOpen] = React.useState(false);
  const [isImportingKey, setIsImportingKey] = React.useState(false);
  const [nsecInput, setNsecInput] = React.useState("");
  const previewNpub = React.useMemo(() => nsecToNpub(nsecInput), [nsecInput]);
  const trimmedNsec = nsecInput.trim();
  const isValidNsec = previewNpub !== null;

  const [isInviteFormOpen, setIsInviteFormOpen] = React.useState(false);
  const communityOnboarding = useCommunityOnboarding();

  const handleCopy = React.useCallback(async () => {
    try {
      await writeTextToClipboard(npub);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text so the user can copy manually
    }
  }, [npub]);

  const handleImportKey = React.useCallback(async () => {
    if (!previewNpub) {
      setImportError(
        "That doesn't look like a valid nsec. Paste an nsec1 key.",
      );
      return;
    }

    setImportError(null);
    setIsImportingKey(true);

    try {
      await onImportKey(trimmedNsec);
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Failed to import key.",
      );
    } finally {
      setIsImportingKey(false);
    }
  }, [onImportKey, previewNpub, trimmedNsec]);

  const handleInviteRedeem = React.useCallback(
    (relayWsUrl: string, code: string, policyReceipt?: string) => {
      communityOnboarding.start({
        source: "membership-recovery",
        relayUrl: relayWsUrl,
        inviteCode: code,
        policyReceipt,
      });
    },
    [communityOnboarding],
  );

  return (
    <MachineCanvas showStep={false} step="identity" testId="membership-denied">
      <StartupWindowDragRegion />
      <div className="onb-screen">
        <div className="onb-col-head">
          <h1 className="onb-headline">
            Not a <em>member</em> yet.
          </h1>
          <p className="onb-sub">
            This community is invitation only. Ask an admin to add you, then
            come back and try again.
          </p>
        </div>

        <div className="onb-panel">
          {isInviteFormOpen ? (
            <InviteRedeemForm
              defaultRelayUrl={activeRelayUrl}
              error={null}
              isRedeeming={false}
              onCancel={() => setIsInviteFormOpen(false)}
              onRedeem={handleInviteRedeem}
              variant="canvas"
            />
          ) : isImportFormOpen ? (
            <form
              className="onb-stack"
              id="membership-denied-import"
              onSubmit={(event) => {
                event.preventDefault();
                void handleImportKey();
              }}
            >
              <label className="onb-field" htmlFor="membership-denied-nsec">
                <span className="onb-label">Private key</span>
                <Input
                  autoComplete="off"
                  autoCorrect="off"
                  data-testid="membership-denied-nsec-input"
                  disabled={isImportingKey}
                  id="membership-denied-nsec"
                  onChange={(event) => {
                    setNsecInput(event.target.value);
                    setImportError(null);
                  }}
                  placeholder="nsec1..."
                  spellCheck={false}
                  type="password"
                  value={nsecInput}
                />
              </label>

              {previewNpub ? (
                <div
                  className="onb-key-row"
                  data-testid="membership-denied-npub-preview"
                >
                  <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="onb-label">
                      This will use this Nostr identity:
                    </p>
                    <p className="onb-key">{previewNpub}</p>
                  </div>
                </div>
              ) : null}

              {importError ? (
                <p className="onb-note onb-note-warn">{importError}</p>
              ) : null}
            </form>
          ) : (
            <div className="onb-stack">
              <div className="onb-field">
                <span className="onb-label">Your public key (npub)</span>
                <div className="onb-key-row">
                  <code className="onb-key">{npub}</code>
                  <button
                    className="onb-key-copy"
                    onClick={() => {
                      void handleCopy();
                    }}
                    title="Copy npub"
                    type="button"
                  >
                    {copied ? (
                      <Check aria-hidden="true" className="h-4 w-4" />
                    ) : (
                      <Copy aria-hidden="true" className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              <p className="onb-note">
                This is your public identity, so it is safe to share. Send it to
                an admin so they can invite you.
              </p>
            </div>
          )}
        </div>

        {isInviteFormOpen ? null : isImportFormOpen ? (
          <div className="onb-actions">
            <Button
              data-testid="membership-denied-import-key"
              disabled={!isValidNsec || isImportingKey}
              form="membership-denied-import"
              size="lg"
              type="submit"
            >
              {isImportingKey ? (
                <Spinner
                  aria-label="Importing key"
                  className="h-4 w-4 border-2"
                />
              ) : (
                "Import key"
              )}
            </Button>
            <button
              className="onb-quiet-action"
              disabled={isImportingKey}
              onClick={() => {
                setImportError(null);
                setIsImportFormOpen(false);
                setNsecInput("");
              }}
              type="button"
            >
              Back
            </button>
          </div>
        ) : (
          <div className="onb-actions">
            <Button onClick={onRetry} size="lg" type="button">
              Try again
            </Button>
            <button className="onb-quiet-action" onClick={onBack} type="button">
              Back
            </button>
            <button
              className="onb-quiet-action"
              onClick={onChangeCommunity}
              type="button"
            >
              Change community
            </button>
            <button
              className="onb-quiet-action"
              data-testid="membership-denied-redeem-invite"
              onClick={() => setIsInviteFormOpen(true)}
              type="button"
            >
              Have an invite?
            </button>
            <button
              className="onb-quiet-action"
              data-testid="membership-denied-change-key"
              onClick={() => {
                setImportError(null);
                setIsImportFormOpen(true);
              }}
              type="button"
            >
              Use a different key
            </button>
          </div>
        )}
      </div>
    </MachineCanvas>
  );
}
