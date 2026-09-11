import { hexToBytes } from "@noble/hashes/utils.js";
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import {
  computeApprovalHash,
  validateBlockData,
  validateBlockManifest,
} from "../../src/features/blocks/blockValidation";
import type { RelayEvent } from "../../src/shared/api/types";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  approvedCoreManifests,
  captureApproved,
  expectApprovedBlock,
  openApprovedThread,
  seedApprovedAppearance,
  type ApprovedTheme,
} from "./approved-blocks-design.fixtures";
import {
  canonicalJson,
  emitSignedEvent,
  externalBlockTags,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  openChannel,
  OWNER_PUBKEY,
  readCoreManifest,
  settleTimelineAtLatest,
  sha256Text,
  signBlockAction,
  signBlockInstance,
  signBlockReceipt,
  signManifest,
  trustedWorkspaceManifest,
  type ManifestFixture,
} from "./blocks-test-helpers";

test.describe.configure({ mode: "parallel", timeout: 60_000 });

function assertData(manifest: ManifestFixture, data: unknown) {
  const parsed = validateBlockManifest(manifest);
  if (!parsed.ok) throw new Error(parsed.message);
  const checked = validateBlockData(parsed.value, data);
  expect(
    checked.ok,
    checked.ok ? "valid signed fixture data" : checked.message,
  ).toBe(true);
}

function externalInstance(
  manifestId: string,
  url: string,
  body: string,
  index: number,
) {
  return finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content:
        "Client shortlist: Northstar Dental is a strong fit. The original message stays readable while its view loads.",
      tags: [
        ["h", GENERAL_CHANNEL_ID],
        ...externalBlockTags({
          byteSize: Buffer.byteLength(body),
          handle: "card-list",
          instanceId: fixtureUuid(index),
          manifestId,
          sha256: sha256Text(body),
          url,
        }),
      ],
    },
    hexToBytes(TEST_IDENTITIES.charlie.privateKey),
  );
}

async function captureBoth({
  page,
  info,
  event,
  theme,
  name,
  selector,
  verify,
}: {
  page: Page;
  info: TestInfo;
  event: RelayEvent;
  theme: ApprovedTheme;
  name: string;
  selector: string;
  verify: (subject: Locator, surface: "channel" | "thread") => Promise<void>;
}) {
  expect(verifyEvent(event)).toBe(true);
  await expect(page.locator("html")).toHaveClass(
    new RegExp(`\\b${theme === "buzz-dark" ? "dark" : "light"}\\b`),
  );
  await settleTimelineAtLatest(page);
  const row = page.locator(`[data-message-id="${event.id}"]`).first();
  const channel = row.locator(selector);
  await verify(channel, "channel");
  const wide = await captureApproved(
    page,
    channel,
    info,
    `${name}-${theme}-channel.png`,
  );
  expect(wide.box?.width).toBeGreaterThan(500);
  const thread = await openApprovedThread(page, row);
  const narrow = thread.locator(selector);
  await verify(narrow, "thread");
  const slim = await captureApproved(
    page,
    narrow,
    info,
    `${name}-${theme}-thread.png`,
  );
  expect(slim.box?.width).toBeGreaterThan(220);
  expect(slim.box?.width).toBeLessThanOrEqual(500);
  expect(slim.sha256).not.toBe(wide.sha256);
  return { row, thread };
}

const cardList = approvedCoreManifests.find(
  ({ manifest }) => manifest.handle === "card-list",
)?.manifest;
if (!cardList) throw new Error("The bundled Card List manifest is missing.");
const listManifest = cardList;

