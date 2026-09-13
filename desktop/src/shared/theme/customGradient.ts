/** User-selected gradient colors; disabled retains the pair for next time. */
export type CustomGradient = {
  enabled: boolean;
  color1: string;
  color2: string;
};

export const CUSTOM_GRADIENT_STORAGE_KEY = "buzz-custom-gradient.v1";
export const DEFAULT_CUSTOM_GRADIENT: CustomGradient = Object.freeze({
  enabled: false,
  color1: "#895AF6",
  color2: "#5A9CF6",
});

/** Validate local and synced values before using them as CSS colors. */
export function parseCustomGradient(value: unknown): CustomGradient | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.color1 !== "string" ||
    typeof candidate.color2 !== "string" ||
    !/^#[0-9a-f]{6}$/i.test(candidate.color1) ||
    !/^#[0-9a-f]{6}$/i.test(candidate.color2)
  )
    return null;
  return {
    enabled: candidate.enabled,
    color1: candidate.color1,
    color2: candidate.color2,
  };
}

function tint(color: string, background: number, amount: number): string {
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(
        Number.parseInt(color.slice(offset, offset + 2), 16) * amount +
          background * (1 - amount),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Keep the existing dark/light chrome legible for any selected color pair. */
export function customGradientStops(gradient: CustomGradient) {
  if (!gradient.enabled) return null;
  return {
    lightTop: tint(gradient.color1, 255, 0.26),
    lightBottom: tint(gradient.color2, 255, 0.26),
    darkTop: tint(gradient.color1, 0, 0.25),
    darkBottom: tint(gradient.color2, 0, 0.25),
  };
}
