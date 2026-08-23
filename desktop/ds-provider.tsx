// Provider wrapper for /design-sync preview cards and for designs built with
// the Colony bundle. Not part of the app build.
//
// Two things have to be true before any Colony component renders outside the
// Tauri shell:
//
//   1. A NativeBridge must be installed. Several modules read isTauri() during
//      render, and getNativeBridge() throws when nothing is installed. That
//      throw happens inside React's concurrent render, so it surfaces as a
//      silently empty root rather than as an error.
//   2. The theme context must exist. DialogOverlay and SheetOverlay call
//      useTheme() to pick their backdrop tint.
//
// (2) is satisfied with a fixed context value rather than the real
// ThemeProvider on purpose. The real provider rewrites the theme custom
// properties on :root at runtime, which replaces the Colony palette that
// styles.css ships with a generic one, so cards rendered under it stop
// matching what a design built on this bundle actually looks like.
import type { ReactNode } from "react";
import { type NativeBridge, setNativeBridge } from "@/shared/api/nativeBridge";
import {
  ThemeContext,
  type ThemeContextValue,
} from "@/shared/theme/ThemeProvider";

const noop = async () => undefined;
const unlisten = async () => () => {};

// Web-only stub: every command resolves to undefined, every subscription hands
// back an unlisten that does nothing, and isTauri() is false so feature code
// takes its non-native path.
const webBridge = new Proxy({} as NativeBridge, {
  get(_target, prop) {
    switch (prop) {
      case "isTauri":
        return () => false;
      case "windowLabel":
        return () => "main";
      case "listen":
      case "onWindowThemeChanged":
      case "onWindowResized":
      case "onNotificationAction":
        return unlisten;
      case "getVersion":
        return async () => "0.0.0";
      case "homeDir":
        return async () => "/";
      case "isFullscreen":
      case "notificationPermissionGranted":
        return async () => false;
      case "checkForUpdate":
        return async () => null;
      default:
        return noop;
    }
  },
});

setNativeBridge(webBridge);

const staticTheme: ThemeContextValue = {
  themeName: "buzz",
  selectedThemeName: "buzz",
  isDark: false,
  isLoading: false,
  accentColor: "neutral",
  followSystem: false,
  glassBackground: false,
  glassOpacity: 65,
  glassBackgroundSupported: false,
  prominentActiveTab: false,
  hasPair: true,
  terminalPalette: null,
  setTheme: () => {},
  setAccentColor: () => {},
  setFollowSystem: () => {},
  applyAppearance: () => {},
  setGlassBackground: () => {},
  setGlassOpacity: () => {},
  setProminentActiveTab: () => {},
};

/**
 * Wraps children in the Colony theme context. Every Colony surface should be
 * mounted inside this, overlays read the resolved theme from it. Colors come
 * from styles.css; this only supplies the context those components read.
 */
export function ColonyProvider({ children }: { children?: ReactNode }) {
  return (
    <ThemeContext.Provider value={staticTheme}>
      {children}
    </ThemeContext.Provider>
  );
}
