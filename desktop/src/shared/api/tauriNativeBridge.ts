/**
 * The Tauri implementation of `NativeBridge`. The only module outside
 * `src/testing/` that may import `@tauri-apps/*` — the boundary check
 * (`scripts/check-native-bridge-boundary.mjs`) enforces that.
 *
 * Every method delegates to the official Tauri v2 JS API so command names,
 * argument shapes, and error messages stay byte-identical to the previous
 * direct-import call sites. Error messages are part of the contract: the
 * relay rate-limit prefix (`relay rate-limited:`) is matched in
 * `tauri.ts`'s `applyTauriRateLimitIfNeeded`, and it must never be wrapped.
 */
import {
  Channel,
  invoke as tauriInvoke,
  isTauri as tauriIsTauri,
} from "@tauri-apps/api/core";
import {
  emit as tauriEmit,
  listen as tauriListen,
} from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
} from "@tauri-apps/plugin-notification";

import {
  setNativeBridge,
  NativeChannel,
  type NativeBridge,
  type NativeEvent,
  type NativeNotificationAction,
  type NativeUnlisten,
  type NativeUpdate,
} from "./nativeBridge";

/**
 * Replace every `NativeChannel` in the invoke args with a real Tauri
 * `Channel`. The frontend only ever passes channels as top-level args today
 * (`plugin:websocket|connect` → `onMessage`), but a recursive walk keeps the
 * implementation correct if a nested channel ever appears.
 */
function toTauriArgs(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (args === undefined) {
    return undefined;
  }
  return convertValue(args) as Record<string, unknown>;
}

function convertValue(value: unknown): unknown {
  if (value instanceof NativeChannel) {
    return new Channel<unknown>((message) => {
      value.onmessage?.(message);
    });
  }
  if (Array.isArray(value)) {
    return value.map(convertValue);
  }
  if (value !== null && typeof value === "object") {
    const converted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      converted[key] = convertValue(entry);
    }
    return converted;
  }
  return value;
}

class TauriNativeBridge implements NativeBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return tauriInvoke<T>(command, toTauriArgs(args));
  }

  invokeRawBinary(command: string, payload: Uint8Array): Promise<unknown> {
    // Raw binary invoke — Tauri's typed API does not support InvokeBody::Raw
    // payloads, so this goes through the internal IPC like the pre-bridge
    // `huddle/lib/audioWorklet.ts` call did. Tested against Tauri v2; if this
    // breaks on upgrade, only this method needs updating.
    // biome-ignore lint/suspicious/noExplicitAny: Tauri internals have no public type definition
    const internals = (window as any).__TAURI_INTERNALS__;
    if (!internals?.invoke) {
      return Promise.reject(new Error("Tauri internals not available"));
    }
    return internals.invoke(command, payload);
  }

  listen<T>(
    event: string,
    handler: (event: NativeEvent<T>) => void,
  ): Promise<NativeUnlisten> {
    return tauriListen<T>(event, handler);
  }

  emit(event: string, payload?: unknown): Promise<void> {
    return tauriEmit(event, payload);
  }

  isTauri(): boolean {
    return tauriIsTauri();
  }

  openUrl(url: string): Promise<void> {
    return openUrl(url);
  }

  getVersion(): Promise<string> {
    return getVersion();
  }

  homeDir(): Promise<string> {
    return homeDir();
  }

  relaunch(): Promise<void> {
    return relaunch();
  }

  checkForUpdate(options?: {
    headers?: Record<string, string>;
  }): Promise<NativeUpdate | null> {
    return check(options);
  }

  notificationPermissionGranted(): Promise<boolean> {
    return isPermissionGranted();
  }

  requestNotificationPermission(): Promise<NotificationPermission> {
    return requestPermission();
  }

  onNotificationAction(
    handler: (notification: NativeNotificationAction) => void,
  ): Promise<{ unregister(): Promise<void> }> {
    return onAction(handler);
  }

  startDragging(): Promise<void> {
    return getCurrentWindow().startDragging();
  }

  isFullscreen(): Promise<boolean> {
    return getCurrentWindow().isFullscreen();
  }

  setBadgeCount(count?: number): Promise<void> {
    return getCurrentWindow().setBadgeCount(count);
  }

  setBadgeLabel(label?: string): Promise<void> {
    return getCurrentWindow().setBadgeLabel(label);
  }

  requestUserAttention(kind: "Informational" | "Critical"): Promise<void> {
    return getCurrentWindow().requestUserAttention(
      kind === "Informational"
        ? UserAttentionType.Informational
        : UserAttentionType.Critical,
    );
  }

  unminimize(): Promise<void> {
    return getCurrentWindow().unminimize();
  }

  showWindow(): Promise<void> {
    return getCurrentWindow().show();
  }

  closeWindow(): Promise<void> {
    return getCurrentWindow().close();
  }

  windowLabel(): string {
    return getCurrentWindow().label;
  }

  setFocus(): Promise<void> {
    return getCurrentWindow().setFocus();
  }

  onWindowThemeChanged(
    handler: (theme: "light" | "dark") => void,
  ): Promise<NativeUnlisten> {
    return getCurrentWindow().onThemeChanged(({ payload }) => {
      handler(payload);
    });
  }

  onWindowResized(handler: () => void): Promise<NativeUnlisten> {
    return getCurrentWindow().onResized(() => {
      handler();
    });
  }

  setWebviewZoom(value: number): Promise<void> {
    return getCurrentWebview().setZoom(value);
  }
}

/**
 * Install the Tauri bridge as the app's `NativeBridge`. Called from the app
 * entry (`desktop/src/main.tsx`) before render; the e2e mock replaces it
 * with `setNativeBridge` when running under a mock bridge.
 */
export function installTauriNativeBridge(): void {
  setNativeBridge(new TauriNativeBridge());
}
