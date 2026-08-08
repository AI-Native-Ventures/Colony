/**
 * Parity recorder adapter over the NativeBridge seam.
 *
 * The Bridge Seam (`desktop/src/shared/api/nativeBridge.ts`, PR #157) owns
 * the canonical `NativeBridge` interface: flat named plugin methods plus
 * `invoke`/`invokeRawBinary`/`listen`/`emit` and the `NativeChannel` class.
 * The recorder hooks exactly the four surfaces the oracle contract names:
 * `invoke` (commands), `invokeRawBinary` (binary commands), `listen`
 * (emitted events), and `NativeChannel.onmessage` (subscription push —
 * relay traffic arrives as callbacks, not command responses).
 *
 * The named plugin methods (`openUrl`, `setBadgeCount`, `onWindowResized`,
 * ...) are shell concerns and are not part of the 263-command contract, so
 * they pass through unrecorded. A Proxy forwards them untouched.
 *
 * Record mode installs the wrapped bridge with `setNativeBridge`; replay
 * restores the raw bridge and feeds the trace to it directly.
 */

import {
  NativeChannel,
  type NativeBridge,
  type NativeEvent,
  type NativeUnlisten,
} from "@/shared/api/nativeBridge";
import type { ParityRecorder } from "@/parity/recorder";
import { fingerprintBinary } from "@/parity/types";

export function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const candidate = (error as Record<string, unknown>).message;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return String(error);
}

/**
 * Serialize values the way Tauri's IPC layer does, with binary payloads
 * replaced by fingerprints and `NativeChannel` instances by their channel
 * marker (`__CHANNEL__:<oracleId>`). Everything else is a plain JSON
 * round-trip.
 */
export async function toRecordable(
  value: unknown,
  channelIdFor: (channel: NativeChannel) => number,
): Promise<unknown> {
  if (value instanceof NativeChannel) {
    return `__CHANNEL__:${channelIdFor(value)}`;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return fingerprintBinary(value);
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(await toRecordable(item, channelIdFor));
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    const toJson = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJson === "function") {
      return toRecordable(toJson.call(value), channelIdFor);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = await toRecordable(item, channelIdFor);
    }
    return out;
  }
  return value;
}

/**
 * Wrap any `NativeBridge` implementation so all oracle-relevant traffic is
 * recorded: commands (invoke), binary commands (invokeRawBinary, payload
 * fingerprinted to hash+length), emitted events (listen deliveries and
 * frontend emits), and subscription pushes (NativeChannel.onmessage).
 */
export function wrapNativeBridge(
  bridge: NativeBridge,
  recorder: ParityRecorder,
): NativeBridge {
  const channelIds = new WeakMap<NativeChannel, number>();
  const wrappedChannels = new WeakSet<NativeChannel>();
  let nextChannelId = 1;

  const channelIdFor = (channel: NativeChannel): number => {
    let id = channelIds.get(channel);
    if (id === undefined) {
      id = nextChannelId;
      nextChannelId += 1;
      channelIds.set(channel, id);
    }
    return id;
  };

  /**
   * Record pushes arriving on a channel the app passed into an invoke.
   * The Tauri implementation reads `channel.onmessage` at delivery time
   * (the Tauri Channel callback closes over the NativeChannel), so
   * replacing the handler here captures every push without touching the
   * app's own handler.
   */
  const wrapChannel = (channel: NativeChannel): void => {
    if (wrappedChannels.has(channel)) {
      return;
    }
    wrappedChannels.add(channel);
    const id = channelIdFor(channel);
    const inner = channel.onmessage;
    const recording = (message: unknown): void => {
      void recorder.recordPush(`__CHANNEL__:${id}`, message);
      inner?.(message);
    };
    channel.onmessage = recording as never;
  };

  const wrapChannelsInArgs = (args: unknown): void => {
    if (Array.isArray(args)) {
      for (const item of args) {
        wrapChannelsInArgs(item);
      }
      return;
    }
    if (typeof args === "object" && args !== null) {
      for (const item of Object.values(args as Record<string, unknown>)) {
        if (item instanceof NativeChannel) {
          wrapChannel(item);
        } else {
          wrapChannelsInArgs(item);
        }
      }
    }
  };

  const wrappedInvoke = async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    wrapChannelsInArgs(args);
    const startedAt = performance.now();
    try {
      const result = await bridge.invoke<T>(command, args);
      const durationMs = performance.now() - startedAt;
      await recorder.recordCommand(
        command,
        await toRecordable(args, channelIdFor),
        { ok: true, result: await toRecordable(result, channelIdFor) },
        durationMs,
      );
      return result;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      await recorder.recordCommand(
        command,
        await toRecordable(args, channelIdFor),
        { ok: false, error: { message: errorMessage(error) } },
        durationMs,
      );
      throw error;
    }
  };

  const wrappedInvokeRawBinary = async (
    command: string,
    payload: Uint8Array,
  ): Promise<unknown> => {
    const startedAt = performance.now();
    try {
      const result = await bridge.invokeRawBinary(command, payload);
      const durationMs = performance.now() - startedAt;
      await recorder.recordCommand(
        command,
        await fingerprintBinary(payload),
        { ok: true, result: await toRecordable(result, channelIdFor) },
        durationMs,
      );
      return result;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      await recorder.recordCommand(
        command,
        await fingerprintBinary(payload),
        { ok: false, error: { message: errorMessage(error) } },
        durationMs,
      );
      throw error;
    }
  };

  const wrappedListen = async <T>(
    event: string,
    handler: (event: NativeEvent<T>) => void,
  ): Promise<NativeUnlisten> => {
    return bridge.listen<T>(event, (delivery) => {
      void recorder.recordEvent(delivery.event, delivery.payload);
      return handler(delivery);
    });
  };

  const wrappedEmit = async (
    event: string,
    payload?: unknown,
  ): Promise<void> => {
    void recorder.recordEvent(event, payload);
    return bridge.emit(event, payload);
  };

  return new Proxy(bridge, {
    get(target, prop, receiver) {
      if (prop === "invoke") {
        return wrappedInvoke;
      }
      if (prop === "invokeRawBinary") {
        return wrappedInvokeRawBinary;
      }
      if (prop === "listen") {
        return wrappedListen;
      }
      if (prop === "emit") {
        return wrappedEmit;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
