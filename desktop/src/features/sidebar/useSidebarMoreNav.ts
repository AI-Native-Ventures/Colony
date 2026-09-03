// desktop/src/features/sidebar/useSidebarMoreNav.ts
import * as React from "react";

import { isFreshFounderIdentity } from "@/features/onboarding/freshFounder";
import {
  readMoreNavOpen,
  rememberMoreNavOpened,
  shouldGroupMoreNav,
} from "./sidebarMoreNav";

/**
 * The "More" group's state, or null when this identity does not get one.
 *
 * Both reads happen once per identity rather than on every render: the marker
 * and the open flag are localStorage, and neither changes while a founder is
 * looking at the sidebar. Opening is persisted immediately, so the group is
 * open on the next boot without waiting for anything else to be written.
 */
export function useSidebarMoreNav(
  pubkey: string | null | undefined,
): { isOpen: boolean; onToggle: () => void } | null {
  const grouped = React.useMemo(
    () =>
      shouldGroupMoreNav({
        isFreshFounderIdentity: isFreshFounderIdentity(pubkey),
        pubkey,
      }),
    [pubkey],
  );
  const [isOpen, setIsOpen] = React.useState(() => readMoreNavOpen(pubkey));
  React.useEffect(() => {
    setIsOpen(readMoreNavOpen(pubkey));
  }, [pubkey]);

  const onToggle = React.useCallback(() => {
    setIsOpen((current) => {
      if (!current) rememberMoreNavOpened(pubkey);
      return !current;
    });
  }, [pubkey]);

  return grouped ? { isOpen, onToggle } : null;
}
