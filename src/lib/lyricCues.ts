/**
 * Timing rules for showing synced lyrics, shared by the stage (Lyrics.tsx)
 * and the exported video (videoExport.ts) so both look and move the same.
 */
import type { Line, Word } from "./lrc";

/** Seconds of lead-in before the first line. */
export const LEAD_IN = 3;
/** A gap before a line at least this long gets countdown dots… */
export const COUNT_GAP = 2;
/** …and at least this long is an instrumental break with its own panel. */
export const BREAK_GAP = 6;
/** Rests inside a line: a quick breath, and a real pause. */
export const SHORT_REST = 0.35;
export const LONG_REST = 1.0;
/** A word sung at least this long is a held note (a line's last word, where
 * singers hold most, from HOLD_END)… */
export const HOLD = 1.2;
export const HOLD_END = 0.7;
/** …whose text lights up in this long; the rest of it is the hold bar. */
export const ATTACK = 0.45;
/** Once a line is sung, the next one glides into place this long before it
 * starts, or this long after the last one ends, whichever comes first. */
export const SWITCH = 0.6;
export const LINGER = 0.8;
/** How long the glide to the next line takes (matches the stage's CSS transition). */
export const GLIDE = 0.6;
/** Where the line to sing sits, as a share of the stage's height. */
export const ANCHOR = 0.42;

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The line to show in place: the one being sung (`i`), or the next once it's done. -1 is the intro. */
export function focusAt(lines: Line[], i: number, t: number): number {
  const next = lines[i + 1];
  if (!next) return i;
  if (i < 0) return t >= next.start - LEAD_IN - 0.5 ? 0 : -1;
  const line = lines[i];
  return t >= line.end && t >= Math.min(next.start - SWITCH, line.end + LINGER) ? i + 1 : i;
}

/** When the focus moved onto line `f` (start of its glide into place). */
export function focusSince(lines: Line[], f: number): number {
  if (f < 0 || !lines[f]) return -Infinity;
  if (f === 0) return lines[0].start - LEAD_IN - 0.5;
  const prev = lines[f - 1];
  const line = lines[f];
  return Math.min(line.start, Math.max(prev.end, Math.min(line.start - SWITCH, prev.end + LINGER)));
}

/** Ease-out close to the stage's cubic-bezier(0.22, 0.8, 0.3, 1). */
export const glideEase = (u: number) => 1 - Math.pow(1 - clamp01(u), 3);

/** Whether a word is a held note; `last` = the line's last word. */
export const isHeld = (w: Word, last = false) => w.end - w.start >= (last ? HOLD_END : HOLD);

/** Length of a held note's trail, in em: longer for longer notes, never a mere dash. */
export const holdLength = (w: Word) => Math.max(1, Math.min(3, (w.end - w.start) * 0.9));

/** How lit a word is at `t` (0–1), and for a held note how far its hold bar
 * has run. Given its `line` and index `k`, the light moves through the line
 * as one smooth sweep (`lineWipe`) instead of word by word. */
export function wordProgress(w: Word, t: number, last = false, line?: Line, k = 0): { lit: number; hold: number; held: boolean } {
  const dur = Math.max(0.05, w.end - w.start);
  const held = isHeld(w, last);
  const attack = Math.min(ATTACK, dur * 0.5);
  const hold = held ? clamp01((t - w.start - attack) / (dur - attack)) : 0;
  if (line && line.words[k] === w) {
    const wipe = lineWipe(line);
    return { lit: clamp01((wipe.x(t) - wipe.at[k]) / wipe.len[k]), hold, held };
  }
  return { lit: held ? clamp01((t - w.start) / attack) : clamp01((t - w.start) / dur), hold, held };
}

/** Width of the wipe's soft edge, in characters. */
export const WIPE_SOFT = 1.8;

/**
 * The wipe's soft edge over word `k` at `t`, as shares of the word (either
 * may lie outside 0–1): fully lit up to `from`, fading to unlit at `to`.
 * One edge sliding across the whole line, through the gaps between words,
 * rather than a hard edge restarting in each word. It sharpens at the
 * line's ends, so nothing lights before the first word and the last ends
 * fully lit.
 */
export function wipeEdge(line: Line, k: number, t: number): { from: number; to: number } {
  const w = lineWipe(line);
  const x = w.x(t);
  const n = w.at.length - 1;
  const total = n >= 0 ? w.at[n] + w.len[n] : 0;
  const soft = WIPE_SOFT * clamp01(Math.min(x, total - x) / WIPE_SOFT);
  return { from: (x - soft - w.at[k]) / w.len[k], to: (x - w.at[k]) / w.len[k] };
}

/**
 * A rest inside the line at `t` (a gap of `SHORT_REST` or more between two
 * of its words, a held note's own time not counted): how far through it,
 * 0–1, and the word it follows. Null while singing.
 */
