import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { finalizeEvent } from "nostr-tools/pure";

import type { RelayEvent } from "../../src/shared/api/types";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";
import {
  AGENT_PUBKEY,
  canonicalJson,
  emitMessage,
  emitSignedEvent,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  openChannel,
  OWNER_PUBKEY,
  replaceBlockEvents,
  settleTimelineAtLatest,
  sha256Text,
  signBlockInstance,
  signManifest,
  trackPageErrors,
  type BlocksE2eWindow,
  type ManifestFixture,
} from "./blocks-test-helpers";

const SCREENSHOT_DIR = path.resolve("test-results/website-manager");
const CHANNEL = "general";
const RELAY_URL = "ws://localhost:3000";
const REVIEWER_PUBKEY = TEST_IDENTITIES.outsider.pubkey;
const BUILDER_PUBKEY = TEST_IDENTITIES.bob.pubkey;
const HEX64 = (seed: string) => sha256Text(seed);
const MANIFEST_1 = HEX64("website-manifest-1");
const MANIFEST_2 = HEX64("website-manifest-2");
const REQUEST_NOTE =
  "Make the headline warmer and keep the monthly branding offer clear.";

const COMMUNITY_A = {
  id: "website-a",
  name: "Alpha",
  relayUrl: RELAY_URL,
  addedAt: "2026-01-01T00:00:00.000Z",
  pubkey: OWNER_PUBKEY,
};
const COMMUNITY_B = {
  id: "website-b",
  name: "Bravo",
  relayUrl: RELAY_URL,
  addedAt: "2026-01-02T00:00:00.000Z",
  pubkey: OWNER_PUBKEY,
};

const WEBSITE_JOB_MANIFEST = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/buzz-relay/src/core_blocks/composites/website-job.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ManifestFixture;

// Canonical digest of the exact relay-bundled bytes, computed the same way
// blockRepository hashes a manifest before checking the core digest table.
export const WEBSITE_JOB_DIGEST = createHash("sha256")
  .update(canonicalJson(WEBSITE_JOB_MANIFEST))
  .digest("hex");
export const EXPECTED_WEBSITE_JOB_DIGEST =
  "df62e00412b314d4b036d07bcf547e0f7a9dbc562e013a6d3832f0c51bb7ad6f";

type JobState = "brief" | "working" | "review" | "revision" | "handover";

type JobDescriptor = {
  state: JobState;
  jobId: string;
  taskId: string;
  root: RelayEvent;
  card: RelayEvent;
  head: RelayEvent;
};

function svgCapture(label: string, color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="${color}"/><text x="60" y="140" font-family="sans-serif" font-size="64" fill="#ffffff">${label}</text></svg>`;
  return {
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    sha256: sha256Text(svg),
  };
}

const BEFORE_CAPTURE = svgCapture("Original site", "#6b4c3b");
const DESKTOP_CAPTURE = svgCapture("Redesign desktop", "#1f5f6b");
const MOBILE_CAPTURE = svgCapture("Redesign mobile", "#2c7a5b");

function artifact(name: string, sha256: string) {
  return { url: `https://assets.example/${name}`, sha256 };
}

function qaReportFixture(revision: number, manifestSha256: string) {
  const report = {
    schema: "colony.website-qa-report/1",
    reviewer: REVIEWER_PUBKEY,
    revision,
    manifestSha256,
    checks: [
      {
        id: "content",
        label: "Content and page coverage reviewed",
        result: "pass",
        detail: "All copied pages were compared against the source inventory.",
        evidence: [artifact("content-evidence.png", DESKTOP_CAPTURE.sha256)],
      },
      {
        id: "responsive",
        label: "Desktop and mobile layouts reviewed",
        result: "pass",
        detail: "Checked at real 1440x900 and 390x844 viewports.",
        evidence: [
          artifact("desktop-evidence.png", DESKTOP_CAPTURE.sha256),
          artifact("mobile-evidence.png", MOBILE_CAPTURE.sha256),
        ],
      },
      {
        id: "navigation",
        label: "Navigation and forms reviewed",
        result: "notApplicable",
        detail: "The preview manifest declares no forms for this revision.",
        evidence: [],
      },
    ],
  };
  const text = JSON.stringify(report);
  return { text, sha256: sha256Text(text) };
}

