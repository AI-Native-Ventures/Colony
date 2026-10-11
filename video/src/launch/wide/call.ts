/** The sales employee's call, an example for Bright Plumbing: ongoing work for a builder. */
export const CALL = {
  name: "Lindiwe",
  company: "Atlas Construction",
  lines: [
    {
      who: "us",
      text: "Hi Lindiwe, I'm calling for Bright Plumbing. We look after plumbing on building sites across Sandton.",
    },
    { who: "them", text: "We need someone reliable for our new site." },
  ],
  booked: "Meeting booked: Thu 10:00",
} as const;

export type CallTiming = {
  callIn: number;
  connectAt: number;
  bubble1At: number;
  bubble2At: number;
  bookedAt: number;
};

/** Call seconds on the timer: fast forward, so a two minute call fits the beat. */
const FAST_FORWARD = 50;

export function callSeconds(t: number, timing: CallTiming): number {
  return Math.max(0, Math.floor((t - timing.connectAt) * FAST_FORWARD));
}

export function callClock(t: number, timing: CallTiming): string {
  const s = callSeconds(t, timing);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
