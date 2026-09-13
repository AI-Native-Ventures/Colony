import * as React from "react";

/**
 * Selectors that mean "an overlay is above app content": Radix dialogs,
 * open menus, and popper-positioned popovers/tooltips. Mirrors the existing
 * ElectronWebBody native-view occluder so menus and tooltips stay visible
 * above the native preview instead of being painted over.
 */
export const WEBSITE_OCCLUSION_SELECTOR =
  '[role="dialog"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]';

/**
 * Pure detection helper.
 *
 * A hidden document occludes everything. `exempt` is the surface's own dialog
 * node and only that exact node escapes the check: a nested menu or popover
 * inside the expanded dialog is still an overlay and still hides native
 * content, because it paints above the dialog too.
 */
export function isSurfaceOccluded(exempt?: Element | null): boolean {
  if (typeof document === "undefined") return false;
  if (document.hidden || document.visibilityState === "hidden") return true;
  const overlays = document.querySelectorAll(WEBSITE_OCCLUSION_SELECTOR);
  for (const overlay of overlays) {
    if (exempt && overlay === exempt) continue;
    return true;
  }
  return false;
}

/**
 * Track whether any app overlay covers the native preview surface. Watches
 * DOM mutations (dialogs and popovers mount/unmount and flip `data-state`),
 * document visibility, and window resizes. The mutation observer is the same
 * approach the existing native browser surface uses.
 */
export function useSurfaceOcclusion(options?: {
  /**
   * The surface's own dialog node, exempt from its own occlusion check. Every
   * other dialog, menu, and popover still detaches the native view.
   */
  exemptRef?: React.RefObject<HTMLElement | null>;
}): boolean {
  const exemptRef = options?.exemptRef;
  const [occluded, setOccluded] = React.useState(() =>
    isSurfaceOccluded(exemptRef?.current ?? null),
  );

  React.useEffect(() => {
    const update = () =>
      setOccluded(isSurfaceOccluded(exemptRef?.current ?? null));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-state", "role"],
    });
    document.addEventListener("visibilitychange", update);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("resize", update);
    };
  }, [exemptRef]);

  return occluded;
}
