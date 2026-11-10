import type { Lyrics } from "./api";
import type { Line, Word } from "./lrc";
import type { Ranked } from "./sources";

/**
 * What it took to prepare a song, kept on this computer so reopening it
 * skips the YouTube search, the download and (with the stem cache) the AI.
 */
/** What the user set for one song, put back next time it is opened. */
export interface SongSettings {
  semitones: number;
  tempo: number;
  /** Lyric timing nudge, seconds. */
  userOffset: number;
  /** Autotune key chosen by hand (absent: follow the song's key). */
  key?: { tonic: number; scale: number };
  /** Seconds skipped at the start and end of the recording. */
  trim?: { start: number; end: number };
}

export interface LibraryEntry {
  sourceId: string;
  sourcePath: string;
  /** Alternative recordings, for the Song tab. */
  originals: Ranked[];
  lyrics: Lyrics | null;
  /** Lyrics re-timed to the recording `sourceId` by forced alignment. */
  aligned?: { sourceId: string; lines: Line[]; v?: number };
  settings?: SongSettings;
  /** Words the user corrected: "<original line text>|<word index>" → text.
   * Keyed by the line's text, so a fix applies to every repeat of a chorus
   * line and survives re-fitting the lyrics. */
  fixes?: Record<string, string>;
  savedAt: number;
}

const KEY = "openkaraoke.library.v1";
const MAX_ENTRIES = 80;

function read(): Record<string, LibraryEntry> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<
      string,
      LibraryEntry
    >;
  } catch {
    return {};
  }
}

function write(all: Record<string, LibraryEntry>) {
  // Keep the most recently used entries within budget.
  const entries = Object.entries(all)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage full or unavailable: the library is only an accelerator */
  }
}

export function libraryEntry(songId: string): LibraryEntry | null {
  return read()[songId] ?? null;
}

/** Merge `patch` into a song's entry; a source is required to create one. */
export function saveToLibrary(
  songId: string,
  patch: Partial<Omit<LibraryEntry, "savedAt">>,
) {
  const all = read();
  const prev: LibraryEntry | undefined = all[songId];
  if (!prev && !(patch.sourceId && patch.sourcePath)) return;
  const base: LibraryEntry = prev ?? {
    sourceId: "",
    sourcePath: "",
    originals: [],
    lyrics: null,
    savedAt: 0,
  };
  all[songId] = { ...base, ...patch, savedAt: Date.now() };
  write(all);
}

/** Forget a song: its recording, lyrics and timing. */
export function removeFromLibrary(songId: string) {
  const all = read();
  delete all[songId];
  write(all);
}

/** Source ids for songs, for asking the backend which are ready to play. */
export function librarySources(songIds: string[]): Map<string, string> {
  const all = read();
  const map = new Map<string, string>();
  for (const id of songIds)
    if (all[id]?.sourceId) map.set(all[id].sourceId, id);
  return map;
}

/** `lines` with the song's word corrections applied (again, if they were before). */
export function withFixes(songId: string, lines: Line[]): Line[] {
  const fixes = libraryEntry(songId)?.fixes ?? {};
  // A stand-in line the singer deleted is gone.
  return lines
    .map((line) => applyFixes(line, fixes))
    .filter((l) => l.words.length);
}

/**
 * One line with its corrections. A corrected word may become several words,
 * which share its time in proportion to their length, or none: an empty fix
 * deletes it and the word before carries on through its time (the word after,
 * if it was the first).
 */
function applyFixes(line: Line, fixes: Record<string, string>): Line {
  const base = line.base ?? line.words;
  const orig = line.orig ?? line.text;
  let changed = false;
  const words: Word[] = [];
  let carry: number | null = null;
  base.forEach((w, k) => {
    const fix = fixes[`${orig}|${k}`];
    if (fix === undefined || fix === w.text) {
      words.push({ ...w, start: carry ?? w.start, src: k });
      carry = null;
      return;
    }
    changed = true;
    const parts = fix.split(/\s+/).filter(Boolean);
    if (!parts.length) {
      const prev = words[words.length - 1];
      if (prev) prev.end = w.end;
      else carry ??= w.start;
      return;
    }
    const weight = parts.map((p) => Math.max(1, [...p].length));
    const sum = weight.reduce((a, b) => a + b, 0);
    let at = carry ?? w.start;
    carry = null;
    const span = w.end - at;
    parts.forEach((text, j) => {
      const d = (span * weight[j]) / sum;
      words.push({ text, start: at, end: at + d, src: k });
      at += d;
    });
  });
  // Every word deleted (a stand-in, the audience shouting): the line goes.
  if (changed && !words.length) return { ...line, orig, base, words, text: "" };
  if (!changed || !words.length) {
    // No corrections (any more): back to the original words.
    return line.base
      ? {
          ...line,
          words: line.base,
          text: line.base.map((w) => w.text).join(" "),
          base: undefined,
          orig: undefined,
        }
      : line;
  }
  return {
    ...line,
    orig,
    base,
    words,
    text: words.map((w) => w.text).join(" "),
  };
}
