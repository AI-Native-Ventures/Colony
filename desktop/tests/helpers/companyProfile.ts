import { expect, type Page } from "@playwright/test";
import { verifyEvent } from "nostr-tools/pure";
import { parseCompanyHead } from "../../src/features/company/contracts";
import { parseCompanyReceipt } from "../../src/features/company/workRepository";

/** Renderer proof through synthetic native signing, CAS, receipt and head readback. */
export async function expectRetainedBusinessContext(
  page: Page,
  expected: {
    ownerPubkey: string;
    relayUrl: string;
    name: string;
    summary: string;
  },
): Promise<void> {
  const retained = await page.evaluate(() => ({
    broker: window.__BUZZ_E2E_MOCK_COMPANY_BROKER__?.(),
    signed: window.__BUZZ_E2E_COMMAND_PAYLOADS__?.filter(
      (entry) => entry.command === "sign_community_profile_update",
    ),
  }));
  expect(retained.signed).toHaveLength(1);
  expect(retained.signed?.[0]?.payload).toMatchObject({
    expectedOwnerPubkey: expected.ownerPubkey,
    expectedRelayUrl: expected.relayUrl,
  });
  const heads = retained.broker?.profileHeads ?? [];
  expect(heads).toHaveLength(2);
  const initial = parseCompanyHead(heads[0], heads[0].pubkey);
  const saved = parseCompanyHead(heads[1], heads[1].pubkey);
  expect(initial.ok).toBe(true);
  expect(initial.ok && initial.value.summary).toBe("");
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.message);
  expect(saved.value.tradingName).toBe(expected.name);
  expect(saved.value.summary).toBe(expected.summary);
  expect(saved.value.website).toBeNull();
  const receipts =
    retained.broker?.receipts.filter((entry) =>
      entry.tags.some((tag) => tag[0] === "a" && tag[1]?.startsWith("30179:")),
    ) ?? [];
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0];
  expect(verifyEvent(receipt)).toBe(true);
  expect(receipt.tags.filter((tag) => tag[0] === "p")).toEqual([
    ["p", expected.ownerPubkey],
  ]);
  const actionId = receipt.tags.find((tag) => tag[0] === "e")?.[1] ?? "";
  const parsed = parseCompanyReceipt(receipt, heads[1].pubkey, actionId);
  expect(parsed?.outcome).toBe("applied");
  expect(parsed?.headEventId).toBe(heads[1].id);
}
