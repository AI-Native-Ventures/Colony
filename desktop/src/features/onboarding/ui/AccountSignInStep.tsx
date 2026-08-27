import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { AuthFailure } from "../authService";
import type { OnboardingServices } from "../contracts";
import { isEmail } from "../flow/validation";

type Props = {
  auth: OnboardingServices["auth"];
  /**
   * Runs once sign-in or recovery succeeded and the returned backup is
   * already imported into this computer's keyring: resolves the live
   * identity and completes machine onboarding, mirroring the key-import
   * path's handoff.
   */
  onCompleteIdentity: () => Promise<void>;
  /** Present only on the account-signin detour, where both doors exist. */
  onUsePrivateKey?: () => void;
  /** Mirrors NostrKeyImportForm's contract so chrome back can disable. */
  onBusyChange?: (busy: boolean) => void;
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

/**
 * The email-and-password door of the machine flow's sign-in detour.
 *
 * Two modes behind one headline: the ordinary password sign-in, and the
 * recovery-code fallback for anyone who lost their password. Both run through
 * the typed auth service, so every failure here is one of AuthFailure's
 * members and none of them ever clears what was already typed.
 */
export function AccountSignInStep({
  auth,
  onCompleteIdentity,
  onUsePrivateKey,
  onBusyChange,
}: Props) {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);
  const lockSeconds = useSecondsRemaining(
    failure?.kind === "locked" ? failure.retryAfterSecs : null,
  );
  const trimmedEmail = email.trim();
  const ready =
    isEmail(trimmedEmail) &&
    (mode === "password"
      ? password.length > 0
      : recoveryCode.trim().length > 0);

  function setBusy(next: boolean) {
    setPending(next);
    onBusyChange?.(next);
  }

  async function handleSubmit() {
    if (!ready || pending) return;
    setFailure(null);
    setBusy(true);
    try {
      if (mode === "password") {
        await auth.signIn(trimmedEmail, password);
      } else {
        await auth.recover(trimmedEmail, recoveryCode.trim());
      }
      await onCompleteIdentity();
    } catch (thrown) {
      // authService throws the typed union; anything else still lands on the
      // generic retry state rather than vanishing. Either way everything
      // typed stays on screen, including the password.
      setFailure(
        typeof thrown === "object" && thrown !== null && "kind" in thrown
          ? (thrown as AuthFailure)
          : { kind: "unreachable" },
      );
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: "password" | "recovery") {
    setMode(next);
    setFailure(null);
  }

  return (
    <>
      <div className="onb-col-head">
        <h1 className="onb-headline">Welcome back.</h1>
        <p className="onb-sub">
          Sign in with the email you used to set up Colony.
        </p>
      </div>
      <div className="mx-auto mt-10 w-full max-w-[24rem]">
        <label className="onb-field" htmlFor="onb-signin-email">
          <span className="onb-label">Email</span>
          <Input
            id="onb-signin-email"
            type="email"
            value={email}
            placeholder="you@company.com"
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready && !pending)
                void handleSubmit();
            }}
          />
        </label>
        {mode === "password" ? (
          <label className="onb-field" htmlFor="onb-signin-password">
            <span className="onb-label">Password</span>
            <Input
              id="onb-signin-password"
              type="password"
              value={password}
              placeholder="Your password"
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready && !pending)
                  void handleSubmit();
              }}
            />
          </label>
        ) : (
          <label className="onb-field" htmlFor="onb-signin-recovery-code">
            <span className="onb-label">Recovery code</span>
            <Input
              id="onb-signin-recovery-code"
              value={recoveryCode}
              placeholder="ABCDE-FGHJK-MNPQR-STVWX"
              autoComplete="off"
              onChange={(e) => setRecoveryCode(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && ready && !pending)
                  void handleSubmit();
              }}
            />
          </label>
        )}
        {mode === "recovery" ? (
          <p className="onb-note">
            Your recovery code lives in colony-recovery-code.txt, saved when you
            created your account.
          </p>
        ) : null}
      </div>
      {failure !== null ? (
        <p
          aria-live="assertive"
          className="onb-note onb-note-warn mx-auto max-w-[34rem] text-center"
          data-testid="signin-failure"
          role="alert"
        >
          {failure.kind === "invalid-credentials"
            ? mode === "recovery"
              ? "That recovery code does not match that email. Check both and try again."
              : "That email or password does not match an account. Check them and try again."
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
        <Button
          disabled={!ready || pending}
          onClick={() => void handleSubmit()}
          size="lg"
          type="button"
        >
          {pending ? "Signing you in..." : "Sign in"}
        </Button>
      </div>
      <div className="mt-2 flex flex-col items-center gap-1">
        {mode === "password" ? (
          <button
            className="onb-quiet-action"
            data-testid="signin-use-recovery-code"
            onClick={() => switchMode("recovery")}
            type="button"
          >
            Forgot your password? Use your recovery code.
          </button>
        ) : (
          <button
            className="onb-quiet-action"
            data-testid="signin-use-password"
            onClick={() => switchMode("password")}
            type="button"
          >
            Use your password instead.
          </button>
        )}
        {onUsePrivateKey ? (
          <button
            className="onb-quiet-action"
            data-testid="signin-use-private-key"
            onClick={onUsePrivateKey}
            type="button"
          >
            Use your private key instead.
          </button>
        ) : null}
      </div>
    </>
  );
}