function qaEvidence(revision: number, manifestSha256: string) {
  const report = qaReportFixture(revision, manifestSha256);
  return {
    reviewer: REVIEWER_PUBKEY,
    revision,
    manifestSha256,
    passed: true,
    reportEventId: HEX64(`report-event-${revision}-${manifestSha256}`),
    report: artifact(`reports/revision-${revision}.json`, report.sha256),
  };
}

function decision(input: {
  decisionId: string;
  kind: "approve" | "requestChanges";
  jobId: string;
  taskId: string;
  revision: number;
  manifestSha256: string;
  actor: string;
  note?: string;
}) {
  return { ...input, channel: GENERAL_CHANNEL_ID };
}

function revisionFixture(input: {
  revision: number;
  manifestSha256: string;
  builtBy: string;
  qa?: ReturnType<typeof qaEvidence>;
}) {
  return {
    revision: input.revision,
    preview: artifact(
      `manifests/revision-${input.revision}.json`,
      input.manifestSha256,
    ),
    sourceUrl: "https://horizon-labs.example",
    archive: artifact(
      `archives/revision-${input.revision}.zip`,
      HEX64(`archive-${input.revision}`),
    ),
    captures: {
      before: artifact("captures/before.svg", BEFORE_CAPTURE.sha256),
      desktop: artifact("captures/desktop.svg", DESKTOP_CAPTURE.sha256),
      mobile: artifact("captures/mobile.svg", MOBILE_CAPTURE.sha256),
    },
    builtBy: input.builtBy,
    ...(input.qa ? { qa: input.qa } : {}),
  };
}

function baseRecord(input: {
  jobId: string;
  taskId: string;
  threadRoot: string;
}) {
  return {
    schema: "colony.website-review/v1" as const,
    jobId: input.jobId,
    taskId: input.taskId,
    channel: GENERAL_CHANNEL_ID,
    threadRoot: input.threadRoot,
    owner: OWNER_PUBKEY,
    coordinator: AGENT_PUBKEY,
    sourceUrl: "https://horizon-labs.example",
    stageEvidence: [] as unknown[],
  };
}

