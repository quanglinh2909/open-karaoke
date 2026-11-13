import type { Line } from "./lrc";

/*
 * Parts of a recording (seconds) chosen by lyric line: where the original
 * singer sings, where the automatic harmony plays.
 */

/** Lines closer than this (seconds) join into one part, so it doesn't cut out between them. */
const JOIN = 1.0;
/** A part starts a little before a line's first word and lasts a little past its last. */
const LEAD_IN = 0.15;
const TAIL = 0.25;

/** A line's sung span in the recording (seconds). */
export function span(l: Line, offset: number): [number, number] {
  const a = l.words[0]?.start ?? l.start;
  const b = l.words.at(-1)?.end ?? l.end;
  return [a + offset, Math.max(b, a) + offset];
}

/** Stop this far (seconds) before the words of a line that isn't chosen. */
const CLEAR = 0.05;

/** A part: its span (seconds) and the lines it covers. */
export interface Segment {
  from: number;
  to: number;
  first: number;
  last: number;
  /** Where the lines around it (that aren't chosen) start and end: past these the part reaches into them. */
  limitFrom: number;
  limitTo: number;
}

/**
 * The original singer's part as the audio takes it: `[start, fullFrom,
 * fullTo, end]`. Between `fullFrom` and `fullTo` the singer plays in full;
 * where an adjusted edge reaches into a line the user sings (a duet's
 * overlap), only the singer's sung pitch is kept there.
 */
export type LeadPart = [number, number, number, number, number, number];

/** What to do where a part reaches into the user's line: keep its own singer, the female or male voice, or not filter. */
export type LapMode = "auto" | "female" | "male" | "none";
/** A part's overlap choices (start edge, end edge), by `segKey`. */
export type Laps = Record<string, [LapMode, LapMode]>;
const VOICE: Record<LapMode, number> = { auto: 0, female: 1, male: 2, none: 0 };

/** A part's key for its hand adjustment: the lines it covers. */
export const segKey = (s: Segment) => `${s.first}-${s.last}`;

/** Hand adjustments: seconds added to a part's start and end, by `segKey`. */
export type Adjust = Record<string, [number, number]>;

/**
 * The chosen lines as parts of the recording, neighbours joined. The lead-in
 * and tail only use free time: a part never reaches into the words of a line
 * that isn't chosen (rap lines follow each other closely, so a fixed tail
 * let the original singer spill into the next line).
 */
export function toSegments(lines: Line[], chosen: Set<number>, offset: number): Segment[] {
  const segs: Segment[] = [];
  for (const i of [...chosen].sort((x, y) => x - y)) {
    if (!lines[i]) continue;
    const [a, b] = span(lines[i], offset);
    const prevEnd = i > 0 && !chosen.has(i - 1) ? span(lines[i - 1], offset)[1] + CLEAR : -Infinity;
    const nextStart = i + 1 < lines.length && !chosen.has(i + 1) ? span(lines[i + 1], offset)[0] - CLEAR : Infinity;
    // Never into a line the user sings, even if that clips this line's own
    // first or last word a little (aligned onsets can come late).
    const from = Math.max(0, a - LEAD_IN, prevEnd);
    const to = Math.min(b + TAIL, nextStart);
    if (to <= from) continue;
    const last = segs.at(-1);
    if (last && chosen.has(i - 1) && from - last.to < JOIN) {
      last.to = Math.max(last.to, to);
      last.last = i;
      last.limitTo = nextStart;
    } else segs.push({ from, to, first: i, last: i, limitFrom: prevEnd, limitTo: nextStart });
  }
  return segs;
}

/** Parts as sent to the audio: segments with their hand adjustments. */
export function applyAdjust(segs: Segment[], adjust: Adjust | undefined): [number, number][] {
  return segs
    .map((s): [number, number] => {
      const [da, db] = adjust?.[segKey(s)] ?? [0, 0];
      return [Math.max(0, s.from + da), s.to + db];
    })
    .filter(([a, b]) => b - a > 0.05);
}

/** The original singer's parts with their full and sung-only stretches (see `LeadPart`). */
export function leadParts(segs: Segment[], adjust: Adjust | undefined, laps?: Laps): LeadPart[] {
  return segs
    .map((s): LeadPart => {
      const [da, db] = adjust?.[segKey(s)] ?? [0, 0];
      const [ma, mb] = laps?.[segKey(s)] ?? ["auto", "auto"];
      const [a, b] = [Math.max(0, s.from + da), s.to + db];
      // "Not filtered": the overlap plays as the rest of the part does.
      const fullFrom = ma === "none" ? a : Math.min(Math.max(a, s.limitFrom), b);
      const fullTo = mb === "none" ? b : Math.max(Math.min(b, s.limitTo), fullFrom);
      return [a, fullFrom, fullTo, b, VOICE[ma], VOICE[mb]];
    })
    .filter(([a, , , b]) => b - a > 0.05);
}

export function toParts(lines: Line[], chosen: Set<number>, offset: number): [number, number][] {
  return applyAdjust(toSegments(lines, chosen, offset), undefined);
}

/** Lines whose middle falls in one of `parts`. */
export function fromParts(lines: Line[], parts: [number, number][], offset: number, slack = 0.4): Set<number> {
  const set = new Set<number>();
  lines.forEach((l, i) => {
    const [a, b] = span(l, offset);
    const mid = (a + b) / 2;
    if (parts.some(([x, y]) => mid >= x - slack && mid <= y + slack)) set.add(i);
  });
  return set;
}


/** Saved parts redrawn around the lines they cover, by the current rules and timing (as segments). */
export function savedSegments(lines: Line[], parts: [number, number][], offset: number): Segment[] {
  if (!parts.length || !lines.length) return [];
  // The lines a saved part covers: those whose middle is in it, give or take
  // the hand adjustment (which may have trimmed into a line's edge).
  return toSegments(lines, fromParts(lines, parts, offset, 0.4), offset);
}

