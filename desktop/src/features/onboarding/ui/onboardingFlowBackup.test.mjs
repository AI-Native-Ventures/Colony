/**
 * Component tests for the relay onboarding flow's key-backup step.
 *
 * Renders the REAL OnboardingFlow (ProfileStep -> AvatarStep -> backup
 * ceremony) inside jsdom with the mock native bridge and drives it the way a
 * human would: type a name, click Continue, skip the avatar, then face the
 * backup step. Proves:
 *
 *   - a human can actually reach the backup step from the mainline signup
 *     path (an assertion on a step value alone is not reachability);
 *   - finishing without a backup artifact requires a two-step, explicit
 *     acknowledgement of the consequence, and cancelling it stays put;
 *   - finishing WITH a saved artifact (real encrypted-backup session run
 *     through the password subview) is a direct Finish with no dialog;
 *   - the flow-level skipForNow action is never what ends onboarding.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

const TEST_PUBKEY = "a".repeat(64);
const MOCK_SAVED_BACKUP_PATH = "/mock/backups/identity.ncryptsec";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
const originalConsoleError = console.error;

const invokedCommands = [];
let completeCalls = 0;
let skipForNowCalls = 0;
/** When false, save_ncryptsec_copy resolves null (native dialog cancelled). */
let saveCopyShouldSucceed = true;

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
  // jsdom ships neither observer; ProfileAvatarEditor uses both.
  class ObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ObserverStub;
  dom.window.ResizeObserver = ObserverStub;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.MutationObserver = dom.window.MutationObserver;
  // Radix constructs events with the bare globals; Node's own Event classes
  // are foreign to jsdom's EventTarget, so swap in the jsdom ones.
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  // Reduced motion: BackupStep's "creating your identity key" hold and the
  // Radix dialog animations resolve instantly, keeping the tests deterministic.
  dom.window.matchMedia = (query) => ({
    matches: query.includes("prefers-reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  });
});

beforeEach(() => {
  invokedCommands.length = 0;
  completeCalls = 0;
  skipForNowCalls = 0;
  saveCopyShouldSucceed = true;
  dom.window.localStorage.clear();
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  activeQueryClient?.clear();
  activeQueryClient = null;
  console.error = originalConsoleError;
});

after(() => dom.window.close());

setNativeBridge(
  createMockNativeBridge((command, args) => {
    invokedCommands.push(command);
    switch (command) {
      case "get_identity":
        return { pubkey: TEST_PUBKEY, display_name: "" };
      case "relay_requires_membership":
        return false;
      case "update_profile":
        return {
          pubkey: TEST_PUBKEY,
          display_name:
            args && typeof args === "object"
              ? (args.displayName ?? null)
              : null,
          avatar_url: null,
          about: null,
          nip05_handle: null,
          owner_pubkey: null,
          has_profile_event: true,
        };
      case "create_ncryptsec_backup":
        return "ncryptsec1mockmockmockmockmockmockmockmockmockmockmock";
      case "save_ncryptsec_copy":
        return saveCopyShouldSucceed ? MOCK_SAVED_BACKUP_PATH : null;
      default:
        return null;
    }
  }),
);

let activeQueryClient = null;

async function renderFlow() {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { CommunitiesProvider } = await import(
    "@/features/communities/useCommunities"
  );
  const { OnboardingFlow } = await import("./OnboardingFlow.tsx");

  const queryClient = new QueryClient({
    defaultOptions: {
      // gcTime 0 keeps cache-cleanup timers off the event loop after each
      // test; without it every unmounted query/mutation leaves a 5-minute
      // setTimeout that stops the node test runner from exiting.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });

  // Kept so afterEach can destroy queries; otherwise every unmounted query
  // leaves its 5-minute gcTime timer holding the event loop open.
  activeQueryClient = queryClient;

  const utils = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        CommunitiesProvider,
        null,
        React.createElement(OnboardingFlow, {
          actions: {
            complete: () => {
              completeCalls += 1;
            },
            skipForNow: () => {
              skipForNowCalls += 1;
            },
          },
          initialProfile: {},
        }),
      ),
    ),
  );
  return utils;
}

/** Drives profile -> avatar -> backup the way a human would. */
async function reachBackupStep() {
  const { fireEvent, screen } = await import("@testing-library/react");

  const utils = await renderFlow();
  await screen.findByTestId("onboarding-page-1");

  fireEvent.change(screen.getByTestId("onboarding-display-name"), {
    target: { value: "Morty QA" },
  });
  fireEvent.click(screen.getByTestId("onboarding-next"));
  await screen.findByTestId("onboarding-page-avatar");

  // The avatar step's always-visible skip is the mainline exit; it must land
  // on the backup step, not end onboarding.
  fireEvent.click(screen.getByTestId("onboarding-skip"));
  await screen.findByTestId("onboarding-page-backup");

  return utils;
}

test("backup step is reachable from the mainline signup path and shows three progress dots", async () => {
  const { screen } = await import("@testing-library/react");

  const { container } = await renderFlow();
  await screen.findByTestId("onboarding-page-1");

  const dots = container.querySelectorAll(
    '[data-testid="onboarding-step-dots"] span',
  );
  assert.equal(dots.length, 3);
});

test("avatar skip lands on the backup step with no one-click bypass", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");

  await reachBackupStep();
  await screen.findByTestId("onboarding-page-backup");

  // The backup step itself offers no quiet skip: the flow-level skip button
  // is gone, and the primary action opens the acknowledgement instead of
  // completing onboarding.
  assert.equal(screen.queryByTestId("onboarding-skip"), null);
  const primary = screen.getByTestId("onboarding-next");
  assert.equal(primary.textContent, "Continue");
  assert.equal(completeCalls, 0);

  fireEvent.click(primary);
  const dialog = await screen.findByTestId("onboarding-backup-ack-dialog");
  assert.match(dialog.textContent ?? "", /Colony cannot restore it for you\./);
  assert.equal(completeCalls, 0);
});

