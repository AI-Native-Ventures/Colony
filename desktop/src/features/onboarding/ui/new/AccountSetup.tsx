import { useEffect, useRef, useState } from "react";
import type { AuthFailure } from "../../authService";
import type { OnboardingServices, SignUpResult } from "../../contracts";
import {
  AccountScreen,
  accountReady,
  type AccountValues,
} from "./screens/AccountScreen";

/** Shared account entry before and after the native machine boundary. */
export function AccountSetup({
  auth,
  onCreated,
  onSignIn,
  onUsePrivateKey,
}: {
  auth: OnboardingServices["auth"];
  onCreated: (result: SignUpResult, email: string) => Promise<void>;
  onSignIn?: () => void;
  onUsePrivateKey?: () => void;
}) {
  const [values, setValues] = useState<AccountValues>({
    email: "",
    password: "",
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const running = useRef(false);
  const createdRef = useRef(onCreated);
  createdRef.current = onCreated;
  useEffect(() => {
    let cancelled = false;
    void auth
      .pendingSignup()
      .then((pending) => {
        if (cancelled || !pending) return;
        setValues((current) => ({
          ...current,
          email: current.email || pending.email,
        }));
        if (pending.phase === "registered") {
          running.current = true;
          setBusy(true);
          void createdRef.current(pending, pending.email).catch(() => {
            if (!cancelled) {
              setFailure({ kind: "local-storage" });
              setBusy(false);
              running.current = false;
            }
          });
        }
      })
      .catch(() => {
        if (!cancelled) setFailure({ kind: "local-storage" });
      });
    return () => {
      cancelled = true;
    };
  }, [auth]);
  async function submit() {
    if (running.current || !accountReady(values)) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const email = values.email.trim();
      const result = await auth.signUp(email, values.password);
      await onCreated(result, email);
    } catch (error) {
      setFailure(
        typeof error === "object" && error !== null && "kind" in error
          ? (error as AuthFailure)
          : { kind: "local-storage" },
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <AccountScreen
      values={values}
      onChange={(patch) => {
        setValues((current) => ({ ...current, ...patch }));
        setFailure(null);
      }}
      onSubmit={() => void submit()}
      isSubmitting={busy}
      failure={failure}
      onSignInRequest={onSignIn}
      onUsePrivateKey={onUsePrivateKey}
    />
  );
}