export function restAt(line: Line, t: number): { k: number; f: number } | null {
  const ws = line.words;
  for (let k = 0; k + 1 < ws.length; k++) {
    const [a, b] = [ws[k].end, ws[k + 1].start];
    if (t >= a && t < b && b - a >= SHORT_REST) return { k, f: (t - a) / (b - a) };
    if (t < a) break;
  }
  return null;
}

/** The "breathing" of the singing dot during a rest: a scale, 1 at rest's edges, about 1.5 a second in. */
export function breath(f: number, len: number): number {
  // Whole breaths of about a second, starting and ending small.
  const n = Math.max(1, Math.round(len));
  return 1 + 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * n * f));
}

/**
 * Points of a held note's ribbon from `x0` to `x1` at height `y`: a gentle
 * wave like a sustained, vibrating note (the light runs along it while held).
 */
export function wavyTail(x0: number, x1: number, y: number, amp: number, step: number): [number, number][] {
  const pts: [number, number][] = [];
  const n = Math.max(2, Math.round((x1 - x0) / step));
  for (let i = 1; i <= n; i++) {
    // The wave fades out towards the end, as the note does.
    const fade = 1 - i / n;
    pts.push([x0 + ((x1 - x0) * i) / n, y + (i % 2 ? -1 : 1) * amp * fade]);
  }
  return pts;
}

/**
 * How far the light has come along laid-out words (`k`: word index, `x`, `w`:
 * its position and width), in the same units: through a word in proportion
 * to its characters, across the space to the next laid-out word. -Infinity
 * before the first has started. (For marks drawn along the words, such as
 * the melody ribbon, to move exactly with the text's wipe.)
 */
export function litAlong(line: Line, words: { k: number; x: number; w: number }[], t: number): number {
  const wipe = lineWipe(line);
  const X = wipe.x(t);
  let lit = -Infinity;
  words.forEach(({ k, x, w }, i) => {
    const s = wipe.at[k];
    // Not reached yet (at its very start: lit only once it is sung).
    if (X < s || (X === s && t < line.words[k].start)) return;
    const e = s + wipe.len[k];
    if (X <= e) lit = Math.max(lit, x + ((X - s) / wipe.len[k]) * w);
    else {
      const nx = words[i + 1];
      const gap = nx && nx.k === k + 1 ? nx.x - (x + w) : 0;
      lit = Math.max(lit, x + w + Math.min(1, X - e) * Math.max(0, gap));
    }
  });
  return lit;
}

/** A line's wipe: where the light is (in characters from the line's start)
 * at each moment. */
interface Wipe {
  x: (t: number) => number;
  /** Each word's first character and length. */
  at: number[];
  len: number[];
  sig: string;
}
const wipes = new WeakMap<Word[], Wipe>();

/**
 * The light through a line as one movement: through each word while it is
 * sung (a held note only for its first `ATTACK`), still in the rests, and
 * between those points a monotone cubic (Fritsch–Carlson) instead of
 * straight lines, so its speed changes smoothly from word to word rather
 * than jumping at each one (a short word used to flash by, a long one crawl)
 * and it eases into and out of rests. Still exactly on each word's start
 * and end, so it keeps to the singing.
 */
