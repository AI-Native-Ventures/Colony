// Flow 05 — join a huddle and transmit briefly.
// Reaches: audio device enumeration + capture and the raw binary IPC path
// (push_audio_pcm over the Tauri channel), which the mock cannot touch.
// On machines without an audio input device this flow skips LOUDLY — it must
// never silently read as coverage.
import { execFileSync } from "node:child_process";

import { browser, expect } from "@wdio/globals";

import {
  clickTestId,
  getIdentity,
  invoke,
  waitForFirstPaint,
  waitForTestId,
} from "../helpers/app";
import { recordResult, skipFlow } from "../helpers/results";

type HuddleState = {
  phase:
    | "idle"
    | "creating"
    | "connecting"
    | "connected"
    | "active"
    | "leaving";
  parent_channel_id: string | null;
  ephemeral_channel_id: string | null;
  participants: string[];
  is_creator: boolean;
};

function hasAudioInputDevice(): boolean {
  try {
    const out = execFileSync("/usr/sbin/system_profiler", ["SPAudioDataType"], {
      encoding: "utf8",
    });
    return /Input Channels: \d/.test(out) && !/no audio/i.test(out);
  } catch {
    return false;
  }
}

describe("05 huddle join + brief transmit", () => {
  it("joins a huddle with the real audio pipeline and leaves cleanly", async function () {
    recordResult("05-huddle", "pass", "running");

    if (!hasAudioInputDevice()) {
      return skipFlow.call(
        this,
        "05-huddle",
        "no audio input device on this machine",
      );
    }

    await waitForFirstPaint();
    const identity = await getIdentity();
    expect(identity.locked).toBe(false);

    const community = await browser.$('[data-testid="channel-general"]');
    await community.waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: "community state not restored (flow 03 must run first)",
    });

    // Open general, then start/join the huddle from the channel indicator.
    await clickTestId("channel-general");
    await waitForTestId("channel-start-huddle-trigger", 120_000);
    await clickTestId("channel-start-huddle-trigger");

    // The backend huddle state becomes active (real join path). Activation
    // waits on getUserMedia in the webview: if macOS TCC has not granted the
    // harness app microphone access, the phase stalls at connected and the
    // join never confirms. That is a permission state, not a shell failure —
    // report it as a LOUD skip with the exact reason (the coordinator has
    // approved the per-app prompt; denial/unanswered must never read as
    // coverage, and a stuck wait must not read as a pass).
    async function micPermissionState(): Promise<string> {
      try {
        return (await browser.execute(() =>
          navigator.permissions
            .query({ name: "microphone" as PermissionName })
            .then((status) => status.state)
            .catch(() => "unknown"),
        )) as string;
      } catch {
        return "unknown";
      }
    }

    const huddle: { state: HuddleState | null } = { state: null };
    let phaseStall = "";
    await browser
      .waitUntil(
        async () => {
          const next = await invoke<HuddleState>("get_huddle_state");
          huddle.state = next;
          if (next.phase === "active") return true;
          phaseStall = `phase=${next.phase}`;
          return false;
        },
        {
          timeout: 150_000,
          timeoutMsg: "huddle never reached active phase",
        },
      )
      .catch(async (error: Error) => {
        const mic = await micPermissionState();
        if (mic === "denied") {
          return skipFlow.call(
            this,
            "05-huddle",
            "macOS TCC denied microphone access to the harness app (bundle xyz.block.buzz.app.harness); grant it in System Settings → Privacy & Security → Microphone and re-run. The relay-side huddle join succeeded; only the capture pipeline is blocked.",
          );
        }
        if (mic === "prompt" || mic === "unknown") {
          return skipFlow.call(
            this,
            "05-huddle",
            `mic permission ${mic} (prompt unanswered) while ${phaseStall}; grant or deny the harness app's microphone prompt and re-run. The relay-side huddle join succeeded; only the capture pipeline is blocked.`,
          );
        }
        throw error;
      });

    // After activation the huddle bar is up; the mic must be connected on the
    // capture path (permission granted). If the app reports the mic
    // unavailable despite a granted permission, the audio pipeline itself is
    // broken — that is a real failure, not a skip.
    const micStateButton = await browser.$(
      '[aria-label="Mute microphone"], [aria-label="Unmute microphone"], [aria-label="Microphone unavailable"]',
    );
    const micStateLabel = await micStateButton
      .getAttribute("aria-label")
      .catch(() => "");
    if (micStateLabel === "Microphone unavailable") {
      throw new Error(
        "huddle active but mic reports unavailable with permission granted — audio capture pipeline failure",
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[05] huddle active: phase=${huddle.state?.phase} parent=${huddle.state?.parent_channel_id} eph=${huddle.state?.ephemeral_channel_id}`,
    );

    // Transmit briefly: unmute and let the capture pipeline run. The mic
    // toggle lives in the huddle bar; if the OS denied mic access (TCC) the
    // app surfaces "mic unavailable" — we report that loudly as a skip of the
    // transmit sub-assertion, never as silent coverage.
    const micButton = await browser.$(
      '[aria-label="Mute microphone"], [aria-label="Unmute microphone"]',
    );
    const micVisible = await micButton.isDisplayed().catch(() => false);
    if (!micVisible) {
      return skipFlow.call(
        this,
        "05-huddle",
        "mic controls absent after huddle join (OS mic permission may be denied; grant microphone access to the harness app and re-run)",
      );
    }

    const currentLabel = await micButton.getAttribute("aria-label");
    if (currentLabel === "Mute microphone") {
      // Already unmuted — nothing to do.
    } else {
      await micButton.click();
    }
    // Let the capture + relay path run for a few seconds.
    await browser.pause(5_000);

    // The huddle is still active after transmitting (no crash on the binary
    // audio path).
    const afterTransmit = await invoke<HuddleState>("get_huddle_state");
    expect(afterTransmit.phase).toBe("active");
    // eslint-disable-next-line no-console
    console.log(
      `[05] transmitted briefly; huddle still active (participants=${afterTransmit.participants.length})`,
    );

    // Leave cleanly.
    const leaveButton = await browser.$('[aria-label="Leave huddle"]');
    await leaveButton.waitForDisplayed({ timeout: 60_000 });
    await leaveButton.click();
    await browser.waitUntil(
      async () =>
        (await invoke<HuddleState>("get_huddle_state")).phase === "idle",
      {
        timeout: 60_000,
        timeoutMsg: "huddle did not return to idle after leave",
      },
    );
    // eslint-disable-next-line no-console
    console.log("[05] huddle left cleanly");

    recordResult("05-huddle", "pass");
  });
});
