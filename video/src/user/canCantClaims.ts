import type { ShotId } from "./manifest.ts";
import type { VoiceLine } from "./timeline.ts";

/**
 * One line of "What your AI team can and can't do": the words on screen, the
 * voice, the real screen beside it, and where the code says it is true.
 */
export type Claim = {
  id: string;
  kind: "can" | "cant" | "close";
  line: string;
  lines: readonly VoiceLine[];
  shot?: ShotId;
  /** The boxes whose outline is the part of the screen shown. */
  region?: readonly string[];
  /** The boxes pointed at inside that part; none shows the part as a whole. */
  focus?: readonly string[];
  proof: string;
  minSeconds: number;
};

export const CAN_CANT_TITLE: VoiceLine = {
  id: "cc-intro",
  text: "Here's what your AI team can and can't do.",
};

/** The spec's table (docs/superpowers/specs/2026-10-12-colony-user-videos-design.html), proofs on main. */
export const CAN_CANT: readonly Claim[] = [
  {
    id: "can-clients",
    kind: "can",
    line: "Find potential clients",
    lines: [
      {
        id: "cc-clients",
        text: "It can find potential clients, with notes on why each one may fit.",
      },
    ],
    shot: "find-clients",
    region: ["examples", "outputs", "brief"],
    focus: ["outputs"],
    proof:
      'desktop/src/features/onboarding/firstJobStarters.ts:29-34 ("do not contact anyone")',
    minSeconds: 5,
  },
  {
    id: "can-posts",
    kind: "can",
    line: "Draft your Instagram posts",
    lines: [
      {
        id: "cc-posts",
        text: "It can draft Instagram captions, each with a matching visual brief.",
      },
    ],
    shot: "first-job",
    region: ["examples", "outputs", "brief"],
    focus: ["outputs"],
    proof:
      'desktop/src/features/onboarding/firstJobStarters.ts:19-24 ("do not create images or publish posts")',
    minSeconds: 5,
  },
  {
    id: "can-emails",
    kind: "can",
    line: "Write your sales emails",
    lines: [
      {
        id: "cc-emails",
        text: "It can write sales emails, one card per email, for you to review.",
      },
    ],
    shot: "outreach-card",
    region: ["card"],
    proof: "crates/buzz-relay/src/core_blocks/composites/outreach-email.json",
    minSeconds: 5,
  },
  {
    id: "cant-send",
    kind: "cant",
    line: "Send an email without your yes",
    lines: [
      { id: "cc-send-1", text: "It can't send an email without your yes." },
      {
        id: "cc-send-2",
        text: "What you read on the card is exactly what goes out, from your own Gmail.",
      },
    ],
    shot: "outreach-card",
    region: ["card"],
    focus: ["approve"],
    proof:
      "desktop/src/shared/api/outreachSend.ts:22-25; crates/buzz-browser/src/mcp.rs:35-38 (sending is off for agents)",
    minSeconds: 7,
  },
  {
    id: "cant-closed",
    kind: "cant",
    line: "Send while Colony is closed",
    lines: [
      { id: "cc-closed", text: "It can't send emails while Colony is closed." },
    ],
    shot: "outreach-sent",
    region: ["card"],
    focus: ["from"],
    proof:
      "desktop/src/shared/api/outreachSend.ts:22 (the send runs in your open Gmail tab, in the app)",
    minSeconds: 4.5,
  },
  {
    id: "cant-hire",
    kind: "cant",
    line: "Hire anyone or start work on its own",
    lines: [
      {
        id: "cc-hire",
        text: "It can't hire anyone or start work until you approve.",
      },
    ],
    shot: "understanding",
    region: ["still", "nothingYet", "looksRight"],
    focus: ["nothingYet"],
    proof:
      "desktop/src/features/onboarding/channelOnboarding/UnderstandingStage.tsx:102, 253; ArrivalStage.tsx:41; FirstJobSuggestionView.tsx:366",
    minSeconds: 5,
  },
  {
    id: "cant-keep",
    kind: "cant",
    line: "Keep old chats you didn't choose",
    lines: [
      {
        id: "cc-keep",
        text: "From your old AI chats, it only keeps what you choose.",
      },
    ],
    shot: "history",
    region: ["dialog"],
    focus: ["choose"],
    proof:
      "desktop/src/features/onboarding/ui/new/screens/HistoryScreen.tsx:94-104 (only reviewed memories leave the computer)",
    minSeconds: 5,
  },
  {
    id: "close",
    kind: "close",
    line: "You stay in charge.",
    lines: [
      { id: "cc-close-1", text: "You stay in charge." },
      { id: "cc-close-2", text: "Nothing goes out without your yes." },
    ],
    proof: "the lines above (outreachSend.ts, UnderstandingStage.tsx)",
    minSeconds: 5,
  },
];
