import * as React from "react";

export type ElementSize = { width: number; height: number };

/**
 * Observe an element's rendered box. Returns null until the first measure so
 * callers can avoid guessing a fit for an unmeasured pane.
 */
export function useElementSize(
  ref: React.RefObject<HTMLElement | null>,
): ElementSize | null {
  const [size, setSize] = React.useState<ElementSize | null>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize((previous) =>
        previous &&
        previous.width === rect.width &&
        previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