export function lineWipe(line: Line): Wipe {
  // (Keyed on the words; the signature catches words retimed in place.)
  const ws = line.words;
  const sig = ws.length ? `${ws.length}:${ws[0].start}:${ws[ws.length - 1].end}` : "";
  const cached = wipes.get(ws);
  if (cached?.sig === sig) return cached;
  const last = line.words.length - 1;
  const at: number[] = [];
  const len: number[] = [];
  const ts: number[] = [];
  const xs: number[] = [];
  let c = 0;
  const knot = (t: number, x: number) => {
    const n = ts.length;
    if (n && t <= ts[n - 1] + 1e-3) {
      // Same moment (a word ending as the next starts) or out of order: keep the furthest.
      xs[n - 1] = Math.max(xs[n - 1], x);
      return;
    }
    ts.push(t);
    xs.push(Math.max(x, n ? xs[n - 1] : x));
  };
  // Characters, a space counting as one between words, so the light
  // crosses it instead of jumping it.
  line.words.forEach((w) => {
    at.push(c);
    const n = Math.max(1, Array.from(w.text.trim()).length);
    len.push(n);
    c += n + 1;
  });
  line.words.forEach((w, k) => {
    const dur = Math.max(0.05, w.end - w.start);
    const held = isHeld(w, k === last);
    const next = line.words[k + 1];
    knot(w.start, at[k]);
    const done = w.start + (held ? Math.min(ATTACK, dur * 0.5) : dur);
    if (!next) {
      knot(done, at[k] + len[k]);
      return;
    }
    // Into the next word without stopping when the gap is no rest (most
    // gaps between words are a few hundredths of a second); a real rest,
    // or a held note, stops the light at the word's end, and it crosses
    // the space just before the next word.
    if (!held && next.start - w.end < SHORT_REST) return;
    knot(done, at[k] + len[k]);
    knot(Math.max(done + 1e-3, next.start - Math.min(0.08, (next.start - done) / 2)), at[k] + len[k]);
  });
  const m = ts.length;
  const d = ts.slice(1).map((t, i) => (xs[i + 1] - xs[i]) / (t - ts[i]));
  const slope = ts.map((_, i) => {
    if (i === 0) return d[0] ?? 0;
    if (i === m - 1) return d[i - 1];
    const [a, b] = [d[i - 1], d[i]];
    if (a <= 0 || b <= 0) return 0;
    // Weighted harmonic mean: never overshoots, so the light never runs back.
    const [ha, hb] = [ts[i] - ts[i - 1], ts[i + 1] - ts[i]];
    return (3 * (ha + hb)) / ((2 * hb + ha) / a + (hb + 2 * ha) / b);
  });
  const x = (t: number) => {
    if (!m) return 0;
    if (t <= ts[0]) return xs[0];
    if (t >= ts[m - 1]) return xs[m - 1];
    let lo = 0;
    let hi = m - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid;
    }
    const h = ts[hi] - ts[lo];
    const u = (t - ts[lo]) / h;
    const [u2, u3] = [u * u, u * u * u];
    return (
      (2 * u3 - 3 * u2 + 1) * xs[lo] + (u3 - 2 * u2 + u) * h * slope[lo] + (-2 * u3 + 3 * u2) * xs[hi] + (u3 - u2) * h * slope[hi]
    );
  };
  const wipe = { x, at, len, sig };
  wipes.set(line.words, wipe);
  return wipe;
}

/** The rest after word `k` of a line: none, a short breath or a long pause. */
export function restAfter(line: Line, k: number): "short" | "long" | null {
  const after = line.words[k + 1];
  const rest = after ? after.start - line.words[k].end : 0;
  return rest >= LONG_REST ? "long" : rest >= SHORT_REST ? "short" : null;
}

/** Gaps between lines shorter than this go straight on ("→")… */
export const LINK_GAP = SHORT_REST;
/** …and from ENTRY_GAP to COUNT_GAP the next line's first word gets an entry ring. */
export const ENTRY_GAP = 0.5;

/**
 * How line `li` leads into the next: straight on ("link", →), a quick
 * breath (•), a real pause (|), or null when the countdown or break panel
 * takes over (or it is the last line).
 */
export function lineJoin(lines: Line[], li: number): "link" | "short" | "long" | null {
  const line = lines[li];
  const next = lines[li + 1];
  if (!line || !next) return null;
  const gap = next.start - line.end;
  if (gap >= COUNT_GAP) return null;
  return gap < LINK_GAP ? "link" : gap < LONG_REST ? "short" : "long";
}

/**
 * The entry ring on line `li`'s first word at `t`: 0–1 while the short gap
 * before it runs out (full = sing now), else null. It only runs in the gap,
 * after the line before is done, so it never moves while words are wiping.
 */
export function entryRing(lines: Line[], li: number, t: number): number | null {
  const prev = lines[li - 1];
  const line = lines[li];
  if (!prev || !line) return null;
  const gap = line.start - prev.end;
  if (gap < ENTRY_GAP || gap >= COUNT_GAP || t < prev.end || t >= line.start) return null;
  return clamp01((t - prev.end) / gap);
}

export interface Cue {
  /** The countdown: dots `dots`…1, those numbered `count` or less lit; 0 = no countdown. */
  count: number;
  /** How many dots the countdown has (1–3). */
  dots: number;
  /** Seconds left in an instrumental break, or 0 when not in one. */
  breakLeft: number;
  /** How far through the break, 0–1. */
  bar: number;
  /** Still before the first line. */
  intro: boolean;
}

/** The most beats counted in before a line ("3 – 2 – 1", as singers count). */
export const COUNT_BEATS = 3;

/**
 * The countdown cue at `t`, with `i` the line being sung (-1 before the
 * first). One style per gap: dots for short gaps, and for breaks the
 * seconds-and-bar panel. With the song's `beats` (lyric time, sorted) the
 * dots count its last beats before the line, one lighting on each, and a
 * break's panel gives way to them for its last bar; without, they count
 * seconds.
 */
