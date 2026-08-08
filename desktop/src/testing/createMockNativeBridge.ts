import type { NativeBridge } from "@/shared/api/nativeBridge";

/**
 * Builds a full NativeBridge implementation backed by a single invoke
 * handler. Unit tests install it via `setNativeBridge(...)` so the module
 * under test exercises the real bridge proxy instead of `__TAURI_INTERNALS__`
 * internals.
 */
export function createMockNativeBridge(
  invokeHandler: (command: string, args: unknown) => Promise<unknown> | unknown,
): NativeBridge {
  return {
    invoke: async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => (await invokeHandler(command, args ?? null)) as T,
    invokeRawBinary: async (command: string, payload: Uint8Array) =>
      invokeHandler(command, payload),
    listen: async () => () => {},
    emit: async () => {},
    isTauri: () => false,
    openUrl: async () => {},
    getVersion: async () => "0.0.0-test",
    homeDir: async () => "/",
    relaunch: async () => {},
    checkForUpdate: async () => null,
    notificationPermissionGranted: async () => false,
    requestNotificationPermission: async () => "default",
    onNotificationAction: async () => ({
      unregister: async () => {},
    }),
    startDragging: async () => {},
    isFullscreen: async () => false,
    setBadgeCount: async () => {},
    setBadgeLabel: async () => {},
    requestUserAttention: async () => {},
    unminimize: async () => {},
    showWindow: async () => {},
    closeWindow: async () => {},
    windowLabel: () => "main",
    setFocus: async () => {},
    onWindowThemeChanged: async () => () => {},
    onWindowResized: async () => () => {},
    setWebviewZoom: async () => {},
  };
}