function recordFixture(input: {
  jobId: string;
  taskId: string;
  threadRoot: string;
  state: JobState;
}) {
  const { jobId, taskId, threadRoot, state } = input;
  const base = baseRecord({ jobId, taskId, threadRoot });
  if (state === "brief") {
    return {
      ...base,
      status: "draft",
      currentRevision: 0,
      revisions: [],
      approvals: [],
      decisions: [],
    };
  }
  const revision1 = revisionFixture({
    revision: 1,
    manifestSha256: MANIFEST_1,
    builtBy: BUILDER_PUBKEY,
    qa: qaEvidence(1, MANIFEST_1),
  });
  if (state === "working") {
    return {
      ...base,
      status: "working",
      currentRevision: 2,
      revisions: [
        revision1,
        revisionFixture({
          revision: 2,
          manifestSha256: MANIFEST_2,
          builtBy: BUILDER_PUBKEY,
        }),
      ],
      approvals: [],
      decisions: [
        decision({
          decisionId: fixtureUuid(800),
          kind: "requestChanges",
          jobId,
          taskId,
          revision: 1,
          manifestSha256: MANIFEST_1,
          actor: OWNER_PUBKEY,
          note: REQUEST_NOTE,
        }),
      ],
      // Relay-validated research completion plus a build checkpoint that keeps
      // design/build in progress rather than done.
      stageEvidence: [
        {
          stage: "research",
          kind: "taskReport",
          eventId: HEX64("research-task-report"),
        },
        {
          stage: "designBuild",
          kind: "jobCheckpoint",
          eventId: HEX64("build-checkpoint"),
          revision: 2,
        },
      ],
    };
  }
  if (state === "review") {
    return {
      ...base,
      status: "readyForReview",
      currentRevision: 2,
      revisions: [
        revision1,
        revisionFixture({
          revision: 2,
          manifestSha256: MANIFEST_2,
          builtBy: BUILDER_PUBKEY,
          qa: qaEvidence(2, MANIFEST_2),
        }),
      ],
      approvals: [],
      decisions: [],
    };
  }
  if (state === "revision") {
    return {
      ...base,
      status: "changesRequested",
      currentRevision: 2,
      revisions: [
        revision1,
        revisionFixture({
          revision: 2,
          manifestSha256: MANIFEST_2,
          builtBy: BUILDER_PUBKEY,
        }),
      ],
      approvals: [],
      decisions: [
        decision({
          decisionId: fixtureUuid(801),
          kind: "requestChanges",
          jobId,
          taskId,
          revision: 2,
          manifestSha256: MANIFEST_2,
          actor: OWNER_PUBKEY,
          note: REQUEST_NOTE,
        }),
      ],
    };
  }
  const approval = decision({
    decisionId: fixtureUuid(802),
    kind: "approve",
    jobId,
    taskId,
    revision: 1,
    manifestSha256: MANIFEST_1,
    actor: OWNER_PUBKEY,
    note: "Approved for handover.",
  });
  return {
    ...base,
    status: "handedOver",
    currentRevision: 1,
    revisions: [revision1],
    approvals: [approval],
    activeApprovalId: approval.decisionId,
    decisions: [approval],
    handover: {
      jobId,
      taskId,
      approvedRevision: 1,
      approvedManifestSha256: MANIFEST_1,
      sourceUrl: "https://horizon-labs.example",
      sourceArchive: artifact(
        "archives/approved.zip",
        HEX64("approved-archive"),
      ),
      assets: [
        {
          path: "index.html",
          artifact: artifact("assets/index.html", HEX64("asset-index")),
        },
        {
          path: "styles/site.css",
          artifact: artifact("assets/site.css", HEX64("asset-css")),
        },
      ],
      acceptedBy: OWNER_PUBKEY,
      accessRequest: {
        text: "Please share who manages the horizon-labs.example domain records so the updated site can be switched over at an agreed time.",
        authoredBy: AGENT_PUBKEY,
      },
    },
  };
}

function requestedReviewRecord(job: {
  jobId: string;
  taskId: string;
  threadRoot: string;
}) {
  const request = decision({
    decisionId: fixtureUuid(803),
    kind: "requestChanges",
    jobId: job.jobId,
    taskId: job.taskId,
    revision: 2,
    manifestSha256: MANIFEST_2,
    actor: OWNER_PUBKEY,
    note: REQUEST_NOTE,
  });
  return {
    ...baseRecord(job),
    status: "changesRequested",
    currentRevision: 2,
    revisions: [
      revisionFixture({
        revision: 1,
        manifestSha256: MANIFEST_1,
        builtBy: BUILDER_PUBKEY,
        qa: qaEvidence(1, MANIFEST_1),
      }),
      revisionFixture({
        revision: 2,
        manifestSha256: MANIFEST_2,
        builtBy: BUILDER_PUBKEY,
        qa: qaEvidence(2, MANIFEST_2),
      }),
    ],
    approvals: [],
    decisions: [request],
  };
}

function signHead(input: {
  jobId: string;
  taskId: string;
  threadRoot: string;
  cardId: string;
  manifestId: string;
  generation: number;
  record: unknown;
  createdAt: number;
}) {
  return finalizeEvent(
    {
      kind: 30203,
      created_at: input.createdAt,
      tags: [
        ["d", input.jobId],
        ["h", GENERAL_CHANNEL_ID],
        ["task", input.taskId],
        ["thread", input.threadRoot],
        ["instance", input.cardId],
        ["manifest", input.manifestId],
        ["generation", String(input.generation)],
        ["p", OWNER_PUBKEY],
        ["p", AGENT_PUBKEY],
      ],
      content: JSON.stringify(input.record),
    },
    hexToBytes(TEST_IDENTITIES.tyler.privateKey),
  );
}