export function cueAt(lines: Line[], i: number, t: number, beats?: number[] | null): Cue {
  const line = lines[i];
  const next = lines[i + 1];
  const from = line ? line.end : 0;
  const gap = next ? next.start - from : 0;
  const left = next ? next.start - t : Infinity;
  const intro = i < 0;
  if (next && gap >= COUNT_GAP && beats?.length) {
    const counted = beatsBefore(beats, from, next.start);
    if (counted.length >= 2) {
      const period = counted[1] - counted[0];
      const shownFrom = counted[0] - period;
      if (t >= shownFrom && left > 0) {
        let lit = 0;
        while (lit < counted.length && counted[lit] <= t) lit++;
        return { count: counted.length - lit + 1, dots: counted.length, breakLeft: 0, bar: 0, intro };
      }
      const inBreak = gap >= BREAK_GAP && t > from + LINGER && t < shownFrom;
      return { count: 0, dots: counted.length, breakLeft: inBreak ? Math.ceil(left) : 0, bar: inBreak ? clamp01((t - from) / gap) : 0, intro };
    }
  }
  const dots = Math.max(1, Math.min(3, Math.floor(gap - 0.5)));
  const count = gap >= COUNT_GAP && gap < BREAK_GAP && left > 0 && left <= dots ? Math.ceil(left) : 0;
  const inBreak = gap >= BREAK_GAP && t > from + LINGER && left > 0;
  return { count, dots, breakLeft: inBreak ? Math.ceil(left) : 0, bar: inBreak ? clamp01((t - from) / gap) : 0, intro };
}

/**
 * The beats counted in before a line starting at `start`, after the last
 * one ended at `from`: up to `COUNT_BEATS` of the last beats in between
 * (none too close to either line), evenly spaced like the song's own.
 */
function beatsBefore(beats: number[], from: number, start: number): number[] {
  // Binary search: the first beat at or after the line's start.
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < start - 0.12) lo = mid + 1;
    else hi = mid;
  }
  const out: number[] = [];
  for (let k = lo - 1; k >= 0 && out.length < COUNT_BEATS; k--) {
    if (beats[k] <= from + 0.15) break;
    out.unshift(beats[k]);
  }
  // A missed or extra beat would make the count limp: keep only a steady run.
  for (let k = out.length - 2; k >= 1; k--) {
    const [a, b] = [out[k] - out[k - 1], out[k + 1] - out[k]];
    if (Math.abs(a - b) > 0.25 * b) return out.slice(k);
  }
  return out;
}

/** A stretch of the melody over a word: from and to as shares of the word's time, `h` its height in the line (0 low – 1 high). */
export interface PitchSeg {
  from: number;
  to: number;
  h: number;
}

/** A melody note: seconds in the recording, fractional MIDI. */
interface Note {
  start: number;
  end: number;
  midi: number;
}

/**
 * The original melody over each word of a line, for the pitch marks above
 * the words: per word the notes it spans, placed in the line's own range
 * (at least 5 semitones, so small steps stay small). `offset` turns lyric
 * time into recording time. Null when the melody has nothing there.
 */
export function linePitch(line: Line, notes: Note[] | null | undefined, offset: number): PitchSeg[][] | null {
  if (!notes?.length || !line.words.length || line.hum) return null;
  const raw: { from: number; to: number; midi: number }[][] = line.words.map((w) => {
    const ws = w.start + offset;
    const we = Math.max(w.end, w.start + 0.08) + offset;
    // First note that ends after the word starts.
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].end <= ws) lo = mid + 1;
      else hi = mid;
    }
    const segs: { from: number; to: number; midi: number }[] = [];
    for (let k = lo; k < notes.length && notes[k].start < we; k++) {
      const a = Math.max(ws, notes[k].start);
      const b = Math.min(we, notes[k].end);
      if (b - a < 0.04) continue;
      const last = segs[segs.length - 1];
      // Overlapping notes follow on from each other: the line only moves forward.
      const seg = { from: Math.max(last?.to ?? 0, (a - ws) / (we - ws)), to: (b - ws) / (we - ws), midi: notes[k].midi };
      if (seg.to - seg.from < 0.02) continue;
      // Steps under half a semitone are one note.
      if (last && Math.abs(last.midi - seg.midi) < 0.5 && seg.from - last.to < 0.15) last.to = seg.to;
      else segs.push(seg);
    }
    return segs;
  });
  const all = raw.flat();
  if (!all.length) return null;
  const top = Math.max(...all.map((s) => s.midi));
  const bottom = Math.min(...all.map((s) => s.midi));
  const range = Math.max(5, top - bottom);
  const mid = (top + bottom) / 2;
  return raw.map((segs) => segs.map((s) => ({ from: s.from, to: s.to, h: clamp01(0.5 + (s.midi - mid) / range) })));
}

/**
 * Where a line's phrases start: word `k` starts one after a rest (a breath
 * or pause). Long lines break between phrases, never in the middle of one,
 * so each row is something sung in one go.
 */
export function phraseStarts(line: Line): boolean[] {
  return line.words.map((_, k) => k === 0 || restAfter(line, k - 1) !== null);
}
