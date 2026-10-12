import { frameFor, projectBox } from "./camera.ts";
import { type Manifest, type ShotId, unionBox } from "./manifest.ts";
import { CAPTION_TOP, FRAME, toFrame, WINDOW } from "./stage.ts";
import type { TimedBeat } from "./timeline.ts";

/** The least zoom on anything the viewer reads: the app's 14 px text at 18 px or more. */
export const READ_ZOOM = 1.4;

/** How close to the view's edges and the captions a target may sit. */
const SAFE = 16;

/**
 * From `at` (0 to 1 through the beat), show `shot` with the camera on the
 * named boxes (or the whole window) at `zoom`, and click `click` if given.
 */
export type Move = {
  at: number;
  shot: ShotId;
  focus: readonly string[] | "window";
  zoom: number;
  click?: string;
};

export type UserBeat = TimedBeat & {
  kind: "title" | "app" | "end";
  moves: readonly Move[];
};

/**
 * "Start here", beat by beat: the spec's script (docs/superpowers/specs/
 * 2026-10-12-colony-user-videos-design.html) over the real app's screens.
 */
export const START_HERE: readonly UserBeat[] = [
  {
    id: "title",
    kind: "title",
    minSeconds: 4,
    moves: [],
    lines: [
      { id: "sh-intro", text: "Here's how to set up Colony, step by step." },
    ],
  },
  {
    id: "account",
    kind: "app",
    minSeconds: 8,
    lines: [
      { id: "sh-account-1", text: "First, create your account." },
      { id: "sh-account-2", text: "Add your name, your email and a password." },
    ],
    moves: [
      { at: 0, shot: "account-empty", focus: "window", zoom: 1 },
      { at: 0.22, shot: "account-empty", focus: ["name"], zoom: 1.7 },
      {
        at: 0.48,
        shot: "account",
        focus: ["name", "email", "password"],
        zoom: 1.5,
      },
      {
        at: 0.8,
        shot: "account",
        focus: ["name", "email", "password", "create"],
        zoom: 1.4,
        click: "create",
      },
    ],
  },
  {
    id: "recovery",
    kind: "app",
    minSeconds: 9,
    lines: [
      { id: "sh-recovery-1", text: "Colony gives you a recovery code." },
      {
        id: "sh-recovery-2",
        text: "If you forget your password, you'll need it to get back in.",
      },
      {
        id: "sh-recovery-3",
        text: "Colony can't recover it for you, so save it somewhere private.",
      },
    ],
    moves: [
      { at: 0, shot: "recovery", focus: "window", zoom: 1 },
      { at: 0.12, shot: "recovery", focus: ["code"], zoom: 1.9 },
      {
        at: 0.82,
        shot: "recovery",
        focus: ["code", "save"],
        zoom: 1.6,
        click: "save",
      },
    ],
  },
  {
    id: "business",
    kind: "app",
    minSeconds: 13,
    lines: [
      { id: "sh-business-1", text: "Next, tell Colony about your business." },
      {
        id: "sh-business-2",
        text: "Type its name and website, then press Read website.",
      },
      { id: "sh-business-3", text: "Colony writes a short summary." },
      {
        id: "sh-business-4",
        text: "Check it, and change anything that's wrong.",
      },
    ],
    moves: [
      { at: 0, shot: "business-empty", focus: "window", zoom: 1 },
      {
        at: 0.16,
        shot: "business-empty",
        focus: ["name", "website"],
        zoom: 1.6,
      },
      {
        at: 0.34,
        shot: "business-filled",
        focus: ["name", "website", "read"],
        zoom: 1.6,
        click: "read",
      },
      { at: 0.56, shot: "business-read", focus: ["summary"], zoom: 1.6 },
      {
        at: 0.86,
        shot: "business-read",
        focus: ["summary", "continue"],
        zoom: 1.4,
        click: "continue",
      },
    ],
  },
  {
    id: "power",
    kind: "app",
    minSeconds: 17,
    lines: [
      { id: "sh-power-1", text: "Now choose what powers your team." },
      {
        id: "sh-power-2",
        text: "With Colony Credits, you pay as you go and pick a model.",
      },
      {
        id: "sh-power-3",
        text: "Or use an account you already pay for: Claude Code or Codex, signed in on this computer.",
      },
      { id: "sh-power-4", text: "Then Colony checks that your agent replies." },
    ],
    moves: [
      {
        at: 0,
        shot: "power-credits",
        focus: ["subscriptions", "credits", "free"],
        zoom: 1.4,
      },
      {
        at: 0.16,
        shot: "power-credits",
        focus: ["credits"],
        zoom: 1.7,
        click: "credits",
      },
      {
        at: 0.42,
        shot: "power-subscriptions",
        focus: ["subscriptions", "list"],
        zoom: 1.4,
        click: "subscriptions",
      },
      {
        at: 0.72,
        shot: "power-test",
        focus: ["model", "test"],
        zoom: 1.5,
        click: "test",
      },
      {
        at: 0.86,
        shot: "power-replied",
        focus: ["replied", "continue"],
        zoom: 1.5,
      },
    ],
  },
  {
    id: "history",
    kind: "app",
    minSeconds: 8,
    lines: [
      {
        id: "sh-history-1",
        text: "If you've used other AI apps on this computer, Colony can learn from those chats.",
      },
      { id: "sh-history-2", text: "You choose what to keep, or skip it." },
    ],
    moves: [
      { at: 0, shot: "history", focus: "window", zoom: 1 },
      { at: 0.7, shot: "history", focus: ["skip"], zoom: 1.6, click: "skip" },
    ],
  },
  {
    id: "welcome",
    kind: "app",
    minSeconds: 13,
    lines: [
      {
        id: "sh-welcome-1",
        text: "Scout, your chief of staff, meets you in Welcome.",
      },
      { id: "sh-welcome-2", text: "Pick where to begin." },
      {
        id: "sh-welcome-3",
        text: "For a business you already run, choose Help with my existing business, and check the details.",
      },
    ],
    moves: [
      { at: 0, shot: "welcome-routes", focus: "window", zoom: 1 },
      {
        at: 0.14,
        shot: "welcome-routes",
        focus: ["question", "new", "existing", "deciding"],
        zoom: 1.4,
      },
      {
        at: 0.42,
        shot: "welcome-routes",
        focus: ["existing"],
        zoom: 1.8,
        click: "existing",
      },
      {
        at: 0.62,
        shot: "welcome-confirm",
        focus: ["details", "yes"],
        zoom: 1.4,
      },
      {
        at: 0.86,
        shot: "welcome-confirm",
        focus: ["yes"],
        zoom: 1.8,
        click: "yes",
      },
    ],
  },
  {
    id: "priority",
    kind: "app",
    minSeconds: 10,
    lines: [
      {
        id: "sh-priority-1",
        text: "Tell Scout what matters first, like getting more customers.",
      },
      { id: "sh-priority-2", text: "Scout writes down what it understood." },
      { id: "sh-priority-3", text: "You can edit every line." },
    ],
    moves: [
      {
        at: 0,
        shot: "welcome-priority",
        focus: ["customers", "delivery", "next", "other"],
        zoom: 1.5,
      },
      {
        at: 0.2,
        shot: "welcome-priority",
        focus: ["customers"],
        zoom: 1.8,
        click: "customers",
      },
      {
        at: 0.42,
        shot: "understanding",
        focus: ["nothingYet", "looksRight"],
        zoom: 1.5,
      },
      {
        at: 0.84,
        shot: "understanding",
        focus: ["looksRight"],
        zoom: 1.8,
        click: "looksRight",
      },
    ],
  },
  {
    id: "setup",
    kind: "app",
    minSeconds: 7.5,
    lines: [
      { id: "sh-setup-1", text: "Scout suggests the simplest setup." },
      { id: "sh-setup-2", text: "Nothing is created until you approve it." },
    ],
    moves: [
      { at: 0, shot: "setup", focus: ["keep", "approve"], zoom: 1.4 },
      {
        at: 0.7,
        shot: "setup",
        focus: ["approve"],
        zoom: 1.8,
        click: "approve",
      },
    ],
  },
  {
    id: "first-job",
    kind: "app",
    minSeconds: 15,
    lines: [
      {
        id: "sh-job-1",
        text: "Then Scout suggests a first job, like drafting five Instagram captions.",
      },
      {
        id: "sh-job-2",
        text: "Edit the brief if you like, and press Approve team and start.",
      },
      {
        id: "sh-job-3",
        text: "On Colony Credits, add credits first. Your brief stays where it is.",
      },
    ],
    moves: [
      {
        at: 0,
        shot: "first-job",
        focus: ["outputs", "brief", "start"],
        zoom: 1.4,
      },
      { at: 0.26, shot: "first-job", focus: ["outputs", "brief"], zoom: 1.5 },
      {
        at: 0.56,
        shot: "first-job",
        focus: ["start"],
        zoom: 1.8,
        click: "start",
      },
      { at: 0.72, shot: "first-job-started", focus: ["status"], zoom: 1.8 },
    ],
  },
  {
    id: "thread",
    kind: "app",
    minSeconds: 8,
    lines: [
      {
        id: "sh-thread-1",
        text: "Your team works in the job's thread, and everything comes back ready for your review.",
      },
    ],
    moves: [
      { at: 0, shot: "job-thread", focus: ["instruction"], zoom: 1.5 },
      { at: 0.4, shot: "job-thread", focus: ["drafts"], zoom: 1.6 },
    ],
  },
  {
    id: "end",
    kind: "end",
    minSeconds: 5,
    moves: [],
    lines: [{ id: "sh-end", text: "That's it. Your team is set up." }],
  },
];

/**
 * Everything the camera would get wrong on these shots, in plain words:
 * a target outside the view, or too close to it or to the captions.
 */
export function beatProblems(
  beats: readonly UserBeat[],
  manifest: Manifest,
): string[] {
  const problems: string[] = [];
  for (const beat of beats) {
    for (const move of beat.moves) {
      const shot = manifest.shots[move.shot];
      const named = move.focus === "window" ? [] : [...move.focus];
      const focus =
        move.focus === "window"
          ? WINDOW
          : toFrame(unionBox(named.map((name) => shot.boxes[name])));
      const cam = frameFor(focus, move.zoom);
      if (move.click) named.push(move.click);
      for (const name of named) {
        const box = projectBox(toFrame(shot.boxes[name]), cam);
        if (
          box.x < SAFE ||
          box.y < SAFE ||
          box.x + box.w > FRAME.w - SAFE ||
          box.y + box.h > CAPTION_TOP - SAFE
        )
          problems.push(
            `${beat.id}: "${name}" on ${move.shot} leaves the view at zoom ${move.zoom}`,
          );
      }
    }
  }
  return problems;
}
