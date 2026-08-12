import 'package:flutter/material.dart';

import 'accent_colors.dart';
import 'app_colors.dart';

/// Name of the first-party Colony theme. Colony reuses the GitHub Light palette
/// for every base color; the one thing that sets it apart is a branded gradient
/// painted across the app's top section. Mirrors desktop, where the same
/// gradient fills the sidebar canvas. Desktop still spells the attribute
/// `data-buzz-sidebar` in `desktop/src/shared/styles/globals/theme.css`, so
/// that is the name to grep for over there.
const colonyThemeName = 'colony';

/// Name of the dark counterpart, which reuses the GitHub Dark palette and the
/// dark-tuned gradient stops. Paired with [colonyThemeName] in `themePairs`, so
/// the two behave as a single "Colony" choice under System mode.
const colonyDarkThemeName = 'colony-dark';

/// Whether [themeName] is either half of the Colony pair. Both halves enable the
/// gradient so System mode keeps it on across an OS light/dark switch.
bool isColonyTheme(String themeName) =>
    themeName == colonyThemeName || themeName == colonyDarkThemeName;

/// Whether the current widget tree is using the first-party Colony treatment.
bool isColonyThemeContext(BuildContext context) =>
    Theme.of(context).extension<AppColors>()?.topSectionGradient != null;

/// Primary foreground for the mobile top navigation.
///
/// Every theme uses its own [ColorScheme.onSurface]. Colony is the exception:
/// its desktop-matching top gradient needs a neutral black or white foreground
/// rather than the accent-derived color scheme foreground.
Color navigationPrimaryForeground(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  if (!isColonyThemeContext(context)) return scheme.onSurface;
  return scheme.brightness == Brightness.dark ? Colors.white : Colors.black;
}

/// Secondary label and placeholder foreground for the mobile top navigation.
Color navigationSecondaryForeground(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  if (!isColonyThemeContext(context)) return scheme.onSurfaceVariant;
  return navigationPrimaryForeground(context).withValues(alpha: 0.4);
}

/// Channel-section label and icon foreground for the mobile side navigation.
///
/// Section labels need more hierarchy than a placeholder. Colony therefore
/// uses a stronger neutral over its gradient, while all other themes preserve
/// their established secondary foreground token.
Color navigationSectionForeground(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  if (!isColonyThemeContext(context)) return scheme.onSurfaceVariant;
  return navigationPrimaryForeground(context).withValues(alpha: 0.8);
}

/// Search-field surface for the mobile top navigation.
Color navigationSearchSurface(BuildContext context) {
  final scheme = Theme.of(context).colorScheme;
  if (!isColonyThemeContext(context)) return scheme.surfaceContainerHighest;
  return navigationPrimaryForeground(context).withValues(alpha: 0.04);
}

/// A low-contrast navigation divider derived from the active theme foreground.
Color navigationDivider(BuildContext context, double opacity) =>
    navigationPrimaryForeground(context).withValues(alpha: opacity);

/// Colony renders with its fixed neutral foreground while preserving the
/// stored wire accent so the user's choice returns on another theme.
int effectiveAccentIndex(String themeName, String storedAccent) {
  if (isColonyTheme(themeName)) return neutralAccentIndex;
  return accentIndexForWireValue(storedAccent) ?? defaultAccentIndex;
}

/// Gradient stops, matching desktop's `--buzz-gradient-*` custom properties.
/// Desktop has not renamed those properties, so the reference is deliberate.
///
/// Derived from the brand violet `hsl(258 90% 66%)` so the app's dominant
/// surface matches the mark and the marketing site. The top stops carry the
/// hue; the bottom stops are unchanged, because the gradient's job is to fade
/// the brand color out into the neutral canvas, not to tint the whole screen.
/// All four clear WCAG AAA against their respective body text.
const _lightTop = Color(0xFFD9CDF3);
const _lightBottom = Color(0xFFC4D0DA);
const _darkTop = Color(0xFF2A1E48);
const _darkBottom = Color(0xFF0A1423);

/// The Colony gradient for the app's top section, or null when [themeName] is
/// not a Colony theme, in which case the section keeps its default frosted fill.
///
/// The stops are fully opaque: under Colony the color replaces the frosted
/// treatment rather than tinting it, matching desktop's solid sidebar canvas.
///
/// [brightness] comes from the applied color scheme rather than the theme name,
/// so System mode picks the right stops as the OS switches.
LinearGradient? colonyTopSectionGradient(
  String themeName,
  Brightness brightness,
) {
  if (!isColonyTheme(themeName)) return null;

  final isDark = brightness == Brightness.dark;
  return LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [
      isDark ? _darkTop : _lightTop,
      isDark ? _darkBottom : _lightBottom,
    ],
  );
}
