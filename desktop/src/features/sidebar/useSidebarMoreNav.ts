// desktop/src/features/sidebar/useSidebarMoreNav.ts
import * as React from "react";

import { isBuzzTheme, useTheme } from "@/shared/theme/ThemeProvider";
import { isFreshFounderIdentity } from "@/features/onboarding/freshFounder";
import {
  readMoreNavOpen,
  rememberMoreNavOpened,
  shouldGroupMoreNav,
} from "./sidebarMoreNav";

/**
 * The "More" group's state. Colony themes always use the compact menu;
 * other themes retain the original fresh-founder rule.
 *
 * Both reads happen once per identity rather than on every render: the marker
 * and the open flag are localStorage, and neither changes while a founder is
 * looking at the sidebar. Opening is persisted immediately, so the group is
 * open on the next boot without waiting for anything else to be written.
 */
export function useSidebarMoreNav(
  pubkey: string | null | undefined,
): { isOpen: boolean; onToggle: () => void } | null {
  const { themeName } = useTheme();
  const grouped = React.useMemo(
    () =>
      isBuzzTheme(themeName) ||
      shouldGroupMoreNav({
        isFreshFounderIdentity: isFreshFounderIdentity(pubkey),
        pubkey,
      }),
    [pubkey, themeName],
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
