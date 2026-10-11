export type TypewriterOptions = {
  start: number;
  /** Characters per second. */
  cps: number;
  /** Seconds the carriage takes to return to the next line. */
  returnSeconds: number;
};

export type TypewriterState = {
  typed: string[];
  /** The line being typed, or the line just finished while returning. */
  line: number;
  /** 0 while typing; 0 to 1 while the carriage returns to the next line. */
  returning: number;
  done: boolean;
};

/** When the last character of the last line is typed. */
export function typewriterEnd(lines: string[], o: TypewriterOptions): number {
  let clock = o.start;
  lines.forEach((text, i) => {
    clock += text.length / o.cps;
    if (i < lines.length - 1) clock += o.returnSeconds;
  });
  return clock;
}

/** What is on the page at `t`: lines typed one after another, with a carriage return between them. */
export function typewriterAt(
  lines: string[],
  t: number,
  o: TypewriterOptions,
): TypewriterState {
  const typed = lines.map(() => "");
  let clock = o.start;
  for (let i = 0; i < lines.length; i++) {
    const typeTime = lines[i].length / o.cps;
    if (t < clock + typeTime) {
      const count = t <= clock ? 0 : Math.floor((t - clock) * o.cps);
      typed[i] = lines[i].slice(0, count);
      return { typed, line: i, returning: 0, done: false };
    }
    typed[i] = lines[i];
    clock += typeTime;
    if (i < lines.length - 1) {
      if (t < clock + o.returnSeconds) {
        return {
          typed,
          line: i,
          returning: (t - clock) / o.returnSeconds,
          done: false,
        };
      }
      clock += o.returnSeconds;
    }
  }
  return { typed, line: lines.length - 1, returning: 0, done: true };
}