function instanceData(input: { taskId: string; threadRoot: string }) {
  return {
    taskId: input.taskId,
    threadRoot: input.threadRoot,
    sourceUrl: "https://horizon-labs.example",
    brief: {
      summary:
        "Redesign the Horizon Labs site around the monthly branding offer while keeping the business facts and useful content.",
      preserve: [
        "Keep the business facts and useful content.",
        "Keep the original brand assets.",
      ],
      redesign: [
        "Improve the design, structure and mobile experience.",
        "Bring the monthly branding offer forward.",
      ],
      deliverables: [
        "A redesigned website preview to explore.",
        "Desktop and mobile captures.",
        "A short account of what improved.",
      ],
    },
  };
}

async function installFixtureLoader(page: Page) {
  const fixtures: Record<string, { base64: string; mime: string }> = {
    [BEFORE_CAPTURE.sha256]: {
      base64: BEFORE_CAPTURE.dataUrl.split(",")[1] ?? "",
      mime: "image/svg+xml",
    },
    [DESKTOP_CAPTURE.sha256]: {
      base64: DESKTOP_CAPTURE.dataUrl.split(",")[1] ?? "",
      mime: "image/svg+xml",
    },
    [MOBILE_CAPTURE.sha256]: {
      base64: MOBILE_CAPTURE.dataUrl.split(",")[1] ?? "",
      mime: "image/svg+xml",
    },
  };
  for (const [revision, manifest] of [
    [1, MANIFEST_1],
    [2, MANIFEST_2],
  ] as const) {
    const report = qaReportFixture(revision, manifest);
    fixtures[report.sha256] = {
      base64: Buffer.from(report.text).toString("base64"),
      mime: "application/json",
    };
  }
  await page.addInitScript((entries) => {
    (
      window as BlocksE2eWindow & {
        __BUZZ_E2E_WEBSITE_ARTIFACT_LOADER__?: unknown;
      }
    ).__BUZZ_E2E_WEBSITE_ARTIFACT_LOADER__ = {
      load: async (ref: { sha256: string }) => {
        const entry = (
          entries as Record<string, { base64: string; mime: string }>
        )[ref.sha256.toLowerCase()];
        if (!entry) throw new Error(`No website fixture for ${ref.sha256}`);
        const binary = atob(entry.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: entry.mime }),
        );
        return {
          objectUrl,
          verifiedSha256: ref.sha256.toLowerCase(),
          revoke: () => URL.revokeObjectURL(objectUrl),
        };
      },
    };
  }, fixtures);
}

async function seedJob(
  page: Page,
  state: JobState,
): Promise<{ job: JobDescriptor; manifestEvent: RelayEvent }> {
  const manifestEvent = signManifest(WEBSITE_JOB_MANIFEST);
  const jobId = fixtureUuid(700);
  const taskId = `website-task-${state}`;
  const root = await emitMessage(page, {
    channelName: CHANNEL,
    content: `Please redesign our website. Job: ${state}.`,
    pubkey: OWNER_PUBKEY,
  });
  const card = await emitSignedEvent(
    page,
    CHANNEL,
    signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      content: `Review packet for the ${state} state.`,
      data: instanceData({ taskId, threadRoot: root.id }),
      handle: "website-job",
      instanceId: fixtureUuid(720),
      manifestId: manifestEvent.id,
      parentEventId: root.id,
      processorPubkey: AGENT_PUBKEY,
      signer: "charlie",
    }),
  );
  const head = signHead({
    jobId,
    taskId,
    threadRoot: root.id,
    cardId: card.id,
    manifestId: manifestEvent.id,
    generation: 1,
    record: recordFixture({ jobId, taskId, threadRoot: root.id, state }),
    createdAt: Math.floor(Date.now() / 1_000),
  });
  await replaceBlockEvents(page, [manifestEvent, head]);
  await emitSignedEvent(page, CHANNEL, head);
  await settleTimelineAtLatest(page);
  return {
    job: { state, jobId, taskId, root, card, head },
    manifestEvent,
  };
}

