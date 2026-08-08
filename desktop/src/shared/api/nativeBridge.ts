/**
 * NativeBridge — the single interface every native call in `desktop/src`
 * passes through. The shell is a substitution, not a rewrite: Phase 2/3 of the
 * Electron migration supply a different implementation of this interface
 * without touching feature code.
 *
 * The payload classes come from the daemon contract (electron-migration
 * daemon-contract, "What crosses the boundary"):
 *
 * | Class | Count | Commands | Surface here |
 * | --- | --- | --- | --- |
 * | Plain JSON request/response | 252 | most | `invoke` |
 * | Raw binary out | 1 | `push_audio_pcm` | `invokeRawBinary` |
 * | Subscription with server push | 3 | `plugin:websocket\|connect` | `NativeChannel` passed through `invoke` args |
 * | Event listen/unlisten | 18 | Rust `app.emit` names | `listen` / `emit` |
 *
 * This module is the ONLY place the app knows the shape of the shell
 * boundary. It must not import `@tauri-apps/*` — that dependency lives in
 * `tauriNativeBridge.ts` (the Tauri implementation) and `src/testing/`
 * (the e2e mock). `scripts/check-native-bridge-boundary.mjs` enforces it.
 */
/**
 * Event delivered to a `listen` handler (payload class: events). The mock
 * delivers `{ event, payload }` (mirroring the mocked `plugin:event|emit`
 * payload); handlers must only rely on `payload`.
 */
export interface NativeEvent<T> {
  event: string;
  payload: T;
}

/**
 * Notification action payload delivered by `onNotificationAction`
 * (plugin-notification `actionPerformed` event).
 */
export interface NativeNotificationAction {
  id?: number;
  text?: string | null;
  extra?: Record<string, unknown> | null;
}

/** Removes a registered listener. */
export type NativeUnlisten = () => void;

/**
 * Subscription with server push (payload class: `plugin:websocket|connect`).
 *
 * Mirrors the shape the mock and the Tauri IPC both understand: a callback
 * the implementation can invoke when the native side pushes a message.
 * The Tauri implementation converts this to a `tauri::ipc::Channel`-backed
 * `@tauri-apps/api` Channel at invoke time.
 */
export class NativeChannel<T = unknown> {
  onmessage: ((message: T) => void) | null;

  constructor(onmessage?: (message: T) => void) {
    this.onmessage = onmessage ?? null;
  }
}

/** Update handle returned by `checkForUpdate` (plugin-updater surface). */
export interface NativeUpdate {
  version: string;
  download(): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

/** Listener handle returned by `onNotificationAction` (plugin-notification). */
export interface NativeNotificationActionListener {
  unregister(): Promise<void>;
}

/**
 * The shell surface the frontend may touch. One implementation is installed
 * per runtime: `tauriNativeBridge.ts` in the Tauri app, the e2e mock in
 * `src/testing/e2eBridge.ts`, per-test mocks in unit tests.
 */
export interface NativeBridge {
  /** Plain request/response command (252 commands). */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Raw binary command payload (1 command: `push_audio_pcm`). */
  invokeRawBinary(command: string, payload: Uint8Array): Promise<unknown>;
  /** Subscribe to a backend-emitted event (18 names). */
  listen<T>(
    event: string,
    handler: (event: NativeEvent<T>) => void,
  ): Promise<NativeUnlisten>;
  /** Emit an event to the shell (e.g. initial-render-ready). */
  emit(event: string, payload?: unknown): Promise<void>;
  /** Whether the app runs inside the native shell. */
  isTauri(): boolean;
  /** plugin:opener — open a URL in the system browser. */
  openUrl(url: string): Promise<void>;
  /** plugin:app — app version string. */
  getVersion(): Promise<string>;
  /** plugin:path — the user's home directory. */
  homeDir(): Promise<string>;
  /** plugin:process — relaunch the app. */
  relaunch(): Promise<void>;
  /** plugin:updater — check for an available update. */
  checkForUpdate(options?: {
    headers?: Record<string, string>;
  }): Promise<NativeUpdate | null>;
  /** plugin:notification — whether notification permission is granted. */
  notificationPermissionGranted(): Promise<boolean>;
  /** plugin:notification — request notification permission. */
  requestNotificationPermission(): Promise<NotificationPermission>;
  /** plugin:notification — react to a clicked notification action. */
  onNotificationAction(
    handler: (notification: NativeNotificationAction) => void,
  ): Promise<NativeNotificationActionListener>;
  /** plugin:window — start dragging the window from a drag region. */
  startDragging(): Promise<void>;
  /** plugin:window — whether the window is fullscreen. */
  isFullscreen(): Promise<boolean>;
  /** plugin:window — set the app badge count (macOS). */
  setBadgeCount(count?: number): Promise<void>;
  /** plugin:window — set the app badge label (macOS). */
  setBadgeLabel(label?: string): Promise<void>;
  /** plugin:window — request user attention (dock bounce). */
  requestUserAttention(kind: "Informational" | "Critical"): Promise<void>;
  /** plugin:window — unminimize the window. */
  unminimize(): Promise<void>;
  /** plugin:window — show the window. */
  showWindow(): Promise<void>;
  /** plugin:window — close the current window (huddle popout closing itself). */
  closeWindow(): Promise<void>;
  /** plugin:window — this window's label. Sync: metadata read, not IPC. */
  windowLabel(): string;
  /** plugin:window — focus the window. */
  setFocus(): Promise<void>;
  /** plugin:window — react to the native theme changing. */
  onWindowThemeChanged(
    handler: (theme: "light" | "dark") => void,
  ): Promise<NativeUnlisten>;
  /** plugin:window — react to the window being resized. */
  onWindowResized(handler: () => void): Promise<NativeUnlisten>;
  /** plugin:webview — set the webview zoom factor. */
  setWebviewZoom(value: number): Promise<void>;
}

let installed: NativeBridge | null = null;

/**
 * Install the bridge implementation the app uses from here on. The e2e mock
 * and unit tests call this; `installTauriNativeBridge` (entry point) uses it
 * too. Installed before the first render, so feature code always sees a
 * bridge by the time it runs.
 */
export function setNativeBridge(bridge: NativeBridge): void {
  installed = bridge;
}

/** Resolve the active bridge, installing it lazily on first use. */
export function getNativeBridge(): NativeBridge {
  if (!installed) {
    throw new Error(
      "NativeBridge is not installed. Call installTauriNativeBridge() (app) or setNativeBridge() (tests) before using native APIs.",
    );
  }
  return installed;
}

// ── Module-level proxies ──────────────────────────────────────────────────────
// Feature code calls these; each forwards to the installed bridge. Keeping the
// call shape identical to the old `@tauri-apps/*` imports means the 48-file
// routing was an import swap, not a behavior change.

export function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return getNativeBridge().invoke<T>(command, args);
}