for (const theme of ["buzz", "buzz-dark"] as const) {
  test(`signed Grid adapts from two columns to a narrow thread in ${theme}`, async ({
    page,
  }, info) => {
    const data = {
      launch:
        "Introduce the summer collection with a clear product story and one next step.",
      followup:
        "Answer the three questions customers ask most, using proof from the launch.",
    };
    const grid = trustedWorkspaceManifest(readCoreManifest("artifact"), {
      handle: "approved-grid-layout",
      name: "Campaign plan",
      description: "Two related pieces of work, presented together.",
      input_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["launch", "followup"],
        properties: {
          launch: { type: "string" },
          followup: { type: "string" },
        },
      },
      tree: {
        type: "grid",
        columns: 2,
        gap: "medium",
        children: [
          {
            type: "card",
            eyebrow: "01 · Launch",
            title: "Tell the product story",
            description: "{{launch}}",
            children: [
              {
                type: "section",
                title: "Format",
                text: "A five-image carousel with a short caption.",
              },
            ],
          },
          {
            type: "card",
            eyebrow: "02 · Follow-up",
            title: "Make the next step easy",
            description: "{{followup}}",
            children: [
              {
                type: "section",
                title: "Format",
                text: "A short video and a simple call to action.",
              },
            ],
          },
        ],
      },
      actions: [],
      permissions: [],
      primitive_versions: { card: 1, section: 1 },
      fallback_template: "{{launch}}\n{{followup}}",
      examples: [{ name: "Campaign plan", data }],
    });
    assertData(grid.manifest, data);
    await seedApprovedAppearance(page, theme);
    await installMockBridge(page, {
      activeIdentityInDefaultChannels: true,
      blockEvents: grid.events,
      relaySelf: OWNER_PUBKEY,
    });
    await openChannel(page, "general");
    const event = signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      content: "Campaign plan: a launch story and a follow-up.",
      data,
      handle: grid.manifest.handle,
      instanceId: fixtureUuid(8100),
      manifestId: grid.events[0].id,
    });
    await emitSignedEvent(page, "general", event);
    await captureBoth({
      page,
      info,
      event,
      theme,
      name: "grid",
      selector: '[data-block-handle="approved-grid-layout"]',
      verify: async (subject, surface) => {
        await expect(subject).toHaveAttribute(
          "data-block-trust",
          "workspace-custom",
        );
        await expect(subject.locator("[data-block-fallback]")).toHaveCount(0);
        await expect(
          subject.getByText(data.launch, { exact: true }),
        ).toBeVisible();
        await expect(
          subject.getByText(data.followup, { exact: true }),
        ).toBeVisible();
        const layout = subject.locator(
          '[data-block-primitive="grid"] > [data-layout-children]',
        );
        await expect(
          layout.locator(":scope > [data-block-primitive='card']"),
        ).toHaveCount(2);
        await expect
          .poll(() =>
            layout.evaluate(
              (element) =>
                getComputedStyle(element).gridTemplateColumns.split(/\s+/)
                  .length,
            ),
          )
          .toBe(surface === "channel" ? 2 : 1);
        expect(
          await subject.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
      },
    });
  });

  test(`Empty uses the real signed Card List in ${theme}`, async ({
    page,
  }, info) => {
    const data = { items: [] };
    assertData(listManifest, data);
    const manifest = signManifest(listManifest);
    await seedApprovedAppearance(page, theme);
    await installMockBridge(page, {
      activeIdentityInDefaultChannels: true,
      blockEvents: [manifest],
      relaySelf: OWNER_PUBKEY,
    });
    await openChannel(page, "general");
    const event = signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      content: "The shortlist is empty. There are no matches to show yet.",
      data,
      handle: "card-list",
      instanceId: fixtureUuid(8101),
      manifestId: manifest.id,
    });
    await emitSignedEvent(page, "general", event);
    await captureBoth({
      page,
      info,
      event,
      theme,
      name: "empty",
      selector: '[data-block-handle="card-list"]',
      verify: async (subject) => {
        await expectApprovedBlock(subject);
        await expect(
          subject.getByText("Nothing to show yet.", { exact: true }),
        ).toBeVisible();
        await expect(
          subject.locator('[data-block-primitive="card"]'),
        ).toHaveCount(0);
      },
    });
  });

  for (const state of ["pending", "succeeded", "failed"] as const) {
    test(`signed action ${state} is visible in channel and thread in ${theme}`, async ({
      page,
    }, info) => {
      const manifest = signManifest(readCoreManifest("approval"));
      const instanceId = fixtureUuid(8102);
      const proposal = {
        action: "Send the approved outbound email",
        destination: "jordan@tennant-group.com",
        content: "Hi Jordan,\n\nYour homepage proposal is ready for review.",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
      const event = signBlockInstance({
        channelId: GENERAL_CHANNEL_ID,
        content:
          "Approve the outbound email. The final outcome remains linked to this request.",
        data: { ...proposal, status: "pending" },
        handle: "approval",
        instanceId,
        manifestId: manifest.id,
        processorPubkey: OWNER_PUBKEY,
        requiresAttention: true,
      });
      const actionTemplate = signBlockAction({
        actionId: "approval.approve",
        channelId: GENERAL_CHANNEL_ID,
        idempotencyKey: fixtureUuid(8103),
        instanceEventId: event.id,
        instanceId,
        manifestId: manifest.id,
        processorPubkey: OWNER_PUBKEY,
      });
      const action = finalizeEvent(
        {
          kind: actionTemplate.kind,
          created_at: actionTemplate.created_at,
          tags: actionTemplate.tags,
          content: canonicalJson({
            approval_hash: computeApprovalHash(proposal),
          }),
        },
        hexToBytes(TEST_IDENTITIES.tyler.privateKey),
      );
      const events = [event, action];
      if (state !== "pending") {
        const receipt = signBlockReceipt({
          action,
          channelId: GENERAL_CHANNEL_ID,
          instanceEventId: event.id,
          instanceId,
          status: state,
        });
        events.push(
          state === "succeeded"
            ? finalizeEvent(
                {
                  kind: receipt.kind,
                  created_at: receipt.created_at,
                  content: receipt.content,
                  tags: [...receipt.tags, ["block-attention", "1", "resolved"]],
                },
                hexToBytes(TEST_IDENTITIES.tyler.privateKey),
              )
            : receipt,
        );
      }
      for (const signed of [manifest, ...events])
        expect(verifyEvent(signed)).toBe(true);
      await seedApprovedAppearance(page, theme);
      await installMockBridge(page, {
        activeIdentityInDefaultChannels: true,
        blockEvents: [manifest],
        blockTimelineEvents: events.map((signed) => ({
          channelName: "general",
          event: signed,
        })),
        relaySelf: OWNER_PUBKEY,
      });
      await openChannel(page, "general");
      const status =
        state === "pending"
          ? "Action submitted. Waiting for the responsible agent."
          : state === "succeeded"
            ? "Completed."
            : "The action failed. You can try again.";
      await captureBoth({
        page,
        info,
        event,
        theme,
        name: `action-${state}`,
        selector: '[data-block-handle="approval"]',
        verify: async (subject) => {
          await expectApprovedBlock(subject);
          await expect(
            subject.getByText(status, { exact: true }),
          ).toBeVisible();
          if (state !== "succeeded")
            await expect(
              subject.getByText("Completed.", { exact: true }),
            ).toHaveCount(0);
        },
      });
    });
  }

  for (const state of ["untrusted", "unavailable"] as const) {
    test(`${state} preserves the original signed message in ${theme}`, async ({
      page,
    }, info) => {
      const data = {
        items: [{ title: "Northstar Dental", description: "Strong fit" }],
      };
      const body = canonicalJson(data);
      const url = `https://blocks.example.test/${state}.json`;
      const manifest = signManifest(
        state === "untrusted"
          ? {
              ...listManifest,
              origin: "workspace-custom",
              created_at: listManifest.created_at + 1,
            }
          : listManifest,
        state === "untrusted" ? "outsider" : "tyler",
      );
      const event =
        state === "untrusted"
          ? signBlockInstance({
              channelId: GENERAL_CHANNEL_ID,
              content:
                "Client shortlist: Northstar Dental is a strong fit. Its untrusted view cannot replace this original message.",
              data,
              handle: "card-list",
              instanceId: fixtureUuid(8104),
              manifestId: manifest.id,
            })
          : externalInstance(manifest.id, url, body, 8105);
      await seedApprovedAppearance(page, theme);
      await installMockBridge(page, {
        activeIdentityInDefaultChannels: true,
        blockEvents: [manifest],
        blockDataResponses: { [url]: { error: "mock source unavailable" } },
        relaySelf: OWNER_PUBKEY,
      });
      await openChannel(page, "general");
      await emitSignedEvent(page, "general", event);
      await captureBoth({
        page,
        info,
        event,
        theme,
        name: state,
        selector: `[data-block-fallback="${state === "untrusted" ? "untrusted" : "missing"}"]`,
        verify: async (subject) => {
          await expect(subject).toBeVisible();
          await expect(
            subject.getByText(event.content, { exact: true }),
          ).toBeVisible();
          await expect(subject).toContainText(
            state === "untrusted"
              ? "This inline view comes from an untrusted publisher."
              : "External Block data could not be loaded",
          );
          await expect(subject.locator("[data-block-primitive]")).toHaveCount(
            0,
          );
        },
      });
    });
  }

  test(`Loading holds an actual data lookup then resolves the signed view in ${theme}`, async ({
    page,
  }, info) => {
    const data = {
      items: [{ title: "Northstar Dental", description: "Strong fit" }],
    };
    assertData(listManifest, data);
    const body = canonicalJson(data);
    const manifest = signManifest(listManifest);
    const url = "https://blocks.example.test/held-shortlist.json";
    const event = externalInstance(manifest.id, url, body, 8106);
    await seedApprovedAppearance(page, theme);
    await installMockBridge(page, {
      activeIdentityInDefaultChannels: true,
      blockEvents: [manifest],
      blockDataResponses: { [url]: { body, hold: true } },
      relaySelf: OWNER_PUBKEY,
    });
    try {
      await openChannel(page, "general");
      await emitSignedEvent(page, "general", event);
      await expect
        .poll(() =>
          page.evaluate(
            (value) =>
              window.__BUZZ_E2E_BLOCK_DATA_HOLD_STATE__?.(value) ?? null,
            url,
          ),
        )
        .toEqual({ observed: true, held: true });
      const surfaces = await captureBoth({
        page,
        info,
        event,
        theme,
        name: "loading",
        selector: '[data-block-fallback="loading"]',
        verify: async (subject) => {
          await expect(
            subject.getByText(event.content, { exact: true }),
          ).toBeVisible();
          await expect(subject.getByRole("status")).toHaveText(
            "Loading this inline view…",
          );
          expect(
            await page.evaluate(
              (value) => window.__BUZZ_E2E_BLOCK_DATA_HOLD_STATE__?.(value),
              url,
            ),
          ).toEqual({ observed: true, held: true });
        },
      });
      await page.evaluate(
        (value) => window.__BUZZ_E2E_RELEASE_BLOCK_DATA__?.(value),
        url,
      );
      expect(
        await page.evaluate(
          (value) => window.__BUZZ_E2E_BLOCK_DATA_HOLD_STATE__?.(value),
          url,
        ),
      ).toEqual({ observed: true, held: false });
      for (const [surface, parent] of [
        ["channel", surfaces.row],
        ["thread", surfaces.thread],
      ] as const) {
        await expect(parent.locator("[data-block-fallback]")).toHaveCount(0);
        const block = parent.locator('[data-block-handle="card-list"]');
        await expectApprovedBlock(block);
        await expect(
          block.getByText("Northstar Dental", { exact: true }),
        ).toBeVisible();
        await expect(
          block.getByText("Strong fit", { exact: true }),
        ).toBeVisible();
        await captureApproved(
          page,
          block,
          info,
          `loading-resolved-${theme}-${surface}.png`,
        );
      }
    } finally {
      // A release failure after a crash or mid-navigation must not replace
      // the original assertion error.
      if (!page.isClosed())
        await page
          .evaluate(
            (value) => window.__BUZZ_E2E_RELEASE_BLOCK_DATA__?.(value),
            url,
          )
          .catch(() => {});
    }
  });
}
