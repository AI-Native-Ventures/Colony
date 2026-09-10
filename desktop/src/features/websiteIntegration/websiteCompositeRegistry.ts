/**
 * Tracks which instance event ids are presented by the delegated website
 * composite.
 *
 * The Block renderer delegates a trusted `website-job` card to
 * `WebsiteJobComposite`; the generic thread attachment must then stay hidden so
 * the owner never sees a second set of decision controls. The registry is a
 * tiny external store so the attachment re-renders as soon as the composite
 * mounts or unmounts.
 */

const rendered = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function markWebsiteCompositeRendered(
  instanceEventId: string,
): () => void {
  if (!rendered.has(instanceEventId)) {
    rendered.add(instanceEventId);
    notify();
  }
  return () => {
    if (rendered.delete(instanceEventId)) notify();
  };
}

export function isWebsiteCompositeRendered(
  instanceEventId: string,
): boolean {
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