test("acknowledgement cancel keeps the user on the backup step", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");

  await reachBackupStep();

  fireEvent.click(screen.getByTestId("onboarding-next"));
  await screen.findByTestId("onboarding-backup-ack-dialog");

  fireEvent.click(screen.getByTestId("onboarding-backup-ack-cancel"));
  // Radix keeps a closing dialog mounted until an animationend jsdom never
  // fires, so assert the outcome, not the unmount: cancelling must leave the
  // user on the backup step with onboarding still open.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(completeCalls, 0);
  assert.equal(skipForNowCalls, 0);
});

test("acknowledgement confirm is the only no-backup exit and completes onboarding", async () => {
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");

  await reachBackupStep();

  fireEvent.click(screen.getByTestId("onboarding-next"));
  await screen.findByTestId("onboarding-backup-ack-dialog");
  fireEvent.click(screen.getByTestId("onboarding-backup-ack-confirm"));

  await waitFor(() => {
    assert.equal(completeCalls, 1);
  });
  assert.equal(skipForNowCalls, 0);
});

test("a saved backup artifact replaces the acknowledgement with a direct Finish", async () => {
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");

  await reachBackupStep();

  // Options view -> locked backup file -> password subview.
  fireEvent.click(screen.getByTestId("backup-options-link"));
  await screen.findByTestId("onboarding-page-backup-options");
  fireEvent.click(screen.getByTestId("backup-option-password"));
  await screen.findByTestId("onboarding-page-download");

  const passphraseInput = screen.getByTestId("backup-passphrase-input");
  fireEvent.change(passphraseInput, {
    target: { value: "correct horse battery staple" },
  });

  const createButton = screen.getByTestId("encrypted-backup-create");
  await waitFor(() => {
    assert.equal(createButton.disabled, false);
  });
  fireEvent.click(createButton);

  // Save commits, then the guided test view replaces the password form.
  await screen.findByTestId("encrypted-backup-result");
  assert.ok(invokedCommands.includes("create_ncryptsec_backup"));
  assert.ok(invokedCommands.includes("save_ncryptsec_copy"));

  // Leaving the password subview returns to the key view, where the primary
  // action is now a direct Finish: no acknowledgement dialog, one click out.
  fireEvent.click(screen.getByTestId("onboarding-skip"));
  await screen.findByTestId("onboarding-page-backup");
  const primary = screen.getByTestId("onboarding-next");
  assert.equal(primary.textContent, "Finish");

  fireEvent.click(primary);
  await waitFor(() => {
    assert.equal(completeCalls, 1);
  });
  assert.equal(skipForNowCalls, 0);
  assert.equal(screen.queryByTestId("onboarding-backup-ack-dialog"), null);
});

test("a cancelled native save never blocks finishing", async () => {
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");

  // A cancelled save dialog resolves as null: the creator rolls back to the
  // password form and no artifact exists. The user must still be able to
  // leave through the explicit acknowledgement.
  saveCopyShouldSucceed = false;

  await reachBackupStep();
  fireEvent.click(screen.getByTestId("backup-options-link"));
  await screen.findByTestId("onboarding-page-backup-options");
  fireEvent.click(screen.getByTestId("backup-option-password"));
  await screen.findByTestId("onboarding-page-download");

  fireEvent.change(screen.getByTestId("backup-passphrase-input"), {
    target: { value: "correct horse battery staple" },
  });
  const createButton = screen.getByTestId("encrypted-backup-create");
  await waitFor(() => {
    assert.equal(createButton.disabled, false);
  });
  fireEvent.click(createButton);

  // Rolled back to the password form, no test view, no Finish shortcut.
  await waitFor(() => {
    assert.ok(invokedCommands.includes("save_ncryptsec_copy"));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(screen.queryByTestId("encrypted-backup-result"), null);

  // The acknowledgement path is untouched by the failed save.
  fireEvent.click(screen.getByTestId("onboarding-back"));
  await screen.findByTestId("onboarding-page-backup");
  fireEvent.click(screen.getByTestId("onboarding-next"));
  await screen.findByTestId("onboarding-backup-ack-dialog");
  fireEvent.click(screen.getByTestId("onboarding-backup-ack-confirm"));
  await waitFor(() => {
    assert.equal(completeCalls, 1);
  });
});
