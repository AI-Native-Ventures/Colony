import { useEffect, useRef, useState } from "react";
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/shared/lib/safeStorage";
import {
  clearAccountNameDraft,
  readAccountNameDraft,
  saveAccountNameDraft,
} from "../../accountNameDraft";
import type { AuthFailure } from "../../authService";
import type { OnboardingServices, SignUpResult } from "../../contracts";
import {
  AccountScreen,
  accountReady,
  type AccountValues,
} from "./screens/AccountScreen";

const nameStorage = {
  get: getStorageItem,
  set: setStorageItem,
  remove: (key: string) => void removeStorageItem(key),
};

/** Shared account entry before and after the native machine boundary. */
export function AccountSetup({
  auth,
  onCreated,
  onSignIn,
  onUsePrivateKey,
}: {
  auth: OnboardingServices["auth"];
  onCreated: (
    result: SignUpResult,
    email: string,
    fullName: string,
  ) => Promise<void>;
  onSignIn?: () => void;
  onUsePrivateKey?: () => void;
}) {
  const [values, setValues] = useState<AccountValues>({
    name: "",
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
        const fullName = readAccountNameDraft(nameStorage, pending.email);
        setValues((current) => ({
          ...current,
          name: current.name || fullName,
          email: current.email || pending.email,
        }));
        if (pending.phase === "registered") {
          running.current = true;
          setBusy(true);
          void createdRef
            .current(pending, pending.email, fullName)
            .then(() => clearAccountNameDraft(nameStorage, pending.email))
            .catch(() => {
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
      const fullName = values.name?.trim() ?? "";
      saveAccountNameDraft(nameStorage, email, fullName);
      const result = await auth.signUp(email, values.password);
      await onCreated(result, email, fullName);
      clearAccountNameDraft(nameStorage, email);
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