export function invokeRawBinary(
  command: string,
  payload: Uint8Array,
): Promise<unknown> {
  return getNativeBridge().invokeRawBinary(command, payload);
}

export function listen<T>(
  event: string,
  handler: (event: NativeEvent<T>) => void,
): Promise<NativeUnlisten> {
  return getNativeBridge().listen<T>(event, handler);
}

export function emit(event: string, payload?: unknown): Promise<void> {
  return getNativeBridge().emit(event, payload);
}

export function isTauri(): boolean {
  return getNativeBridge().isTauri();
}

export function openUrl(url: string): Promise<void> {
  return getNativeBridge().openUrl(url);
}

export function getVersion(): Promise<string> {
  return getNativeBridge().getVersion();
}

export function homeDir(): Promise<string> {
  return getNativeBridge().homeDir();
}

export function relaunch(): Promise<void> {
  return getNativeBridge().relaunch();
}

export function checkForUpdate(options?: {
  headers?: Record<string, string>;
}): Promise<NativeUpdate | null> {
  return getNativeBridge().checkForUpdate(options);
}

export function notificationPermissionGranted(): Promise<boolean> {
  return getNativeBridge().notificationPermissionGranted();
}

export function requestNotificationPermission(): Promise<NotificationPermission> {
  return getNativeBridge().requestNotificationPermission();
}

export function onNotificationAction(
  handler: (notification: NativeNotificationAction) => void,
): Promise<NativeNotificationActionListener> {
  return getNativeBridge().onNotificationAction(handler);
}

export function startDragging(): Promise<void> {
  return getNativeBridge().startDragging();
}

export function isFullscreen(): Promise<boolean> {
  return getNativeBridge().isFullscreen();
}

export function setBadgeCount(count?: number): Promise<void> {
  return getNativeBridge().setBadgeCount(count);
}

export function setBadgeLabel(label?: string): Promise<void> {
  return getNativeBridge().setBadgeLabel(label);
}

export function requestUserAttention(
  kind: "Informational" | "Critical",
): Promise<void> {
  return getNativeBridge().requestUserAttention(kind);
}

export function unminimize(): Promise<void> {
  return getNativeBridge().unminimize();
}

export function showWindow(): Promise<void> {
  return getNativeBridge().showWindow();
}

export function closeWindow(): Promise<void> {
  return getNativeBridge().closeWindow();
}

export function windowLabel(): string {
  return getNativeBridge().windowLabel();
}

export function setFocus(): Promise<void> {
  return getNativeBridge().setFocus();
}

export function onWindowThemeChanged(
  handler: (theme: "light" | "dark") => void,
): Promise<NativeUnlisten> {
  return getNativeBridge().onWindowThemeChanged(handler);
}

export function onWindowResized(handler: () => void): Promise<NativeUnlisten> {
  return getNativeBridge().onWindowResized(handler);
}

export function setWebviewZoom(value: number): Promise<void> {
  return getNativeBridge().setWebviewZoom(value);
}
