/** Attempt every independent cleanup even if one resource fails to close. */
export class Cleanup {
  tasks = [];
  pending = null;
  add(task) {
    this.tasks.push(task);
  }
  run() {
    this.pending ??= Promise.allSettled(
      this.tasks.map((task) => Promise.resolve().then(task)),
    );
    return this.pending;
  }
}
