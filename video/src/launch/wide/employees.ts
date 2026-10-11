import { hslToRgb } from "../math.ts";

/** The four AI employees, in the order the film meets them. */
export const TEAM = ["blue", "amber", "pink", "green"] as const;
export type EmployeeId = (typeof TEAM)[number];

export type Tone = {
  /** The employee's hue, e.g. "hsl(217 91% 60%)". */
  color: string;
  /** A darker shade for small text on a tint of the hue. */
  deep: string;
  /** The hue as rgb() for canvas drawing. */
  rgb: string;
};

function tone(h: number, s: number, l: number, deep: string): Tone {
  const [r, g, b] = hslToRgb(h, s, l);
  return { color: `hsl(${h} ${s}% ${l}%)`, deep, rgb: `rgb(${r} ${g} ${b})` };
}

export const TONES: Record<EmployeeId, Tone> = {
  blue: tone(217, 91, 60, "hsl(217 80% 44%)"),
  amber: tone(38, 92, 50, "hsl(30 90% 32%)"),
  pink: tone(330, 81, 60, "hsl(330 70% 40%)"),
  green: tone(160, 60, 45, "hsl(160 64% 26%)"),
};

export type HeroLook = Tone & {
  title: readonly [string, string];
  subline: string;
};

/** What each employee is called on screen: the job in two big lines, one plain sentence. */
export const LOOKS: Record<EmployeeId, HeroLook> = {
  blue: {
    ...TONES.blue,
    title: ["Finds", "customers."],
    subline: "Finds businesses near you that need what you sell.",
  },
  amber: {
    ...TONES.amber,
    title: ["Writes", "your emails."],
    subline: "Writes to each new customer, in your words.",
  },
  pink: {
    ...TONES.pink,
    title: ["Makes", "your posts."],
    subline: "Makes Instagram posts that look like your business.",
  },
  green: {
    ...TONES.green,
    title: ["Keeps your", "site fresh."],
    subline: "Updates your website whenever your business changes.",
  },
};
