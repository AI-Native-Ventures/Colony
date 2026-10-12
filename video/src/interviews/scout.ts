import type { InterviewScript } from "./plan.ts";

/**
 * Job interview, episode 1: Scout, the chief of staff. The owner approved
 * this script on 2026-10-12. Voice: Gemini, interviewer Charon, Scout Aoede,
 * one line per read (public/interviews/voice/SOURCES.md); `seconds` is each
 * file's length.
 */
export const SCOUT_INTERVIEW: InterviewScript = {
  name: "Scout",
  role: "Chief of staff",
  lines: [
    {
      id: "iv1-q1",
      speaker: "you",
      text: "So, what would you do here?",
      file: "interviews/voice/iv1-q1.mp3",
      seconds: 1.976,
    },
    {
      id: "iv1-a1",
      speaker: "scout",
      text: "Plan the work and hand out the jobs.",
      file: "interviews/voice/iv1-a1.mp3",
      seconds: 1.993,
    },
    {
      id: "iv1-q2",
      speaker: "you",
      text: "Biggest weakness?",
      file: "interviews/voice/iv1-q2.mp3",
      seconds: 1.059,
    },
    {
      id: "iv1-a2",
      speaker: "scout",
      text: "I can't send anything without your yes.",
      file: "interviews/voice/iv1-a2.mp3",
      seconds: 2.404,
    },
    {
      id: "iv1-q3",
      speaker: "you",
      text: "When can you start?",
      file: "interviews/voice/iv1-q3.mp3",
      seconds: 1.058,
    },
    {
      id: "iv1-a3",
      speaker: "scout",
      text: "As soon as you say yes.",
      file: "interviews/voice/iv1-a3.mp3",
      seconds: 1.651,
    },
    {
      id: "iv1-q4",
      speaker: "you",
      text: "You're hired.",
      file: "interviews/voice/iv1-q4.mp3",
      seconds: 0.719,
    },
  ],
};
