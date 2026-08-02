import type { CSSProperties } from "react";

/**
 * SalesTeams' discovery surfaces are light even when the surrounding Buzz
 * shell is dark. Keep the tokens in one place so Radix portals (sheets,
 * dialogs) render with the same surface instead of falling back to the shell.
 */
export const DISCOVERY_LIGHT_SURFACE_STYLE = {
  "--background": "220 15% 96%",
  "--foreground": "220 18% 5%",
  "--card": "0 0% 100%",
  "--card-foreground": "220 18% 5%",
  "--muted": "150 8% 94%",
  "--muted-foreground": "160 8% 43%",
  "--border": "142 10% 88%",
  "--input": "142 10% 88%",
  "--secondary": "150 8% 94%",
  "--secondary-foreground": "220 18% 5%",
  "--accent": "150 8% 94%",
  "--accent-foreground": "220 18% 5%",
  "--discovery-accent": "var(--sidebar-primary)",
  "--primary": "var(--foreground)",
  "--primary-foreground": "var(--background)",
  "--ring": "var(--foreground)",
} as CSSProperties;
