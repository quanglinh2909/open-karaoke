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

/** How lit a word is at `t` (0–1), and for a held note how far its hold bar has run. */
export function wordProgress(w: Word, t: number, last = false): { lit: number; hold: number; held: boolean } {
  const dur = Math.max(0.05, w.end - w.start);
  if (isHeld(w, last)) {
    const attack = Math.min(ATTACK, dur * 0.5);
    return { lit: clamp01((t - w.start) / attack), hold: clamp01((t - w.start - attack) / (dur - attack)), held: true };
  }
  return { lit: clamp01((t - w.start) / dur), hold: 0, held: false };
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
  /** Countdown dot lit (3, 2, 1) before a short gap ends, or 0. */
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

/**
 * The countdown cue at `t`, with `i` the line being sung (-1 before the
 * first). One style per gap: dots for short gaps, and for breaks the
 * seconds-and-bar panel all the way to the line.
 */
export function cueAt(lines: Line[], i: number, t: number): Cue {
  const line = lines[i];
  const next = lines[i + 1];
  const from = line ? line.end : 0;
  const gap = next ? next.start - from : 0;
  const left = next ? next.start - t : Infinity;
  const dots = Math.max(1, Math.min(3, Math.floor(gap - 0.5)));
  const count = gap >= COUNT_GAP && gap < BREAK_GAP && left > 0 && left <= dots ? Math.ceil(left) : 0;
  const inBreak = gap >= BREAK_GAP && t > from + LINGER && left > 0;
  return { count, dots, breakLeft: inBreak ? Math.ceil(left) : 0, bar: inBreak ? clamp01((t - from) / gap) : 0, intro: i < 0 };
}