async function openThreadForRoot(page: Page, rootId: string) {
  await page.evaluate(
    ({ channel, id }) => {
      window.location.hash = `/channels/${channel}?thread=${id}&threadRootId=${id}`;
    },
    { channel: CHANNEL, id: rootId },
  );
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
}

/**
 * The trusted composite renders the thread body inside the right panel while
 * the plain event-id attachment stays hidden (no duplicated controls).
 */
function threadComposite(page: Page): Locator {
  return page
    .getByTestId("message-thread-panel")
    .getByTestId("website-job-composite");
}

async function expectCompositeThread(page: Page): Promise<Locator> {
  const composite = threadComposite(page);
  await expect(composite).toBeVisible();
  await expect(
    composite.getByTestId("website-job-composite-body"),
  ).toBeVisible();
  await expect(page.getByTestId("website-thread-attachment")).toHaveCount(0);
  return composite;
}

function screenshotPath(name: string) {
  return path.join(SCREENSHOT_DIR, `${name}.png`);
}

async function captureViewport(page: Page, name: string, locator?: Locator) {
  if (locator) await locator.scrollIntoViewIfNeeded();
  await waitForAnimations(page);
  await page.screenshot({ animations: "disabled", path: screenshotPath(name) });
}

async function captureBothWidths(
  page: Page,
  state: JobState,
  locator?: Locator,
) {
  await page.setViewportSize({ width: 1280, height: 720 });
  await captureViewport(page, `${state}-1280`, locator);
  await page.setViewportSize({ width: 1440, height: 900 });
  await captureViewport(page, `${state}-1440`, locator);
}

