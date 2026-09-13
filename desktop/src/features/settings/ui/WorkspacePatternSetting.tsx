import { Check } from "lucide-react";
import { useTheme } from "@/shared/theme/ThemeProvider";
import {
  WORKSPACE_GRADIENT_PATTERNS,
  deriveWorkspaceAppearance,
  workspaceGradientCss,
} from "@/shared/theme/workspaceAppearance";
import { SettingsOptionRow } from "./SettingsOptionGroup";

/** The same static gradients used by the workspace, selectable in Appearance. */
export function WorkspacePatternSetting() {
  const {
    accentColor,
    gradientPattern,
    customGradient,
    isDark,
    setGradientPattern,
  } = useTheme();
  const palette = deriveWorkspaceAppearance(accentColor, customGradient)[
    isDark ? "dark" : "light"
  ];
  return (
    <SettingsOptionRow
      className="items-start"
      data-testid="workspace-pattern-row"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">Workspace background</p>
        <p
          className="text-sm font-normal text-muted-foreground"
          data-settings-subcopy
        >
          Colour around your workspace, with quieter surfaces for reading.
        </p>
      </div>
      <fieldset className="grid w-full min-w-0 max-w-sm grid-cols-3 gap-2">
        <legend className="sr-only">Workspace background patterns</legend>
        {WORKSPACE_GRADIENT_PATTERNS.map(({ value, label }) => (
          <button
            aria-label={`Use ${label} background`}
            aria-pressed={gradientPattern === value}
            className="group min-w-0 rounded-lg border border-border bg-card p-1 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`workspace-pattern-${value}`}
            key={value}
            onClick={() => setGradientPattern(value)}
            type="button"
          >
            <span
              aria-hidden="true"
              className="relative block h-16 overflow-hidden rounded-md"
              style={{ backgroundImage: workspaceGradientCss(value, palette) }}
            >
              <span
                className="absolute inset-y-2 left-1/3 right-2 rounded border"
                style={{
                  backgroundColor: palette.content,
                  borderColor: palette.border,
                }}
              />
              {gradientPattern === value ? (
                <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background">
                  <Check className="h-3 w-3" />
                </span>
              ) : null}
            </span>
            <span className="block px-1 py-2">{label}</span>
          </button>
        ))}
      </fieldset>
    </SettingsOptionRow>
  );
}
