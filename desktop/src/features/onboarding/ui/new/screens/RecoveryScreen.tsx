import { useState } from "react";
import { Button } from "@/shared/ui/button";

/** Native save and explicit copy acknowledgement are the only ways forward. */
export function RecoveryScreen({
  code,
  onSave,
  onContinue,
  onSignIn,
  loading = false,
  loadError,
  onRetry,
}: {
  code: string;
  onSave: () => Promise<string | null>;
  onContinue: () => Promise<void>;
  onSignIn?: () => void;
  loading?: boolean;
  loadError?: string | null;
  onRetry?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await onSave();
      if (saved === null) {
        setError(
          "Your code was not saved. Choose a location, or copy it instead.",
        );
        return;
      }
      await onContinue();
    } catch {
      setError(
        "We could not finish saving your recovery code. Try again. You can also copy it below.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!code.trim() || busy) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
      setAcknowledged(false);
      setError("We could not copy the code. Use Save and continue instead.");
    }
  }
  async function confirmCopy() {
    if (!copied || !acknowledged || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onContinue();
    } catch {
      setError("We could not record that your code is safe. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="onb-simple" data-testid="onboarding-recovery">
      <header className="onb-simple-heading">
        <p className="onb-eyebrow">One important thing</p>
        <h1>Keep your way back in</h1>
        <p>Keep this code safe. You need it if you forget your password.</p>
      </header>
      <div className="onb-simple-card">
        {loading ? (
          <p role="status">Opening your recovery code…</p>
        ) : !code.trim() ? (
          <>
            <p className="onb-simple-error" role="alert">
              {loadError ??
                "The original recovery code is no longer available on this device. Sign in to your account to continue. We cannot create a replacement code here."}
            </p>
            {onRetry && (
              <Button
                className="onb-simple-button onb-simple-primary"
                onClick={onRetry}
              >
                Try again
              </Button>
            )}
            {onSignIn && (
              <button
                className="onb-simple-link"
                type="button"
                onClick={onSignIn}
              >
                Sign in to your account
              </button>
            )}
          </>
        ) : (
          <>
            <p
              className="onb-recovery-code"
              data-testid="onboarding-recovery-code"
            >
              {code}
            </p>
            <p className="onb-simple-note">
              Save it somewhere private, outside Colony.
            </p>
            {error && (
              <p className="onb-simple-error" role="alert">
                {error}
              </p>
            )}
            <Button
              className="onb-simple-button onb-simple-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save and continue"}
            </Button>
            <button
              className="onb-simple-link"
              disabled={busy}
              type="button"
              onClick={() => void copy()}
            >
              {copied ? "Copy again" : "Copy instead"}
            </button>
            {copied && (
              <>
                <label className="onb-simple-check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I have stored my copied code somewhere safe
                </label>
                <Button
                  className="onb-simple-button"
                  variant="outline"
                  disabled={!acknowledged || busy}
                  onClick={() => void confirmCopy()}
                >
                  Continue with saved copy
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
