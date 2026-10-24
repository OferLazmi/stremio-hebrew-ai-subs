// SRT parse / serialize. Pure functions, no Workers APIs, so they unit-test under plain Node.

export interface Cue {
  /** Original index from the file (informational; output is renumbered 1..n). */
  index: number;
  /** Timing line exactly as in the source, e.g. "00:01:51,822 --> 00:01:53,790" (positions/styles kept). */
  timing: string;
  /** Text, lines joined with "\n". Tags (<i>, {\an8}, ...) kept verbatim. */
  text: string;
}

const TIMING_RE =
  /^\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})(.*)$/;

/** Normalise a timing line to canonical "HH:MM:SS,mmm --> HH:MM:SS,mmm[ extra]". */
function normTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(t)!;
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3]},${m[4].padEnd(3, "0")}`;
}

const CANON_TIMING_RE = /^\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}$/;
const isDigits = (l: string) => {
  const n = l.length;
  if (n === 0 || n > 9) return false;
  for (let k = 0; k < n; k++) {
    const ch = l.charCodeAt(k);
    if (ch < 48 || ch > 57) return false;
  }
  return true;
};

// Hot path: runs inside a 10 ms-CPU Workers Free invocation, so avoid a regex / trim() on every line.
export function parseSrt(input: string): Cue[] {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const lines = (s.indexOf("\r") >= 0 ? s.replace(/\r\n?/g, "\n") : s).split("\n");
  const cues: Cue[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0 || (line.length < 4 && line.trim() === "")) {
      i++;
      continue;
    }
    let index = cues.length + 1;
    let ti = i;
    if (i + 1 < n && lines[i + 1].indexOf("-->") >= 0 && isDigits(line.trim())) {
      index = parseInt(line, 10);
      ti = i + 1;
    }
    let timing: string;
    if (CANON_TIMING_RE.test(lines[ti])) {
      timing = lines[ti]; // fast path: already canonical
    } else {
      const tm = lines[ti].indexOf("-->") >= 0 ? TIMING_RE.exec(lines[ti]) : null;
      if (!tm) {
        i++; // garbage line that is not part of a cue
        continue;
      }
      timing = `${normTime(tm[1])} --> ${normTime(tm[2])}${tm[3] ? tm[3].replace(/\s+$/, "") : ""}`;
    }
    i = ti + 1;
    const start = i;
    while (i < n) {
      const l = lines[i];
      if (l.length === 0 || (l.length < 4 && l.trim() === "")) break;
      // new cue without a blank separator (broken files): numeric line followed by a timing line
      if (i + 1 < n && lines[i + 1].indexOf("-->") >= 0 && isDigits(l.trim())) break;
      i++;
    }
    const text = lines.slice(start, i).join("\n");
    cues.push({ index, timing, text: text.trimEnd() });
  }
  return cues;
}

export function serializeSrt(cues: Cue[]): string {
  return (
    cues.map((c, n) => `${n + 1}\n${c.timing}\n${c.text}`).join("\n\n") + (cues.length ? "\n" : "")
  );
}

/** A single-cue SRT used for errors / progress notices. Visible for the first ~3 hours. */
export function noticeSrt(text: string): string {
  return serializeSrt([{ index: 1, timing: "00:00:00,500 --> 03:00:00,000", text }]);
}
