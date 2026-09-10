import { z } from "zod";

export const t1Schema = z.object({
  hook: z.string(),
  hue: z.enum(["violet", "blue", "pink", "amber", "green"]),
  lines: z.array(
    z.object({
      who: z.enum(["owner", "scout"]),
      text: z.string(),
    }),
  ),
  results: z.array(
    z.object({
      name: z.string(),
      detail: z.string(),
    }),
  ),
  approval: z.object({
    question: z.string(),
    fine: z.string(),
  }),
  endCard: z.object({
    title: z.string(),
    url: z.string(),
  }),
});

export type T1Props = z.infer<typeof t1Schema>;
