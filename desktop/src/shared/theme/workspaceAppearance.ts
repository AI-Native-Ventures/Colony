import { hexToHsl } from "./adaptive-theme";

/** The static background treatments offered in Colony Appearance. */
export type WorkspaceGradientPattern = "soft-mesh" | "diagonal-wash" | "halo";

export const WORKSPACE_GRADIENT_STORAGE_KEY = "buzz-workspace-gradient";
export const WORKSPACE_GRADIENT_PATTERNS = [
  { value: "soft-mesh", label: "Soft mesh" },
  { value: "diagonal-wash", label: "Diagonal wash" },
  { value: "halo", label: "Halo" },
] as const;

/** Old records and unknown future patterns retain a usable appearance. */
export function parseWorkspaceGradientPattern(
  value: unknown,
): WorkspaceGradientPattern {
  return value === "diagonal-wash" || value === "halo" ? value : "soft-mesh";
}

type WorkspacePalette = {
  chromeStart: string;
  chromeMiddle: string;
  chromeEnd: string;
  content: string;
  raised: string;
  muted: string;
  border: string;
  foreground: string;
  mutedForeground: string;
};

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return `#${[r, g, b]
    .map((channel) =>
      Math.round((channel + m) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** One accent supplies the chrome and quieter, opaque reading surfaces. */
export function deriveWorkspaceAppearance(accent: string): {
  light: WorkspacePalette;
  dark: WorkspacePalette;
} {
  const hsl = hexToHsl(/^#[a-f\d]{6}$/i.test(accent) ? accent : "#808080");
  const [hue, saturation] = hsl.split(" ").map(Number.parseFloat);
  const chroma = Math.min(saturation / 75, 1);
  // Pink/amber and green/blue are the brand's warm and cool families;
  // the remaining hues pair with a neighbouring cooler hue.
  const companion =
    hue >= 290 || hue < 45 ? 32 : hue >= 90 && hue <= 180 ? 210 : hue - 40;
  const tint = (h: number, s: number, l: number) => hslToHex(h, s * chroma, l);
  return {
    light: {
      chromeStart: tint(hue, 75, 82),
      chromeMiddle: tint(companion, 80, 88),
      chromeEnd: tint(hue + 14, 65, 91),
      content: tint(hue, 44, 97),
      raised: tint(hue, 32, 99),
      muted: tint(hue, 32, 93),
      border: tint(hue, 24, 83),
      foreground: tint(hue, 18, 15),
      mutedForeground: tint(hue, 12, 32),
    },
    dark: {
      chromeStart: tint(hue, 36, 22),
      chromeMiddle: tint(companion, 45, 17),
      chromeEnd: tint(hue + 14, 28, 12),
      content: tint(hue, 22, 12),
      raised: tint(hue, 22, 15),
      muted: tint(hue, 17, 18),
      border: tint(hue, 17, 27),
      foreground: tint(hue, 18, 94),
      mutedForeground: tint(hue, 14, 72),
    },
  };
}

/** Shared by the native app surface and its Appearance previews. */
export function workspaceGradientCss(
  pattern: WorkspaceGradientPattern,
  palette: WorkspacePalette,
  translucent = false,
): string {
  const colour = (value: string) =>
    translucent
      ? `color-mix(in srgb, ${value} var(--buzz-translucency-gradient-alpha, 65%), transparent)`
      : value;
  const start = colour(palette.chromeStart);
  const middle = colour(palette.chromeMiddle);
  const end = colour(palette.chromeEnd);
  if (pattern === "diagonal-wash") {
    return `linear-gradient(130deg, ${start} 0%, ${middle} 48%, ${end} 100%)`;
  }
  if (pattern === "halo") {
    return `radial-gradient(ellipse at 35% 30%, ${middle} 0%, ${start} 38%, ${end} 80%)`;
  }
  return `radial-gradient(ellipse at 0% 0%, ${start} 0%, transparent 65%), radial-gradient(ellipse at 100% 20%, ${middle} 0%, transparent 70%), linear-gradient(160deg, ${end}, ${start})`;
}

/** Apply semantic tokens without changing a user's selected base theme. */
export function applyWorkspaceAppearance(
  root: HTMLElement,
  accent: string,
  pattern: WorkspaceGradientPattern,
): void {
  const palettes = deriveWorkspaceAppearance(accent);
  root.dataset.workspaceGradient = pattern;
  for (const mode of ["light", "dark"] as const) {
    const palette = palettes[mode];
    root.style.setProperty(`--buzz-gradient-${mode}-top`, palette.chromeStart);
    root.style.setProperty(`--buzz-gradient-${mode}-bottom`, palette.chromeEnd);
    root.style.setProperty(
      `--buzz-workspace-gradient-${mode}`,
      workspaceGradientCss(pattern, palette),
    );
    root.style.setProperty(
      `--buzz-workspace-glass-${mode}`,
      workspaceGradientCss(pattern, palette, true),
    );
    root.style.setProperty(
      `--buzz-workspace-reading-${mode}`,
      workspaceGradientCss(pattern, {
        ...palette,
        chromeStart: palette.raised,
        chromeMiddle: palette.content,
        chromeEnd: palette.muted,
      }),
    );
    for (const key of [
      "content",
      "raised",
      "muted",
      "border",
      "foreground",
      "mutedForeground",
    ] as const) {
      const name = key === "mutedForeground" ? "muted-foreground" : key;
      root.style.setProperty(
        `--buzz-workspace-${mode}-${name}`,
        hexToHsl(palette[key]),
      );
    }
  }
}
