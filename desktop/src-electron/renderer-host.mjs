import { EventEmitter } from "node:events";

const MAX_CHANNEL_ID = 0xffffffff;

/** Fence renderer lifetimes while preserving the native host and managed agents. */
export class RendererHost extends EventEmitter {
  generation = 0;
  nextChannel = 0;
  channels = new Map();
  rendererChannels = new Map();
  subscriptions = new Set();
  inflight = new Set();
  updates = new Set();
  barrier = Promise.resolve();
  failure = null;

  constructor(host) {
    super();
    this.host = host;
    host.on("channel", (message) => {
      const id = this.channels.get(message.id);
      if (id !== undefined && !this.failure)
        this.emit("channel", { ...message, id });
    });
    host.on("event", (message) => {
      if (this.subscriptions.has(message.id) && !this.failure)
        this.emit("event", message);
    });
    host.on("disconnected", (message) => {
      this.failure = new Error(message);
      this.channels.clear();
      this.subscriptions.clear();
    });
  }

  check(generation) {
    if (this.failure) throw this.failure;
    if (generation !== this.generation)
      throw new Error("Desktop renderer changed; reopen this action");
  }

  remap(value) {
    if (typeof value === "string") {
      const match = /^__CHANNEL__:(\d+)$/.exec(value);
      if (!match) return value;
      const rendererId = Number(match[1]);
      if (!Number.isSafeInteger(rendererId) || rendererId > MAX_CHANNEL_ID)
        throw new Error("Invalid native channel id");
      let id = this.rendererChannels.get(rendererId);
      if (id === undefined) {
        if (this.nextChannel >= MAX_CHANNEL_ID)
          throw new Error("Native channel ids exhausted; restart the desktop");
        id = ++this.nextChannel;
        this.rendererChannels.set(rendererId, id);
        this.channels.set(id, rendererId);
      }
      return `__CHANNEL__:${id}`;
    }
    if (Array.isArray(value)) return value.map((item) => this.remap(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.remap(item)]),
      );
    return value;
  }

  async request(type, payload = {}) {
    const generation = this.generation;
    await this.barrier;
    await this.host.ready;
    this.check(generation);
    let id;
    if (type === "listen") {
      // Register before sending: Rust may push an event before its listen reply.
      id = this.host.nextId();
      this.subscriptions.add(id);
    } else if (type === "unlisten") {
      if (!this.subscriptions.delete(payload.subscription)) return;
    } else if (type === "invoke") {
      payload = { ...payload, args: this.remap(payload.args) };
    } else if (type !== "emit") {
      throw new Error("Unsupported native renderer request");
    }
    // An explicit close is itself tracked in flight; reset must not close it twice.
    if (type === "invoke" && payload.command === "plugin:resources|close")
      this.updates.delete(payload.args?.rid);
    const pending = this.host
      .request(type, payload, id)
      .then(async (result) => {
        if (
          type === "invoke" &&
          payload.command === "electron_check_for_update" &&
          Number.isSafeInteger(result?.rid)
        ) {
          if (generation === this.generation) this.updates.add(result.rid);
          else {
            try {
              await this.host.request("invoke", {
                command: "plugin:resources|close",
                args: { rid: result.rid },
              });
            } catch {
              throw new Error(
                "Late update resource retirement failed; restart the desktop",
              );
            }
          }
        }
        return result;
      });
    this.inflight.add(pending);
    try {
      const result = await pending;
      this.check(generation);
      return result;
    } catch (error) {
      if (type === "listen" && generation === this.generation)
        this.subscriptions.delete(id);
      throw error;
    } finally {
      this.inflight.delete(pending);
    }
  }

  /** Invalidate pushes immediately; retire old resources before accepting calls. */
  reset() {
    this.generation++;
    const subscriptions = [...this.subscriptions];
    const pending = [...this.inflight];
    const updates = [...this.updates];
    this.updates.clear();
    this.subscriptions.clear();
    this.channels.clear();
    this.rendererChannels.clear();
    const previous = this.barrier;
    this.barrier = (async () => {
      await previous;
      // Native update resources own their network futures. Retire before waiting
      // so a renderer crash aborts downloads instead of blocking the next view.
      await Promise.all(
        updates.map((rid) =>
          this.host.request("invoke", {
            command: "plugin:resources|close",
            args: { rid },
          }),
        ),
      );
      // A pending listen must finish before unlisten; pending creates must
      // finish before their cleanup, or they could outlive the reset fence.
      const settled = await Promise.allSettled(pending);
      const cleanup = await Promise.allSettled([
        (async () => {
          let failed = false;
          // Keep retirement below the transport's pending-request cap even
          // when the old renderer subscribed to hundreds of native events.
          for (const subscription of subscriptions) {
            try {
              await this.host.request("unlisten", { subscription });
            } catch {
              failed = true;
            }
          }
          if (failed) throw new Error("Native subscription retirement failed");
        })(),
        this.host.request("invoke", {
          command: "plugin:websocket|disconnect_all",
          args: {},
        }),
        this.host.request("invoke", {
          command: "workspace_terminal_close_all",
          args: {},
        }),
      ]);
      // Native command rejections are serialized values. An Error from the
      // transport means completion is unknown, so reopening would be unsafe.
      if (
        settled.some(
          (item) => item.status === "rejected" && item.reason instanceof Error,
        ) ||
        cleanup.some((item) => item.status === "rejected")
      )
        throw new Error("Native renderer cleanup failed; restart the desktop");
      if (this.failure) throw this.failure;
    })().catch((error) => {
      this.failure = error;
      throw error;
    });
    // The window may close before another caller awaits the reset barrier.
    this.barrier.catch(() => {});
    return this.barrier;
  }
}
