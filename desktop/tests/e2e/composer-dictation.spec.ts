import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

test("dictation follows theme changes and produces an editable draft before Send", async ({
  page,
}, testInfo) => {
  // Real browser AudioWorklet fed synthetic audio; only native recognition is mocked.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        const track = destination.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          oscillator.stop();
          void context.close();
          stop();
        };
        return destination.stream;
      },
    });
  });
  await installMockBridge(page, { mode: "mock" });
  await page.goto("/");
  const composer = page.getByTestId("message-composer").first();
  const editor = composer.locator(".tiptap");
  await expect(editor).toBeVisible();
  await editor.fill("Keep this draft.");
  await editor.press("End");
  await composer.getByRole("button", { name: "Dictate message" }).click();
  const recording = composer.getByTestId("dictation-recording");
  await expect(recording).toContainText("Listening");
  await expect(composer.getByTestId("send-message")).toBeDisabled();
  for (const [name, color] of [
    ["blue", "210 80% 50%"],
    ["pink", "330 80% 50%"],
  ]) {
    await page.evaluate(
      (value) => document.documentElement.style.setProperty("--primary", value),
      color,
    );
    const stop = recording.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toHaveCSS(
      "background-color",
      name === "blue" ? "rgb(26, 128, 230)" : "rgb(230, 26, 128)",
    );
    await waitForAnimations(page);
    await composer.screenshot({
      path: testInfo.outputPath(`dictation-${name}.png`),
    });
  }
  await recording.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(editor).toBeEditable();
  await expect(editor).toContainText(
    "Keep this draft. Ask Sarah to draft three posts for next week.",
  );
  await expect(composer).toContainText("Edit anything before sending.");
  await expect(composer.getByTestId("send-message")).toBeEnabled();
  await waitForAnimations(page);
  await composer.screenshot({
    path: testInfo.outputPath("dictation-review.png"),
  });
  await composer.getByRole("button", { name: "Dictate message" }).click();
  await expect(recording).toContainText("Listening");
  await recording
    .getByRole("button", { name: "Cancel dictation" })
    .press("Escape");
  await expect(recording).toHaveCount(0);
  await expect(editor).toContainText(
    "Keep this draft. Ask Sarah to draft three posts for next week.",
  );
});
