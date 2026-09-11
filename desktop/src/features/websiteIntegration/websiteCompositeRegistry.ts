/**
 * Tracks which instance event ids are presented by the delegated website
 * composite.
 *
 * The same card message can mount in both the channel timeline and the right
 * thread, so marks are reference-counted per instance event id: the plain
 * attachment stays hidden while any composite for that id is mounted, and
 * reappears only after the last one unmounts.
 *
 * The Block renderer delegates a trusted `website-job` card to
 * `WebsiteJobComposite`; the generic thread attachment must then stay hidden so
 * the owner never sees a second set of decision controls. The registry is a
 * tiny external store so the attachment re-renders as soon as the composite
 * mounts or unmounts.
 */

const rendered = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function markWebsiteCompositeRendered(
  instanceEventId: string,
): () => void {
  const count = rendered.get(instanceEventId) ?? 0;
  rendered.set(instanceEventId, count + 1);
  if (count === 0) notify();
  return () => {
    const current = rendered.get(instanceEventId);
    if (current === undefined) return;
    if (current <= 1) {
      rendered.delete(instanceEventId);
      notify();
      return;
    }
    rendered.set(instanceEventId, current - 1);
  };
}

export function isWebsiteCompositeRendered(instanceEventId: string): boolean {
  return rendered.has(instanceEventId);
}

export function subscribeWebsiteCompositeRegistry(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetWebsiteCompositeRegistry(): void {
  if (rendered.size === 0) return;
  rendered.clear();
  notify();
}
