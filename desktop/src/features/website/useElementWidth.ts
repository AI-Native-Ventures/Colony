import * as React from "react";

/**
 * Observe an element's rendered width. Returns null until the first measure so
 * callers can avoid guessing a fit for an unmeasured pane.
 */
export function useElementWidth(
  ref: React.RefObject<HTMLElement | null>,
): number | null {
  const [width, setWidth] = React.useState<number | null>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const measured = element.getBoundingClientRect().width;
      setWidth((previous) => (previous === measured ? previous : measured));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}
