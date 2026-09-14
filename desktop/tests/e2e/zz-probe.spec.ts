import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
const MOCK_VIEWER_PUBKEY = "deadbeef".repeat(8);
const QUINN = "a1".repeat(32);
const WC = "a27e1ee9-76a6-5bdf-a5d5-1d85610dad11";
test("probe1041", async ({ page }) => {
  await installMockBridge(page, {
    deferredComposerUploads: true,
    uploadDescriptors: [{ url: `https://mock.relay/media/${"f".repeat(64)}.pdf`, sha256: "f".repeat(64), size: 12345, type: "application/pdf", uploaded: Math.floor(Date.now()/1000), filename: "forum-race.pdf" }],
    relayAgents: [{ pubkey: QUINN, name: "quinn", respondTo: "allowlist", respondToAllowlist: [MOCK_VIEWER_PUBKEY], channelNames: ["watercooler"] }],
  });
  await page.goto("/");
  await page.getByTestId("channel-watercooler").click();
  await page.getByRole("button", { name: "Start a new post..." }).click();
  await page.evaluate(async ({ channelId, pubkey }) => {
    const invoke = (window as any).__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
    await invoke("add_channel_members", { channelId, pubkeys: [pubkey], role: "bot" });
    await (window as any).__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({ queryKey: ["channels", channelId, "members"] });
  }, { channelId: WC, pubkey: QUINN });
  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  await page.getByTestId("mention-autocomplete").getByText("quinn").click();
  await page.keyboard.type("hello");
  await page.getByRole("button", { name: "Attach file" }).click();
  await expect(page.getByRole("button", { name: "Remove attachment" })).toBeVisible();
  const before = await page.evaluate(() => ((window as any).__BUZZ_E2E_COMMAND_LOG__ ?? []).length);
  await page.getByTestId("send-message").click();
  await page.waitForTimeout(4000);
  const cmds = await page.evaluate((b:number) => ((window as any).__BUZZ_E2E_COMMAND_LOG__ ?? []).slice(b).map((e:any)=>e.command), before);
  console.log("CMDS", JSON.stringify(cmds));
});
