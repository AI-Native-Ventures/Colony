import * as React from "react";
import type { QueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";

import {
  getIdentity,
  importIdentity,
  persistCurrentIdentity,
} from "@/shared/api/tauriIdentity";
import type { IdentityStorage } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { BackupStep } from "./BackupStep";
import { DefaultConfigStep } from "./DefaultConfigStep";
import { DownloadKeyStep } from "./DownloadKeyStep";
import {
  backupSessionToPasswordEntry,
  resetEncryptedBackupSession,
  useEncryptedBackupSession,
} from "./EncryptedBackupCreator";
import { IdentityKeyHelpDialog } from "./IdentityKeyHelpDialog";
import { IdentityRecoveryPairing } from "./IdentityRecoveryPairing";
import { MachineCanvas } from "./new/MachineCanvas";
import type { MachineStep } from "./new/machineSteps";
import {
  NostrKeyImportForm,
  type NostrKeyImportStage,
} from "./NostrKeyImportForm";
import { ONBOARDING_INK_ICON_CLASS } from "./OnboardingChrome";
import { OnboardingFooterProvider } from "./OnboardingFooter";
import {
  type OnboardingTransitionDirection,
  OnboardingSlideTransition,
} from "./OnboardingSlideTransition";
import { SetupStep } from "./SetupStep";
import type { DefaultConfigDraft } from "./types";

export type MachineOnboardingPage =
  | "identity"
  | "key-import"
  | "backup"
  | "setup"
  | "config";

type BackupSubview = "created" | "options" | "password";

/**
 * Which canvas each page wears. Key import is a detour off the landing
 * screen rather than a step of its own, so it keeps the landing hue: the
 * colour would otherwise announce progress the person has not made.
 */
const MACHINE_PAGE_STEP: Record<MachineOnboardingPage, MachineStep> = {
  identity: "identity",
  "key-import": "identity",
  backup: "backup",
  setup: "setup",
  config: "config",
};

/** A pending navigation the parent should execute after RouterProvider mounts. */
export type PostOnboardingNavigation = {
  to: string;
  search?: Record<string, string>;
};

export function MachineOnboardingFlow({
  complete,
  continueWithIdentity,
  continueWithRecoveredIdentity,
  identityLost,
  initialPage,
  queryClient,
  navigateAfterComplete,
}: {
  complete: (pubkey?: string) => void;
  continueWithIdentity: (pubkey: string) => void;
  continueWithRecoveredIdentity: (pubkey: string) => void;
  identityLost: boolean;
  initialPage?: MachineOnboardingPage;
  queryClient: QueryClient;
  /**
   * Called when the user finishes onboarding and requests navigation to a
   * specific route (e.g. Settings → Agents). The parent owns the RouterProvider,
   * so navigation must be deferred to it — calling router.navigate() here races
   * with RouterProvider mounting.
   */
  navigateAfterComplete?: (nav: PostOnboardingNavigation) => void;
}) {
  const [page, setPage] = React.useState<MachineOnboardingPage>(
    identityLost ? "key-import" : (initialPage ?? "identity"),
  );
  const [transitionDirection, setTransitionDirection] =
    React.useState<OnboardingTransitionDirection>("forward");
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, setIsPending] = React.useState(false);
  const [keyImportStage, setKeyImportStage] =
    React.useState<NostrKeyImportStage>("key-entry");
  const [isKeyImporting, setIsKeyImporting] = React.useState(false);
  const [keyImportFormKey, setKeyImportFormKey] = React.useState(0);
  const [keyImportDialog, setKeyImportDialog] = React.useState<
    "backup" | "phone" | null
  >(null);
  const [phoneRecoveryStep, setPhoneRecoveryStep] = React.useState("loading");
  const selectedPubkey: string | null = null;
  const identityStorage: IdentityStorage | undefined = undefined;
  const [readyRuntimeIds, setReadyRuntimeIds] = React.useState<string[]>([]);
  const [defaultConfigDraft, setDefaultConfigDraft] =
    React.useState<DefaultConfigDraft | null>(null);
  const [isDefaultConfigSaving, setIsDefaultConfigSaving] =
    React.useState(false);
  const [backupSubview, setBackupSubview] =
    React.useState<BackupSubview>("created");
  const [backupDirection, setBackupDirection] = React.useState<
    "forward" | "backward"
  >("forward");
  const [returningFromSecurity, setReturningFromSecurity] =
    React.useState(false);
  // Owned here so switching between the yellow onboarding view and the dark
  // security subview keeps the created backup, password, and test progress.
  const backupSession = useEncryptedBackupSession();
  const reduceMotion = useReducedMotion() ?? false;
  const isSecuritySubview = page === "backup" && backupSubview !== "created";
  const handleReadyRuntimeIdsChange = React.useCallback(
    (runtimeIds: readonly string[]) => {
      setReadyRuntimeIds(Array.from(new Set(runtimeIds)));
    },
    [],
  );

  const loadFreshIdentity = React.useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const identity = await getIdentity();
      queryClient.setQueryData(["identity"], identity);
      window.localStorage.setItem(
        `buzz-identity-backup-reminder.v1:${identity.pubkey}`,
        "pending",
      );
      complete(identity.pubkey);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load identity",
      );
    } finally {
      setIsPending(false);
    }
  }, [complete, queryClient]);

  const loadRecoveredIdentity = React.useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const identity = await getIdentity();
      continueWithRecoveredIdentity(identity.pubkey);
      queryClient.setQueryData(["identity"], identity);
      complete(identity.pubkey);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load identity",
      );
    } finally {
      setIsPending(false);
    }
  }, [complete, continueWithRecoveredIdentity, queryClient]);

  const replaceLostIdentity = React.useCallback(async () => {
    const confirmed = window.confirm(
      "This will create a new identity and abandon your previous key. This cannot be undone. Continue?",
    );
    if (!confirmed) return;

    setIsPending(true);
    setError(null);
    try {
      const identity = await persistCurrentIdentity();
      queryClient.setQueryData(["identity"], identity);
      window.localStorage.setItem(
        `buzz-identity-backup-reminder.v1:${identity.pubkey}`,
        "pending",
      );
      complete(identity.pubkey);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to save identity",
      );
    } finally {
      setIsPending(false);
    }
  }, [complete, queryClient]);

  const importExistingIdentity = React.useCallback(
    async (nsec: string, password?: string) => {
      const identity = await importIdentity(nsec, password);
      continueWithIdentity(identity.pubkey);
      queryClient.setQueryData(["identity"], identity);
      complete(identity.pubkey);
    },
    [complete, continueWithIdentity, queryClient],
  );

  const backFromKeyImport = React.useCallback(() => {
    if (keyImportStage === "backup-password") {
      setKeyImportFormKey((current) => current + 1);
      setKeyImportStage("key-entry");
      return;
    }
    setTransitionDirection("backward");
    setPage("identity");
  }, [keyImportStage]);

  const returnToCreatedKey = React.useCallback(() => {
    setBackupDirection("backward");
    setReturningFromSecurity(true);
    setBackupSubview("created");
  }, []);

  const backFromPasswordBackup = React.useCallback(() => {
    resetEncryptedBackupSession(backupSession);
    setBackupDirection("backward");
    setReturningFromSecurity(false);
    setBackupSubview("options");
  }, [backupSession]);

  const backFromSetup = React.useCallback(() => {
    if (backupSubview === "password") {
      backupSessionToPasswordEntry(backupSession);
    }
    setBackupDirection("backward");
    setTransitionDirection("backward");
    setReturningFromSecurity(false);
    setPage("backup");
  }, [backupSession, backupSubview]);

  const chromeBackAction =
    page === "key-import" &&
    (!identityLost || keyImportStage === "backup-password")
      ? { disabled: isKeyImporting, onClick: backFromKeyImport }
      : page === "backup" && backupSubview !== "created"
        ? {
            label: "Return to onboarding",
            onClick: returnToCreatedKey,
            testId: "backup-return-to-onboarding",
          }
        : page === "backup"
          ? {
              onClick: () => {
                setTransitionDirection("backward");
                setPage("identity");
              },
            }
          : page === "setup"
            ? { onClick: backFromSetup }
            : page === "config"
              ? {
                  disabled: isDefaultConfigSaving,
                  onClick: () => {
                    setTransitionDirection("backward");
                    setPage("setup");
                  },
                }
              : undefined;

  return (
    <MachineCanvas
      // The security subview is its own dark ceremony; it keeps the canvas
      // but not the step marker, because it is a detour rather than a step.
      showStep={page !== "identity" && !isSecuritySubview}
      step={MACHINE_PAGE_STEP[page]}
    >
      <StartupWindowDragRegion />
      <OnboardingFooterProvider backAction={chromeBackAction}>
        {/* The landing screen is a hero, not a step: one centred column with
            nothing in a second one. Every other page fills the width, because
            the steps inside them bring their own grids. */}
        <div
          className="onb-screen"
          data-solo={page === "identity"}
          data-wide={page !== "identity"}
        >
          {page === "identity" ? (
            <OnboardingSlideTransition
              className="onb-hero"
              direction={transitionDirection}
              transitionKey={`machine-identity-${transitionDirection}`}
            >
              <div className="onb-col-head">
                <img
                  alt="Colony"
                  className="onb-wordmark"
                  src="/landing/colony-wordmark.svg"
                />
                <p className="onb-sub">
                  Your people, your agents, your projects, all in one place.
                </p>
              </div>
              {error ? <p className="onb-note-warn">{error}</p> : null}
              <div className="onb-actions">
                <Button
                  disabled={isPending}
                  onClick={() => void loadFreshIdentity()}
                  size="lg"
                  type="button"
                >
                  {isPending
                    ? "Starting Colony…"
                    : selectedPubkey
                      ? "Continue"
                      : "Start with Colony"}
                </Button>
                <button
                  className="onb-quiet-action"
                  disabled={isPending}
                  onClick={() => {
                    setKeyImportDialog(null);
                    setKeyImportStage("key-entry");
                    setTransitionDirection("forward");
                    setPage("key-import");
                  }}
                  type="button"
                >
                  {selectedPubkey
                    ? "Use a different account"
                    : "Sign in to an existing account"}
                </button>
              </div>
              <IdentityKeyHelpDialog />
            </OnboardingSlideTransition>
          ) : page === "key-import" ? (
            <OnboardingSlideTransition
              className="onb-screen"
              data-solo="true"
              direction={transitionDirection}
              transitionKey={`machine-key-import-${transitionDirection}`}
            >
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="onb-col-head relative z-10 shrink-0"
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                key={keyImportStage}
                transition={{
                  duration: reduceMotion ? 0 : 0.3,
                  ease: "easeOut",
                }}
              >
                <h1 className="onb-headline">
                  {keyImportStage === "backup-password"
                    ? "Unlock your account"
                    : "Enter your private key"}
                </h1>
                <div className="onb-sub">
                  {keyImportStage === "backup-password" ? (
                    "Enter your backup password to restore your identity."
                  ) : (
                    <p>
                      Paste your private key to sign in to Colony. You can also
                      use a{" "}
                      <button
                        className="rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
                        data-testid="nostr-import-file-button"
                        disabled={isPending}
                        onClick={() => setKeyImportDialog("backup")}
                        type="button"
                      >
                        backup file
                      </button>
                      , or{" "}
                      <button
                        className="rounded-sm font-medium underline decoration-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
                        data-testid="nostr-import-phone-link"
                        disabled={isPending}
                        onClick={() => setKeyImportDialog("phone")}
                        type="button"
                      >
                        recover from your phone
                      </button>
                      .
                    </p>
                  )}
                </div>
              </motion.div>
              <div className="onb-panel buzz-onboarding-key-import-position w-full">
                <div className="flex flex-col items-center">
                  <NostrKeyImportForm
                    key={keyImportFormKey}
                    onBack={backFromKeyImport}
                    onImport={importExistingIdentity}
                    onImportingChange={setIsKeyImporting}
                    onStageChange={setKeyImportStage}
                    showBack={false}
                    showPasswordStageBack={false}
                    variant="spotlight"
                  />
                  {identityLost && keyImportStage === "key-entry" ? (
                    <button
                      className="onb-quiet-action mt-2"
                      disabled={isPending || isKeyImporting}
                      onClick={() => void replaceLostIdentity()}
                      type="button"
                    >
                      Start new identity
                    </button>
                  ) : null}
                </div>
              </div>
              <Dialog
                onOpenChange={(open) => {
                  if (!open) setKeyImportDialog(null);
                }}
                open={keyImportDialog === "backup"}
              >
                <DialogContent
                  className="buzz-onboarding-neutral-theme max-w-[47.5rem] -translate-y-5"
                  closeButtonClassName={ONBOARDING_INK_ICON_CLASS}
                  data-system-color-scheme="light"
                  data-testid="backup-recovery-dialog"
                  surface="textured"
                >
                  <div className="mx-auto w-full max-w-[35rem] pb-6 pt-10 text-center max-sm:pb-4 max-sm:pt-6">
                    <DialogTitle className="text-balance px-8 text-3xl font-normal text-foreground">
                      Restore from a backup file
                    </DialogTitle>
                    <DialogDescription className="mx-auto mt-4 max-w-[28rem] text-sm leading-6 text-foreground/80">
                      Choose the encrypted backup file you saved from Colony.
                    </DialogDescription>
                    <NostrKeyImportForm
                      footerMode="inline"
                      mode="backup"
                      onBack={() => setKeyImportDialog(null)}
                      onImport={importExistingIdentity}
                      showBack={false}
                      variant="spotlight"
                    />
                  </div>
                </DialogContent>
              </Dialog>
              <Dialog
                onOpenChange={(open) => {
                  if (!open) setKeyImportDialog(null);
                }}
                open={keyImportDialog === "phone"}
              >
                <DialogContent
                  className="buzz-onboarding-neutral-theme max-h-[calc(100dvh-2rem)] max-w-[47.5rem] -translate-y-5 overflow-y-auto"
                  closeButtonClassName={ONBOARDING_INK_ICON_CLASS}
                  data-system-color-scheme="light"
                  data-testid="phone-recovery-dialog"
                  surface="textured"
                >
                  <div className="mx-auto flex w-full max-w-[35rem] flex-col items-center pb-6 pt-8 text-center max-sm:pb-4 max-sm:pt-4">
                    <DialogTitle className="text-balance px-8 text-3xl font-normal text-foreground">
                      {identityLost
                        ? "Recover from your phone"
                        : "Use your Colony identity"}
                    </DialogTitle>
                    <DialogDescription className="mt-4 text-sm leading-6 text-foreground/80">
                      {phoneRecoveryStep === "loading" ||
                      phoneRecoveryStep === "qr"
                        ? "Scan this code with a signed-in Colony phone."
                        : "Confirm the code before sharing your identity."}
                    </DialogDescription>
                    <div className="mt-5">
                      <IdentityRecoveryPairing
                        onRecovered={loadRecoveredIdentity}
                        onStepChange={setPhoneRecoveryStep}
                      />
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </OnboardingSlideTransition>
          ) : page === "backup" ? (
            backupSubview === "password" ? (
              <DownloadKeyStep
                direction={backupDirection}
                onBack={backFromPasswordBackup}
                session={backupSession}
              />
            ) : (
              <BackupStep
                direction={backupDirection}
                identityStorage={identityStorage}
                onNext={() => {
                  setTransitionDirection("forward");
                  setPage("setup");
                }}
                onOpenPasswordBackup={() => {
                  resetEncryptedBackupSession(backupSession);
                  setBackupDirection("forward");
                  setReturningFromSecurity(false);
                  setBackupSubview("password");
                }}
                onShowOptions={() => {
                  setBackupDirection("forward");
                  setReturningFromSecurity(false);
                  setBackupSubview("options");
                }}
                optionsExpanded={backupSubview === "options"}
                returningFromSecurity={returningFromSecurity}
              />
            )
          ) : page === "setup" ? (
            <SetupStep
              actions={{
                // Fresh-key users return to whichever identity backup subview
                // they used to reach setup; imported keys skip backup entirely.
                back: () => {
                  backFromSetup();
                },
                next: (runtimeIds) => {
                  const ids = Array.from(runtimeIds);
                  setReadyRuntimeIds(ids);
                  // Harness install can fail (Windows/PATH/network). Don't soft-lock
                  // onboarding — users can finish setup later in Settings → Agents.
                  if (ids.length === 0) {
                    complete(selectedPubkey ?? undefined);
                    return;
                  }
                  setTransitionDirection("forward");
                  setPage("config");
                },
                navigateToAgentSettings: () => {
                  // Complete onboarding first, then delegate the Settings → Agents
                  // navigation to the parent.  The parent owns RouterProvider, so
                  // navigation from within the onboarding flow races with the
                  // router mounting — calling router.navigate() here is unsafe.
                  complete(selectedPubkey ?? undefined);
                  navigateAfterComplete?.({
                    to: "/settings",
                    search: { section: "agents" },
                  });
                },
              }}
              direction={transitionDirection}
              onReadyRuntimeIdsChange={handleReadyRuntimeIdsChange}
            />
          ) : (
            <DefaultConfigStep
              actions={{
                back: () => {
                  setTransitionDirection("backward");
                  setPage("setup");
                },
                complete: () => complete(selectedPubkey ?? undefined),
                discardDraft: () => setDefaultConfigDraft(null),
                updateDraft: setDefaultConfigDraft,
              }}
              direction={transitionDirection}
              draft={defaultConfigDraft}
              onSavingChange={setIsDefaultConfigSaving}
              readyRuntimeIds={readyRuntimeIds}
            />
          )}
        </div>
      </OnboardingFooterProvider>
    </MachineCanvas>
  );
}