function assertDistinctScreenshots(names: readonly string[]) {
  const paths = names.map(screenshotPath);
  expect(
    paths.filter((screenshot) => !existsSync(screenshot)),
    "Every website manager state must have a screenshot.",
  ).toEqual([]);
  const hashes = paths.map((screenshot) =>
    createHash("sha256").update(readFileSync(screenshot)).digest("hex"),
  );
  expect(
    new Set(hashes).size,
    "Every website manager state must produce distinct pixels.",
  ).toBe(hashes.length);
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.beforeAll(() => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test.afterAll(() => {
  assertDistinctScreenshots([
    "brief-1280",
    "brief-1440",
    "working-1280",
    "working-1440",
    "review-1280",
    "review-1440",
    "revision-1280",
    "revision-1440",
    "handover-1280",
    "handover-1440",
  ]);
});

test("mocked website-job fixture carries the bundled core digest", () => {
  expect(WEBSITE_JOB_DIGEST).toBe(EXPECTED_WEBSITE_JOB_DIGEST);
});

test("mocked Brief state renders the brief and start action", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await installMockBridge(page, { relaySelf: OWNER_PUBKEY });
  await openChannel(page, CHANNEL);
  await seedJob(page, "brief");
  await page.getByTestId("message-timeline").waitFor();
  const rootAttachment = page.getByTestId("website-root-attachment").first();
  await expect(rootAttachment).toBeVisible();
  await expect(
    page.getByText("Keep the business facts and useful content."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start redesign" }),
  ).toBeVisible();
  await captureBothWidths(page, "brief", rootAttachment);
});

test("mocked Working state shows stages and earlier-version inspection", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await installMockBridge(page, { relaySelf: OWNER_PUBKEY });
  await openChannel(page, CHANNEL);
  const { job } = await seedJob(page, "working");
  const rootAttachment = page.getByTestId("website-root-attachment").first();
  await expect(rootAttachment).toBeVisible();
  await expect(page.getByText("In progress").first()).toBeVisible();
  await expect(page.getByText("Understand the existing site")).toBeVisible();
  const stageRow = (label: string) =>
    rootAttachment.locator("li").filter({ hasText: label });
  await expect(stageRow("Understand the existing site")).toContainText("Done");
  await expect(stageRow("Design and build")).toContainText("Working");
  await openThreadForRoot(page, job.root.id);
  const threadAttachment = await expectCompositeThread(page);
  const versionHistory = threadAttachment.getByRole("region", {
    name: "Version history",
  });
  await versionHistory
    .getByRole("listitem")
    .filter({ hasText: "Version 1" })
    .getByRole("button", { name: "View" })
    .click();
  await expect(page.getByText(/Read-only view of Version 1/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close preview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(page.getByText(/Read-only view of Version 1/)).toHaveCount(0);
  await captureBothWidths(page, "working", rootAttachment);
});

test("mocked Review state switches views, expands, and scopes decisions", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await installMockBridge(page, { relaySelf: OWNER_PUBKEY });
  await openChannel(page, CHANNEL);
  const { job } = await seedJob(page, "review");
  const rootAttachment = page.getByTestId("website-root-attachment").first();
  await expect(page.getByText("Ready for your review").first()).toBeVisible();
  const mobileButton = page.getByRole("button", { name: "Mobile preview" });
  await mobileButton.click();
  await expect(mobileButton).toHaveAttribute("aria-pressed", "true");
  const beforeButton = page.getByRole("button", {
    name: "Before",
    exact: true,
  });
  await beforeButton.click();
  await expect(beforeButton).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Redesign", exact: true }).click();
  await page.getByRole("button", { name: "Desktop preview" }).click();
  await page.getByRole("button", { name: "Expand preview" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Back to review" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await openThreadForRoot(page, job.root.id);
  const threadAttachment = await expectCompositeThread(page);
  await expect(
    threadAttachment.getByText("Desktop and mobile layouts reviewed"),
  ).toBeVisible();
  await threadAttachment
    .getByRole("region", { name: "Version history" })
    .getByRole("listitem")
    .filter({ hasText: "Version 1" })
    .getByRole("button", { name: "View" })
    .click();
  await expect(page.getByText(/Read-only view of Version 1/)).toBeVisible();
  await expect(
    threadAttachment.getByRole("button", { name: "Approve design" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(
    threadAttachment.getByRole("button", { name: "Approve design" }),
  ).toBeEnabled();
  await captureBothWidths(page, "review", rootAttachment);
});

test("mocked Revision state shows the exact change request", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await installMockBridge(page, { relaySelf: OWNER_PUBKEY });
  await openChannel(page, CHANNEL);
  const { job } = await seedJob(page, "revision");
  await openThreadForRoot(page, job.root.id);
  const threadAttachment = await expectCompositeThread(page);
  await expect(page.getByText("Changes requested").first()).toBeVisible();
  await expect(page.getByText(REQUEST_NOTE)).toBeVisible();
  await captureBothWidths(page, "revision", threadAttachment);
});

test("mocked Handover state shows confirmed resources and the draft request", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await installMockBridge(page, { relaySelf: OWNER_PUBKEY });
  await openChannel(page, CHANNEL);
  const { job } = await seedJob(page, "handover");
  await openThreadForRoot(page, job.root.id);
  const threadAttachment = await expectCompositeThread(page);
  await expect(page.getByText("Handover prepared").first()).toBeVisible();
  await expect(
    page.getByText(/Please share who manages the horizon-labs.example domain/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download" }).first(),
  ).toBeVisible();
  await captureBothWidths(page, "handover", threadAttachment);
});

test("mocked transport fails, retries, confirms from the head, and recovers on reload", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await installMockBridge(page, {
    relaySelf: OWNER_PUBKEY,
    blockActionPublishErrors: ["network unreachable"],
  });
  await openChannel(page, CHANNEL);
  const { job, manifestEvent } = await seedJob(page, "review");
  await openThreadForRoot(page, job.root.id);
  const threadAttachment = await expectCompositeThread(page);

  await threadAttachment
    .getByPlaceholder(
      "Describe what should change, or leave a note with an approval.",
    )
    .fill(REQUEST_NOTE);
  await threadAttachment
    .getByRole("button", { name: "Request changes" })
    .click();
  await expect(threadAttachment.getByText("network unreachable")).toBeVisible();
  await expect(
    threadAttachment.getByRole("button", { name: "Try again" }),
  ).toBeVisible();

  await threadAttachment.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Saving your decision.")).toBeVisible();
  const confirmed = signHead({
    jobId: job.jobId,
    taskId: job.taskId,
    threadRoot: job.root.id,
    cardId: job.card.id,
    manifestId: manifestEvent.id,
    generation: 2,
    record: requestedReviewRecord(job),
    createdAt: Math.floor(Date.now() / 1_000) + 10,
  });
  await replaceBlockEvents(page, [manifestEvent, confirmed]);
  await emitSignedEvent(page, CHANNEL, confirmed);
  await expect(page.getByText("Saving your decision.")).toHaveCount(0);
  await expect(page.getByText("Changes requested").first()).toBeVisible();

  await page.reload();
  await openChannel(page, CHANNEL);
  await openThreadForRoot(page, job.root.id);
  await expect(page.getByText("Changes requested").first()).toBeVisible();
  await expect(page.getByText("Saving your decision.")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as BlocksE2eWindow).__BUZZ_E2E_PUBLISHED_EVENTS__?.length ?? 0,
    ),
  ).toBeGreaterThan(0);
});

test("mocked community switch clears pending website state", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await page.addInitScript(
    ({ list, active }) => {
      window.localStorage.setItem("buzz-communities", JSON.stringify(list));
      window.localStorage.setItem("buzz-active-community-id", active);
    },
    { list: [COMMUNITY_A, COMMUNITY_B], active: COMMUNITY_A.id },
  );
  await installMockBridge(
    page,
    { relaySelf: OWNER_PUBKEY },
    { skipCommunitySeed: true },
  );
  await page.goto("/");
  await page.getByTestId(`channel-${CHANNEL}`).click();
  await expect(page.getByTestId("chat-title")).toHaveText(CHANNEL);
  const { job } = await seedJob(page, "review");
  await openThreadForRoot(page, job.root.id);
  const threadAttachment = await expectCompositeThread(page);
  await threadAttachment
    .getByPlaceholder(
      "Describe what should change, or leave a note with an approval.",
    )
    .fill(REQUEST_NOTE);
  await threadAttachment
    .getByRole("button", { name: "Request changes" })
    .click();
  await expect(page.getByText("Saving your decision.")).toBeVisible();

  await page.getByTestId("community-rail-button-website-b").click();
  await expect(page.getByText("Saving your decision.")).toHaveCount(0);
  await page.getByTestId("community-rail-button-website-a").click();
  await page.getByTestId(`channel-${CHANNEL}`).click();
  await expect(page.getByText("Saving your decision.")).toHaveCount(0);
});

test("mocked browser build reports the native preview as unavailable", async ({
  page,
}) => {
  await seedActiveIdentity(page, "tyler");
  await installFixtureLoader(page);
  await installMockBridge(page, { relaySelf: OWNER_PUBKEY });
  await openChannel(page, CHANNEL);
  const { job } = await seedJob(page, "review");
  await openThreadForRoot(page, job.root.id);
  await expectCompositeThread(page);
  const rootAttachment = page.getByTestId("website-root-attachment").first();
  await expect(
    rootAttachment
      .getByText(
        "Interactive preview is not available. Showing the saved image of this version.",
      )
      .first(),
  ).toBeVisible();
});
