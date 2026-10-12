import { EP07 } from "./ep07.ts";
import { PINNED } from "./phone.ts";

export { linesAt } from "./phone.ts";

/** "Waiting for you": the queue's rows, card pixels. */
export const QUEUE = { top: 196, step: 168, h: 148 } as const;

/** The owner taps the quote reply as it is introduced, and the draft pushes in. */
export const PUSH_AT = EP07.openAt + 0.25;
export const PUSH_SECONDS = 0.45;

/** The draft screen, card pixels: header, subject, the first draft, the note fixed above the button. */
export const DRAFT = {
  headerH: 124,
  subjectTop: 146,
  bodyTop: 214,
  noteTop: 598,
  noteH: 150,
} as const;

/** After the rewrite: the first draft made small, the rewrite under it, card pixels. */
export const AFTER = {
  beforeTop: 214,
  beforeH: 122,
  afterTop: 352,
  afterH: 226,
} as const;

/** The approved email's flight, frame pixels: from the pinned button up and off the right edge. */
export const PLANE = {
  from: { x: PINNED.x + PINNED.w / 2, y: PINNED.y + PINNED.h / 2 },
  to: { x: 1180, y: 300 },
} as const;
