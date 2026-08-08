// Flow 04 — spawn a managed agent, then stop it.
// Reaches: sidecar spawn (real bundled buzz-acp binary), the protected PID
// set (managed_agent_processes), and the reaper/stop path. The process
// assertions run from the spec against the real OS, not from inside the app.
import { browser, expect } from "@wdio/globals";

import { getIdentity, invoke, waitForFirstPaint } from "../helpers/app";
import { RELAY_WS_URL } from "../helpers/env";
import { waitForNoProcessWhere, waitForProcessWhere } from "../helpers/process";
import { recordResult } from "../helpers/results";

type RuntimeStatus = {
  pubkey: string;
  relay_url: string;
  // ManagedAgentRuntimeLifecycle serializes snake_case (runtime_types.rs).
  lifecycle:
    | "starting"
    | "listening"
    | "waking"
    | "ready"
    | "failed"
    | "stopped";
  pid: number | null;
  error: string | null;
};

type CreateAgentResponse = {
  agent: {
    pubkey: string;
    name: string;
  };
};

describe("04 managed agent spawn + stop", () => {
  it("spawns a real sidecar process, tracks it, and stops it", async () => {
    recordResult("04-agent", "pass", "running");

    await waitForFirstPaint();
    const identity = await getIdentity();
    expect(identity.locked).toBe(false);

    // Restored state from flow 03: the community is already joined. The
    // community view mounts on boot and can take time on a loaded machine —
    // wait for it rather than sampling once (a single isDisplayed() check
    // races the boot-time reconnection and misreports as "not restored").
    const community = await browser.$('[data-testid="channel-general"]');
    await community.waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: "community state not restored (flow 03 must run first)",
    });

    // Create a managed agent record through the real backend command the UI
    // calls (create_managed_agent). No persona required for a smoke spawn.
    //
    // The ACP command is pinned to the harness bundle's own sidecar
    // (Contents/MacOS/buzz-acp). On a dev machine the app's workspace-command
    // resolution would otherwise prefer a leftover `target/release/buzz-acp`
    // from the build that produced this bundle, and the flow would prove
    // nothing about the packaged app. An installed app has no workspace dirs,
    // so it resolves the same bundled binary this pin selects.
    const bundleAcp = `${process.env.BUZZ_REAL_SHELL_APP ?? "desktop/src-tauri/target/release/bundle/macos/Colony.app"}/Contents/MacOS/buzz-acp`;
    const name = `real-shell-agent-${Date.now()}`;
    const created = await invoke<CreateAgentResponse>("create_managed_agent", {
      input: {
        name,
        relayUrl: RELAY_WS_URL,
        acpCommand: bundleAcp,
        startOnAppLaunch: false,
        spawnAfterCreate: false,
      },
    });
    const agentPubkey = created.agent.pubkey;
    expect(agentPubkey).toMatch(/^[0-9a-f]{64}$/i);
    // eslint-disable-next-line no-console
    console.log(`[04] created agent ${name} pubkey=${agentPubkey}`);

    // Spawn the sidecar runtime.
    const started = await invoke<RuntimeStatus>("start_managed_agent_runtime", {
      pubkey: agentPubkey,
      relayUrl: RELAY_WS_URL,
    });
    expect(started.lifecycle).not.toBe("failed");

    // Watch the app's own runtime table briefly: a sidecar that dies within
    // the first seconds is a spawn/readiness problem, and the lifecycle
    // transitions (starting -> ready/stopped/failed) say which side saw it.
    for (let i = 0; i < 8; i += 1) {
      const snap = await invoke<RuntimeStatus[]>("list_managed_agent_runtimes");
      const row = snap.find((r) => r.pubkey === agentPubkey);
      // eslint-disable-next-line no-console
      console.log(
        `[04] runtime snapshot t=${i * 0.5}s lifecycle=${row?.lifecycle ?? "gone"} pid=${row?.pid ?? "null"} error=${row?.error ?? ""}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // A real bundled sidecar process must appear. Tauri bundles externalBin
    // inside the app bundle, so the process must live under the harness
    // bundle path (proves the packaged app spawned it, not a dev tree).
    // Scope to THIS bundle: a sibling dev instance (or another worktree's
    // suite) may have its own buzz-acp running; only the one under the
    // harness bundle path proves the packaged app spawned it.
    const bundlePath = process.env.BUZZ_REAL_SHELL_APP ?? "";
    const proc = await waitForProcessWhere(
      (row) =>
        row.command.includes("buzz-acp") &&
        row.command.includes("Colony.app") &&
        row.command.includes(bundlePath),
      120_000,
      "harness-bundled buzz-acp sidecar",
    );
    expect(proc.command).toContain("buzz-acp");
    expect(proc.command).toContain(bundlePath);
    // eslint-disable-next-line no-console
    console.log(
      `[04] sidecar process pid=${proc.pid}: ${proc.command.slice(0, 160)}`,
    );

    // The runtime table tracks it with a live pid.
    await browser.waitUntil(
      async () => {
        const runtimes = await invoke<RuntimeStatus[]>(
          "list_managed_agent_runtimes",
        );
        return runtimes.some(
          (r) => r.pubkey === agentPubkey && r.pid !== null && r.pid > 0,
        );
      },
      { timeout: 60_000, timeoutMsg: "runtime never reported a live pid" },
    );

    // Stop it through the real stop path.
    const stopped = await invoke<RuntimeStatus>("stop_managed_agent_runtime", {
      pubkey: agentPubkey,
      relayUrl: RELAY_WS_URL,
    });
    expect(stopped.lifecycle).toBe("stopped");

    // The OS process is gone (reaper / terminate path).
    await waitForNoProcessWhere(
      (row) =>
        row.command.includes("buzz-acp") &&
        row.command.includes("Colony.app") &&
        row.command.includes(bundlePath),
      60_000,
      "harness-bundled buzz-acp sidecar",
    );
    const runtimesAfter = await invoke<RuntimeStatus[]>(
      "list_managed_agent_runtimes",
    );
    const after = runtimesAfter.find((r) => r.pubkey === agentPubkey);
    // The stop path removes the runtime from the tracked set entirely, so
    // "row gone" and "row present with pid null" are both a clean stop.
    expect(after === undefined || after.pid === null).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[04] sidecar process reaped; runtime stopped");

    recordResult("04-agent", "pass", `pid=${proc.pid}`);
  });
});
