import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { NostrBindConsentDialog } from "@/features/profile/ui/NostrBindConsentDialog";
import "@fontsource-variable/inter/wght.css";
import "@/shared/styles/globals.css";
// Imported at the entry so the mark's sizing rules land in the always-loaded
// CSS bundle. Left only to ColonyLogoAnimation's own import, Vite emits this
// file into whichever lazy chunk claims it first (it shipped inside the
// UserProfilePanel chunk), and any other chunk rendering the mark got an
// unstyled svg at the browser's 300x150 replaced-element default.
import "@/shared/ui/colony-logo/colony-logo-animation.css";
import { UpdaterProvider } from "@/features/settings/hooks/UpdaterProvider";
import { migrateLegacyCommunityStorageBeforeRender } from "@/features/communities/legacyCommunityStorage";
import { CommunitiesProvider } from "@/features/communities/useCommunities";
import { huddleWindowChannelId } from "@/features/huddle/lib/huddleWindow";
import { CommunityOnboardingProvider } from "@/features/onboarding/communityOnboarding";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { EmojiBurstProvider } from "@/shared/ui/EmojiBurstProvider";
import { PoofBurstProvider } from "@/shared/ui/PoofBurstProvider";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { recoverLocalStorageQuotaOnStartup } from "@/shared/lib/localStorageQuota";
import { installTauriNativeBridge } from "@/shared/api/tauriNativeBridge";
import { registerAllTabKinds } from "@/features/workspace/kinds";

// Install the default (Tauri) bridge before anything can call it. The e2e
// mock replaces it in bootstrap via setNativeBridge when running under a
// mock bridge; feature code never sees a missing bridge.
installTauriNativeBridge();

type E2eWindow = Window & {
  __BUZZ_E2E__?: unknown;
};

const E2E_DEFAULT_PUBKEY = "deadbeef".repeat(8);
const E2E_COMMUNITY_ID = "e2e-default-community";
const ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX = "buzz-onboarding-complete.v1:";
const DEV_STATE_RESET_PARAM = "resetDevState";

function resetDevWebviewStateFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get(DEV_STATE_RESET_PARAM) !== "1") {
    return;
  }

  // WebKit groups every Buzz binary under one disk directory, but storage is
  // isolated by origin. Clearing here resets only this dev server's origin;
  // deleting the shared WebKit directory would also destroy installed-app state.
  window.localStorage.clear();
  window.sessionStorage.clear();
  url.searchParams.delete(DEV_STATE_RESET_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

function configureDevE2eBridgeFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get("e2e") !== "mock") {
    return;
  }

  const e2eWindow = window as E2eWindow;
  e2eWindow.__BUZZ_E2E__ ??= { mode: "mock" };

  const community = {
    addedAt: new Date().toISOString(),
    id: E2E_COMMUNITY_ID,
    name: "E2E Test",
    relayUrl: "ws://localhost:3000",
  };
  window.localStorage.setItem("buzz-communities", JSON.stringify([community]));
  window.localStorage.setItem("buzz-active-community-id", E2E_COMMUNITY_ID);
  window.localStorage.setItem(
    `${ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX}${E2E_DEFAULT_PUBKEY}`,
    "true",
  );
}

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <CommunitiesProvider>
        <CommunityOnboardingProvider enabled={huddleWindowChannelId() === null}>
          <ThemeProvider defaultTheme="buzz">
            <TooltipProvider delayDuration={300}>
              <EmojiBurstProvider>
                <PoofBurstProvider>
                  <UpdaterProvider>
                    <App />
                    <NostrBindConsentDialog />
                  </UpdaterProvider>
                  <Toaster />
                </PoofBurstProvider>
              </EmojiBurstProvider>
            </TooltipProvider>
          </ThemeProvider>
        </CommunityOnboardingProvider>
      </CommunitiesProvider>
    </React.StrictMode>,
  );
}

async function installE2eBridgeIfConfigured() {
  // The mock bridge is compiled only into dev and explicit E2E builds. A
  // pre-bootstrap global alone must never activate mock IPC in production.
  if (
    !(import.meta.env.DEV || import.meta.env.MODE === "e2e") ||
    !(window as E2eWindow).__BUZZ_E2E__
  ) {
    return;
  }

  const { maybeInstallE2eTauriMocks } = await import("@/testing/e2eBridge");
  maybeInstallE2eTauriMocks();
  const { installTerminalE2eBridge } = await import(
    "@/testing/terminalE2eBridge"
  );
  installTerminalE2eBridge();
  const { installWebE2eBridge } = await import("@/testing/webE2eBridge");
  installWebE2eBridge();
}

function maybeStartParitySession() {
  if (!import.meta.env.DEV) {
    return;
  }
  // `tauri dev` loads the devUrl without query params, so the session can
  // also be triggered from the environment: VITE_PARITY_MODE=record+replay
  // VITE_PARITY_PERTURB=result:send_channel_message pnpm tauri dev
  const url = new URL(window.location.href);
  const urlMode = url.searchParams.get("parity");
  const envMode = import.meta.env.VITE_PARITY_MODE;
  const mode = urlMode ?? (typeof envMode === "string" ? envMode : undefined);
  if (mode !== "record" && mode !== "record+replay") {
    return;
  }
  const specs = url.searchParams.getAll("perturb");
  const envPerturb = import.meta.env.VITE_PARITY_PERTURB;
  if (typeof envPerturb === "string" && envPerturb.length > 0) {
    specs.push(...envPerturb.split(","));
  }
  const perturbations: Array<{
    kind: "result" | "error";
    command: string;
  }> = [];
  for (const spec of specs) {
    const [kind, command] = spec.split(":", 2);
    if ((kind === "result" || kind === "error") && command) {
      perturbations.push({ kind, command });
    }
  }
  void import("@/parity/session/driver").then(({ runParitySession }) =>
    runParitySession({ mode, perturbations }),
  );
}

async function installRealShellHarnessIfConfigured() {
  // The WebDriverIO guest plugin (execute/mock/log surface) is bundled only
  // into harness-mode builds (Vite replaces import.meta.env.VITE_HARNESS at
  // compile time, so the branch and its import are eliminated from every
  // other build). It pairs with the feature-gated Rust plugins in
  // desktop/src-tauri; see desktop/e2e-real-shell/README.md.
  if (import.meta.env.VITE_HARNESS !== "1") {
    return;
  }

  // The harness runs the app from a background launch context; macOS keeps
  // the window off the visible screen there, and WKWebView freezes CSS
  // animations at their first keyframe (opacity 0), which makes WebDriver's
  // displayed check never resolve. Kill entrance animation for harness runs
  // only (desktop/src/harness-styles.css); the flows drive the real UI at
  // rest. Shipping builds never reach this branch.
  await import("@/harness-styles.css");
  await import("@wdio/tauri-plugin");
}

async function bootstrap() {
  resetDevWebviewStateFromUrl();
  configureDevE2eBridgeFromUrl();
  registerAllTabKinds();
  recoverLocalStorageQuotaOnStartup();
  await installE2eBridgeIfConfigured();
  await installRealShellHarnessIfConfigured();
  await migrateLegacyCommunityStorageBeforeRender();
  maybeStartParitySession();
  renderApp();
}

void bootstrap();
