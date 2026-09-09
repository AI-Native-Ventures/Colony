/** Queue OS links until the native host and visible app can receive them. */
export class DesktopDeepLinks {
  pending = [];
  deliver;

  enqueue(value) {
    if (typeof value !== "string" || value.length > 8192) return;
    let url;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (url.protocol !== "buzz:" || url.username || url.password) return;
    if (this.deliver) this.deliver(value);
    else if (this.pending.length < 16 && !this.pending.includes(value))
      this.pending.push(value);
  }

  ready(deliver) {
    this.deliver = deliver;
    for (const value of this.pending.splice(0)) deliver(value);
  }
}
