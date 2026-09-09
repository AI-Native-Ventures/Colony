import {
  NativeChannel,
  setNativeBridge,
  type NativeBridge,
  type NativeEvent,
  type NativeNotificationAction,
} from "./nativeBridge";
import { checkElectronUpdate } from "./electronUpdater";

export type ElectronPush = {
  type: string;
  id?: number;
  sequence?: number;
  payload?: unknown;
  name?: string;
};
export interface ElectronDesktop {
  request<T = unknown>(
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<T>;
  subscribe(callback: (message: ElectronPush) => void): () => void;
}

declare global {
  interface Window {
    colonyDesktop?: ElectronDesktop;
  }
}

/** Present only in the trusted Electron shell, never in a remote browser view. */
export function electronDesktop(): ElectronDesktop | undefined {
  return typeof window === "undefined" ? undefined : window.colonyDesktop;
}

function decode(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__colony_binary" in value &&
    typeof value.__colony_binary === "string"
  ) {
    return Uint8Array.from(atob(value.__colony_binary), (char) =>
      char.charCodeAt(0),
    ).buffer;
  }
  return value;
}

class ElectronNativeBridge implements NativeBridge {
  private nextChannel = 10;
  private channels = new Map<
    number,
    {
      channel: WeakRef<NativeChannel>;
      next: number;
      pending: Map<number, unknown>;
    }
  >();
  private listeners = new Map<number, (payload: unknown) => void>();
  private earlyEvents = new Map<number, unknown[]>();
  private shellListeners = new Map<string, Set<(payload: unknown) => void>>();

  private api: ElectronDesktop;

  constructor(api: ElectronDesktop) {
    this.api = api;
    api.subscribe((message) => {
      if (
        message.type === "channel" &&
        message.id !== undefined &&
        message.sequence !== undefined
      ) {
        const stream = this.channels.get(message.id);
        const channel = stream?.channel.deref();
        if (
          stream &&
          channel &&
          Number.isSafeInteger(message.sequence) &&
          message.sequence >= stream.next
        ) {
          if (stream.pending.size >= 1024) {
            this.channels.delete(message.id);
            throw new Error("Native channel reorder limit exceeded");
          }
          stream.pending.set(message.sequence, message.payload);
          while (stream.pending.has(stream.next)) {
            const payload = stream.pending.get(stream.next);
            stream.pending.delete(stream.next++);
            channel.onmessage?.(decode(payload));
          }
        }
      }
      if (message.type === "event" && message.id !== undefined) {
        const callback = this.listeners.get(message.id);
        if (callback) callback(message.payload);
        else if (this.earlyEvents.size < 128) {
          const queued = this.earlyEvents.get(message.id) ?? [];
          if (queued.length < 64) queued.push(message.payload);
          this.earlyEvents.set(message.id, queued);
        }
      }
      if (message.type === "shell" && message.name) {
        for (const callback of this.shellListeners.get(message.name) ?? [])
          callback(message.payload);
      }
    });
  }

  private convert(value: unknown): unknown {
    if (value instanceof NativeChannel) {
      const id = ++this.nextChannel;
      for (const [key, reference] of this.channels)
        if (!reference.channel.deref()) this.channels.delete(key);
      this.channels.set(id, {
        channel: new WeakRef(value),
        next: 0,
        pending: new Map(),
      });
      return `__CHANNEL__:${id}`;
    }
    if (Array.isArray(value)) return value.map((item) => this.convert(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.convert(item)]),
      );
    return value;
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return decode(
      await this.api.request("invoke", {
        command,
        args: this.convert(args) ?? {},
      }),
    ) as T;
  }
  async invokeRawBinary<T>(
    command: string,
    payload: Uint8Array,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    let text = "";
    for (let offset = 0; offset < payload.length; offset += 16384)
      text += String.fromCharCode(...payload.subarray(offset, offset + 16384));
    return decode(
      await this.api.request("invoke", {
        command,
        binary: btoa(text),
        headers: options?.headers ?? {},
      }),
    ) as T;
  }
  async listen<T>(
    event: string,
    handler: (event: NativeEvent<T>) => void,
  ): Promise<() => void> {
    const id = await this.api.request<number>("listen", { event });
    const deliver = (payload: unknown) =>
      handler({ event, payload: payload as T });
    this.listeners.set(id, deliver);
    for (const payload of this.earlyEvents.get(id) ?? []) deliver(payload);
    this.earlyEvents.delete(id);
    return () => {
      this.listeners.delete(id);
      void this.api.request("unlisten", { subscription: id }).catch(() => {});
    };
  }
  emit(event: string, payload?: unknown) {
    return this.api.request<void>("emit", { event, payload });
  }
  // Historical interface name: callers use this to mean "native desktop".
  isTauri() {
    return true;
  }
  private shell<T = void>(
    operation: string,
    args: Record<string, unknown> = {},
  ) {
    return this.api.request<T>("shell", { operation, ...args });
  }
  openUrl(url: string) {
    return this.shell("openUrl", { url });
  }
  getVersion() {
    return this.shell<string>("version");
  }
  homeDir() {
    return this.shell<string>("homeDir");
  }
  relaunch() {
    return this.shell("relaunch");
  }
  checkForUpdate(options?: { timeout?: number }) {
    return checkElectronUpdate(this.invoke.bind(this), options);
  }
  notificationPermissionGranted() {
    return this.shell<boolean>("notificationPermission");
  }
  requestNotificationPermission() {
    return this.shell<NotificationPermission>("requestNotificationPermission");
  }
  async onNotificationAction(
    handler: (notification: NativeNotificationAction) => void,
  ) {
    const remove = this.onShell("notification", (payload) =>
      handler(payload as NativeNotificationAction),
    );
    return { unregister: async () => remove() };
  }
  startDragging() {
    return this.shell("startDragging");
  }
  isFullscreen() {
    return this.shell<boolean>("isFullscreen");
  }
  setBadgeCount(count?: number) {
    return this.shell("badgeCount", { count });
  }
  setBadgeLabel(label?: string) {
    return this.shell("badgeLabel", { label });
  }
  requestUserAttention(kind: "Informational" | "Critical") {
    return this.shell("attention", { kind });
  }
  unminimize() {
    return this.shell("unminimize");
  }
  showWindow() {
    return this.shell("show");
  }
  closeWindow() {
    return this.shell("close");
  }
  windowLabel() {
    return "main";
  }
  setFocus() {
    return this.shell("focus");
  }
  private onShell(name: string, callback: (value: unknown) => void) {
    const group = this.shellListeners.get(name) ?? new Set();
    group.add(callback);
    this.shellListeners.set(name, group);
    return () => {
      group.delete(callback);
    };
  }
  async onWindowThemeChanged(handler: (theme: "light" | "dark") => void) {
    return this.onShell("theme", (value) => handler(value as "light" | "dark"));
  }
  async onWindowResized(handler: () => void) {
    return this.onShell("resize", handler);
  }
  setWebviewZoom(value: number) {
    return this.shell("zoom", { value });
  }
}

/** Install before React renders; preserve the existing feature call contract. */
export function installElectronNativeBridge(): boolean {
  const api = electronDesktop();
  if (!api) return false;
  setNativeBridge(new ElectronNativeBridge(api));
  return true;
}
