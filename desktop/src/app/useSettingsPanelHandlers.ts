import * as React from "react";

import type { SettingsSection } from "@/features/settings/ui/SettingsPanels";

/**
 * Opening, closing, and moving around inside settings.
 *
 * The three handlers travel together because they share one invariant:
 * settings occupies a single history entry. Opening pushes it, section
 * changes replace it, and closing pops it, so Back always leaves settings
 * in one step no matter how many sections the user visited. Split apart,
 * that rule lives nowhere.
 */
export function useSettingsPanelHandlers({
  closeSettings,
  defaultSection,
  goSettings,
  onOpen,
}: {
  closeSettings: () => void;
  defaultSection: SettingsSection;
  goSettings: (
    section: SettingsSection,
    options?: { replace?: boolean },
  ) => unknown;
  /** Runs before settings opens, to dismiss whatever it covers. */
  onOpen: () => void;
}) {
  const handleOpenSettings = React.useCallback(
    (section: SettingsSection = defaultSection) => {
      onOpen();
      void goSettings(section);
    },
    [defaultSection, goSettings, onOpen],
  );

  const handleCloseSettings = React.useCallback(
    () => closeSettings(),
    [closeSettings],
  );

  const handleSettingsSectionChange = React.useCallback(
    (section: SettingsSection) => {
      void goSettings(section, { replace: true });
    },
    [goSettings],
  );

  return {
    handleCloseSettings,
    handleOpenSettings,
    handleSettingsSectionChange,
  };
}
