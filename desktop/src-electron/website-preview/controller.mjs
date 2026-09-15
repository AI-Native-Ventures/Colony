import { randomUUID } from "node:crypto";

/** Own preview handles for one trusted app renderer and selected community. */
export class PreviewController {
  generation = 0;
  handles = new Set();

  constructor({ host, window, context }) {
    this.host = host;
    this.window = window;
    this.context = context;
  }

  /** Revoke synchronously before asynchronous view/session cleanup. */
  reset() {
    this.generation += 1;
    this.handles.clear();
    return this.host.invalidateAll();
  }

  /** Called only after the main process validates the IPC sender and frame. */
  async request(action, payload) {
    const generation = this.generation;
    const community = this.context();
    if (!community || payload.communityId !== community.id) {
      throw new Error("Select this preview's community before opening it");
    }
    if (action === "open") {
      const state = await this.host.open({
        window: this.window,
        mountId: randomUUID(),
        communityId: community.id,
        artifactId: payload.artifactId,
        threadRoot: payload.threadRoot,
        revision: payload.revision,
        manifest: payload.manifest,
        viewport: payload.viewport,
        bounds: payload.bounds,
        clip: payload.clip,
        radius: payload.radius,
      });
      if (generation !== this.generation || this.context() !== community) {
        await this.host.close({ window: this.window, handle: state.handle });
        throw new Error("Preview context changed; reopen this preview");
      }
      this.handles.add(state.handle);
      return state;
    }
    if (!this.handles.has(payload.handle)) {
      throw new Error("Preview handle is no longer active");
    }
    const identity = { window: this.window, handle: payload.handle };
    if (action === "bounds") {
      return this.host.updateBounds({ ...identity, bounds: payload.bounds, clip: payload.clip });
    }
    if (action === "visible") {
      return this.host.setVisible({ ...identity, visible: payload.visible === true });
    }
    if (action === "close") {
      this.handles.delete(payload.handle);
      return this.host.close(identity);
    }
    throw new Error("Unsupported preview request");
  }
}