/** Saved parts redrawn by the current rules, hand adjustments kept. */
export function normalizeParts(lines: Line[], parts: [number, number][], offset: number, adjust?: Adjust): [number, number][] {
  if (!parts.length || !lines.length) return parts;
  return applyAdjust(savedSegments(lines, parts, offset), adjust);
}

/** Who sings a line of a duet, shown on the lyrics so each singer knows their lines. */
export type Singer = "female" | "male" | "both";
/** Each singer's lines, saved as their spans in the recording (seconds). */
export type Singers = Partial<Record<Singer, [number, number][]>>;
export const SINGERS: Singer[] = ["female", "male", "both"];
export const SINGER_LABEL: Record<Singer, string> = { female: "Nữ", male: "Nam", both: "Cả hai" };

/** The singer of each line (undefined: not marked). */
export function lineSingers(lines: Line[], singers: Singers | undefined, offset: number): (Singer | undefined)[] {
  const out: (Singer | undefined)[] = lines.map(() => undefined);
  if (!singers) return out;
  for (const who of SINGERS) {
    const parts = singers[who];
    if (parts?.length) for (const i of fromParts(lines, parts, offset, 0.2)) out[i] = who;
  }
  return out;
}

/** Lines' singers as saved: each line's own span (lines aren't joined, so a change of singer is exact). */
export function toSingers(lines: Line[], who: (Singer | undefined)[], offset: number): Singers {
  const out: Singers = {};
  who.forEach((s, i) => {
    if (s && lines[i]) (out[s] ??= []).push(span(lines[i], offset));
  });
  return out;
}

/** Why a line was picked for the harmony (shown to the user). */
export interface HarmonySuggestion {
  lines: Set<number>;
  chorus: number;
  climax: number;
  held: number;
}

/** A line's words, compared loosely (case, punctuation and spacing aside). */
const wordsOf = (l: Line) =>
  l.words
    .map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);

/** Share of `a`'s words also in `b` (both ways, the smaller). */
function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const count = (x: string[], y: string[]) => {
    const pool = new Map<string, number>();
    y.forEach((w) => pool.set(w, (pool.get(w) ?? 0) + 1));
    let n = 0;
    for (const w of x) {
      const c = pool.get(w) ?? 0;
      if (c > 0) {
        n++;
        pool.set(w, c - 1);
      }
    }
    return n;
  };
  return Math.min(count(a, b) / a.length, count(b, a) / b.length);
}

/**
 * Where a harmony belongs, as an arranger would put it: the chorus (lines
 * sung again and again), the climaxes (where the music is clearly louder
 * than usual) and long held notes at the end of a strong line; not rap
 * (many words to the second) nor stand-in hums. `energy` is the music's
 * loudness every `step` seconds of the recording; `offset` turns lyric time
 * into recording time.
 */
export function suggestHarmony(lines: Line[], energy: number[] | null | undefined, step: number, offset: number): HarmonySuggestion {
  const words = lines.map(wordsOf);
  const rap = lines.map((l) => {
    const dur = Math.max(0.5, l.end - l.start);
    return l.words.length / dur > 4.2;
  });
  // How often each line is sung (itself and its near-twins).
  const times = lines.map((_, i) => (words[i].length < 2 ? 1 : 1 + lines.filter((_, j) => j !== i && overlap(words[i], words[j]) >= 0.75).length));
  const repeated = times.map((n) => n >= 2);
  // The chorus is what comes back most: three times or more (a pre-chorus
  // usually comes twice); in a song with two choruses, twice.
  const most = Math.max(1, ...times);
  const chorusTimes = most >= 3 ? 3 : 2;
  const counted = times.map((n) => n >= chorusTimes && most >= 2);
  // A line sung a little differently inside a chorus is still the chorus.
  const chorus = counted.map((c, i) => c || (!!counted[i - 1] && !!counted[i + 1]));
  // Climax: the line's music is clearly louder than the song's middle.
  const loud = (() => {
    if (!energy?.length) return lines.map(() => false);
    const sorted = [...energy].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1e-6;
    const top = sorted[Math.floor(sorted.length * 0.8)] || median;
    const bar = Math.max(median * 1.25, top * 0.95);
    return lines.map((l) => {
      const a = Math.max(0, Math.floor((l.start + offset) / step));
      const b = Math.min(energy.length, Math.ceil((l.end + offset) / step));
      if (b <= a) return false;
      let sum = 0;
      for (let k = a; k < b; k++) sum += energy[k];
      return sum / (b - a) >= bar;
    });
  })();
  // A long note to end a line, in a loud stretch: a harmony makes it bloom.
  const held = lines.map((l) => {
    const last = l.words[l.words.length - 1];
    return !!last && last.end - last.start >= 1.2;
  });
  const picked = new Set<number>();
  let nChorus = 0;
  let nClimax = 0;
  let nHeld = 0;
  lines.forEach((l, i) => {
    if (l.hum || rap[i]) return;
    if (chorus[i]) {
      picked.add(i);
      nChorus++;
    } else if (loud[i] && (repeated[i] || held[i])) {
      // A pre-chorus or held note, where the music swells.
      picked.add(i);
      nClimax++;
    } else if (held[i] && loud[i - 1] && loud[i + 1]) {
      picked.add(i);
      nHeld++;
    }
  });
  // Nothing found (no repeats, flat loudness): the loudest fifth of the lines.
  if (!picked.size && energy?.length) lines.forEach((l, i) => !l.hum && !rap[i] && loud[i] && picked.add(i));
  return { lines: picked, chorus: nChorus, climax: nClimax, held: nHeld };
}
