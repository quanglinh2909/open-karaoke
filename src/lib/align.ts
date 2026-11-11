import type { MelodyNote, WordTime } from "./api";
import type { Line, Word } from "./lrc";
import type { MergedLine, MergedWord } from "./lyricsMerge";

/**
 * Lyric text → the aligner's alphabet (lowercase a–z and apostrophes). The
 * MMS model works on romanized text, so Vietnamese tones and other accents
 * are dropped: "Được" → "duoc".
 */
export function romanize(word: string): string {
  return word
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z']/g, "");
}

const VI_DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

/** 0–999 read in Vietnamese; `full` reads a leading zero hundred ("không trăm"). */
function viHundreds(n: number, full: boolean): string[] {
  const [h, t, u] = [Math.floor(n / 100), Math.floor(n / 10) % 10, n % 10];
  const out: string[] = [];
  if (h || full) out.push(VI_DIGITS[h], "trăm");
  if (t === 0) {
    if (u && (h || full)) out.push("lẻ");
    if (u || (!h && !full)) out.push(VI_DIGITS[u]);
  } else {
    out.push(...(t === 1 ? ["mười"] : [VI_DIGITS[t], "mươi"]));
    if (u === 1 && t > 1) out.push("mốt");
    else if (u === 4 && t > 1) out.push("tư");
    else if (u === 5) out.push("lăm");
    else if (u) out.push(VI_DIGITS[u]);
  }
  return out;
}

/** A whole number read out in Vietnamese ("8515" → "tám nghìn năm trăm mười lăm"). */
export function viNumber(n: number): string {
  if (n === 0) return "không";
  const units = ["", "nghìn", "triệu", "tỷ"];
  const groups: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 1000)) groups.push(x % 1000);
  const out: string[] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    if (!groups[g]) continue;
    out.push(...viHundreds(groups[g], g < groups.length - 1), units[g] ?? "");
  }
  return out.filter(Boolean).join(" ");
}

const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** A whole number read out in English ("8515" → "eight thousand five hundred fifteen"). */
export function enNumber(n: number): string {
  const below1000 = (x: number): string[] => {
    const out: string[] = [];
    if (x >= 100) out.push(EN_ONES[Math.floor(x / 100)], "hundred");
    const r = x % 100;
    if (r >= 20) out.push(EN_TENS[Math.floor(r / 10)], ...(r % 10 ? [EN_ONES[r % 10]] : []));
    else if (r || !out.length) out.push(EN_ONES[r]);
    return out;
  };
  if (n === 0) return "zero";
  const units = ["", "thousand", "million", "billion"];
  const out: string[] = [];
  const groups: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 1000)) groups.push(x % 1000);
  for (let g = groups.length - 1; g >= 0; g--)
    if (groups[g]) out.push(...below1000(groups[g]), units[g] ?? "");
  return out.filter(Boolean).join(" ");
}

/**
 * What the aligner listens for in a lyric word: its letters, romanized. A
 * number has none, so it is read out ("8515" sung as "tám nghìn năm trăm
 * mười lăm"); without this it was squeezed into 0.3 s and the word before
 * it held through the time it was sung.
 */
export function spokenForm(word: string, vietnamese: boolean): string {
  const digits = word.replace(/[.,]/g, "").match(/^\D*?(\d{1,12})\D*$/);
  if (!digits) return romanize(word);
  const n = Number(digits[1]);
  const read = vietnamese ? viNumber(n) : enNumber(n);
  return romanize(word.replace(/[\d.,]+/, " " + read + " ").replace(/\s+/g, ""));
}

/** Plain (unsynced) lyrics as untimed lines, ready to be aligned. */
export function linesFromPlain(plain: string): Line[] {
  return plain
    .split(/\r?\n/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t && !/^\[.*\]$/.test(t))
    .map((text) => ({
      start: 0,
      end: 0,
      next: 0,
      text,
      words: text.split(" ").map((w) => ({ text: w, start: 0, end: 0 })),
    }));
}

/**
 * A word whose letters score below this was not really heard: the singer
 * sang something else there (the LRC has "Gặp" where this recording has
 * "Tìm"), or skipped it, and CTC had to put it somewhere anyway.
 */
const WORD_MIN = -4.5;
/** Seconds per word when placing words that weren't heard. */
const PACE = 0.3;

/**
 * A whole line nobody could hear (a producer tag like "(Hey, Kewtiie)", a
 * hum): with LRC times it goes where the LRC puts it, shifted by the offset
 * of the nearest heard line, instead of being squeezed against the next
 * heard word. Its words get times in `times` (at a natural pace) only if
 * that fits between the heard words around it.
 */
function placeUnheardLines(
  lines: Line[],
  origin: number[],
  lineOf: number[],
  times: (WordTime | null)[],
  lrcStarts: (number | null)[],
) {
  const firstWord: number[] = [];
  lineOf.forEach((li, i) => {
    if (firstWord[li] === undefined) firstWord[li] = i;
  });
  const range = (li: number) => [firstWord[li], firstWord[li] + lines[li].words.length] as const;
  const heard = (li: number) => {
    const [a, b] = range(li);
    return times.slice(a, b).some(Boolean);
  };
  // Offset of a line whose first word was heard: aligned time − LRC time.
  const offset = (li: number) => {
    const t = times[firstWord[li]];
    const lrc = lrcStarts[origin[li]];
    return t && lrc != null && lrc > 0 ? t.start - lrc : null;
  };
  for (let li = 0; li < lines.length; li++) {
    const lrc = lrcStarts[origin[li]];
    if (heard(li) || lrc == null || lrc <= 0) continue;
    let off: number | null = null;
    for (let d = 1; d < lines.length && off === null; d++)
      off = (li + d < lines.length ? offset(li + d) : null) ?? (li - d >= 0 ? offset(li - d) : null);
    if (off === null) continue;
    const [a, b] = range(li);
    const n = b - a;
    const prevEnd = [...times.slice(0, a)].reverse().find(Boolean)?.end ?? 0;
    const nextStart = times.slice(b).find(Boolean)?.start ?? Infinity;
    const start = Math.max(lrc + off, prevEnd);
    const step = Math.min(PACE, (nextStart - start) / n);
    if (step < 0.08) continue; // no room: leave it to the usual placement
    for (let k = 0; k < n; k++)
      times[a + k] = { start: start + k * step, end: start + (k + 1) * step, score: WORD_MIN };
  }
}

/**
 * Rebuild `lines` with the word times from forced alignment. Words that
 * weren't heard (or have no letters, like numbers) are placed next to the
 * nearest heard word of their line at a natural pace. Null when too little
 * of the text was heard to trust the result.
 */
export function retime(
  all: Line[],
  heardTimes: (WordTime | null)[],
  /** Each line's published (LRC) time, if the lines are the published ones. */
  lrcStarts: (number | null)[] | null = null,
): Line[] | null {
  if (heardTimes.length !== all.reduce((n, l) => n + l.words.length, 0))
    return null;
  // A word only one side has that the aligner can't hear either stays,
  // marked: a wrong word is easier to correct than a missing one.
  let w0 = 0;
  const aligned: (WordTime | null)[] = [];
  /** Index in `all` of each kept line. */
  const origin: number[] = [];
  const lines = all
    .map((l, li) => {
      const words = l.words.map((w, k) => {
        const t = heardTimes[w0 + k];
        aligned.push(t);
        const doubtful =
          (w as MergedWord).heard === false &&
          !(t !== null && t.score >= WORD_MIN);
        return doubtful ? { ...w, unsure: true } : w;
      });
      w0 += l.words.length;
      // A published line nobody was heard singing (put back from the LRC,
      // never heard by Whisper) stays only if the aligner hears most of it.
      const putBack =
        !(l as MergedLine).heardAt &&
        l.words.every((w) => (w as MergedWord).heard === false);
      if (
        putBack &&
        words.filter((w) => !w.unsure).length < l.words.length * 0.7
      ) {
        aligned.splice(aligned.length - words.length, words.length);
        return { ...l, words: [] };
      }
      origin.push(li);
      return { ...l, words, text: words.map((w) => w.text).join(" ") };
    })
    .filter((l) => l.words.length);
  const words = lines.flatMap((l) => l.words);
  if (!words.length) return null;
  const times = aligned.map((t) => (t && t.score >= WORD_MIN ? t : null));
  // Too little of what both sides agree on is heard: the timing can't be trusted.
  const agreed = words
    .map((w, i) => ({ w, t: times[i] }))
    .filter(({ w }) => (w as MergedWord).heard !== false);
  if (agreed.filter(({ t }) => t).length < agreed.length * 0.8) return null;
  const lineOf = lines.flatMap((l, i) => l.words.map(() => i));
  if (lrcStarts) placeUnheardLines(lines, origin, lineOf, times, lrcStarts);

  const timed: { start: number; end: number }[] = [];
  for (let i = 0; i < words.length;) {
    const t = times[i];
    if (t) {
      timed.push({ start: t.start, end: t.end });
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && !times[j]) j++;
    const n = j - i;
    const prev = timed.length ? timed[timed.length - 1].end : null;
    const next = times[j]?.start ?? null;
    let from: number;
    if (prev !== null && next !== null && next - prev <= 2 * PACE * n)
      from = prev;
    // A long gap: stay with the heard word of the same line.
    else if (next !== null && (prev === null || lineOf[j] === lineOf[j - 1]))
      from = next - PACE * n;
    else from = prev ?? 0;
    const step =
      prev !== null && next !== null && next - prev <= 2 * PACE * n
        ? (next - prev) / n
        : PACE;
    for (let k = 0; k < n; k++)
      timed.push({
        start: Math.max(0, from + k * step),
        end: Math.max(0, from + (k + 1) * step),
      });
    i = j;
  }

  let w = 0;
  const out: Line[] = lines.map((l) => {
    const ws: Word[] = l.words.map((word) => {
      const t = timed[w++];
      const out: Word = {
        text: word.text,
        start: t.start,
        end: Math.max(t.end, t.start + 0.08),
      };
      if (word.unsure) out.unsure = true;
      return out;
    });
    return {
      text: l.text,
      words: ws,
      start: ws[0].start,
      end: ws[ws.length - 1].end,
      next: 0,
    };
  });
  out.forEach((l, i) => (l.next = out[i + 1]?.start ?? l.end + 8));
  return out;
}

/** Notes closer than this (seconds) belong to one sung passage. */
const HUM_JOIN = 1.5;
/** Shortest passage (seconds) that gets a stand-in line, and how much of it must be notes. */
const HUM_MIN = 3;
const HUM_VOICED = 2;
/** Room kept around lyric lines (a held last vowel runs past its end). */
const HUM_BEFORE = 0.3;
const HUM_AFTER = 1;

/** Gaps in the melody (seconds) a held note may bridge (a breath of vibrato). */
const HOLD_BRIDGE = 0.8;
/** How far (semitones) a held note may wander from the word's own. */
const HOLD_PITCH = 3;
/** Longest a line's last word may be held, with its extension (seconds). */
const HOLD_MAX = 8;

/**
 * Each line's last word held for as long as the melody carries straight on
 * from it: the aligner only gives a held vowel a few seconds, and the rest
 * would otherwise look like singing without words ("khứ" held to the end).
 */
function withHolds(lines: Line[], notes: MelodyNote[]): Line[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  return lines.map((line, i) => {
    const last = line.words[line.words.length - 1];
    if (!last) return line;
    const limit = Math.min(
      (lines[i + 1]?.start ?? Infinity) - 0.15,
      last.start + HOLD_MAX,
    );
    // The note the word ends on: a hold stays near it (a new phrase moves on).
    const ref = sorted
      .filter((n) => n.start < last.end && n.end > last.start)
      .pop()?.midi;
    let end = line.end;
    for (const n of sorted) {
      if (n.start > end + HOLD_BRIDGE || n.start >= limit) break;
      if (
        n.end > end &&
        (ref === undefined || Math.abs(n.midi - ref) <= HOLD_PITCH)
      )
        end = Math.min(n.end, limit);
    }
    if (end <= line.end + 0.05) return line;
    end = Math.round(end * 100) / 100;
    return {
      ...line,
      end,
      words: [...line.words.slice(0, -1), { ...last, end }],
    };
  });
}

/** The stand-in word of a `hum` line. */
export const HUM = "♪♪♪";

/**
 * `lines` plus a stand-in line ("♪♪♪", `hum`) wherever the melody shows
 * singing but no lyric line is: passages speech recognition couldn't make
 * out (vocalises, ad-libs, a mumbled verse), so the singer sees that
 * something is sung there and can type the words in or delete it.
 */
export function withHums(lines: Line[], notes: MelodyNote[] | null): Line[] {
  if (!notes?.length || !lines.length) return lines;
  lines = withHolds(lines, notes);
  const busy = lines.map(
    (l) => [l.start - HUM_BEFORE, l.end + HUM_AFTER] as const,
  );
  const free = (t: number) => !busy.some(([a, b]) => t >= a && t <= b);
  // Note pieces outside every lyric line, grouped into passages.
  const passages: { start: number; end: number; voiced: number }[] = [];
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    // Clip the note to the stretch outside the lines (notes are short).
    let s = n.start;
    let e = n.end;
    for (const [a, b] of busy) {
      if (s >= a && s <= b) s = b;
      if (e >= a && e <= b) e = a;
    }
    if (e - s < 0.05 || !free((s + e) / 2)) continue;
    const last = passages[passages.length - 1];
    // A lyric line in between splits passages.
    if (last && s - last.end < HUM_JOIN && free((last.end + s) / 2)) {
      last.end = e;
      last.voiced += e - s;
    } else passages.push({ start: s, end: e, voiced: e - s });
  }
  const hums: Line[] = passages
    .filter((p) => p.end - p.start >= HUM_MIN && p.voiced >= HUM_VOICED)
    .map((p) => {
      const [start, end] = [
        Math.round(p.start * 100) / 100,
        Math.round(p.end * 100) / 100,
      ];
      // Its own key for corrections, as every stand-in reads the same.
      return {
        start,
        end,
        next: 0,
        text: HUM,
        orig: `${HUM} ${start.toFixed(1)}`,
        hum: true,
        words: [{ text: HUM, start, end, unsure: true }],
      };
    });
  if (!hums.length) return lines;
  const out = [...lines, ...hums].sort((a, b) => a.start - b.start);
  out.forEach((l, i) => (l.next = out[i + 1]?.start ?? l.end + 8));
  return out;
}

/** Seconds per value from `api.vocalActivity` (VOCAL_HOP in lib.rs). */
const HOP = 0.05;
/** Furthest the lyrics are searched from where the LRC puts them. */
const MAX_SHIFT = 30;

/**
 * Find how far the lyrics must move to line up with the separated vocal.
 * Returns seconds to use as `userOffset` (positive = lyrics later), or null
 * when the match is not clearly better than leaving the lyrics alone.
 *
 * Synced lyrics are often timed to a different upload than the one we play
 * (a music video with an intro, a radio edit…), so the whole file is slid
 * against the vocal's on/off pattern and the best overlap wins.
 */
export function estimateLyricOffset(
  env: number[],
  lines: Line[],
): number | null {
  const sung = lines.filter((l) => l.text.trim() && l.end > l.start);
  const n = env.length;
  if (sung.length < 4 || n * HOP < 30) return null;

  // Voiced = within ~16 dB of the song's loud passages.
  const sorted = [...env].sort((a, b) => a - b);
  const loud = sorted[Math.floor(n * 0.95)];
  if (!(loud > 0)) return null;
  const threshold = loud * 0.15;
  let voicedCount = 0;
  for (const e of env) if (e > threshold) voicedCount++;
  const mean = voicedCount / n;

  // Prefix sums of centred activity: each line scores in O(1), and lining a
  // lyric up with silence costs as much as lining it up with singing earns.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++)
    pre[i + 1] = pre[i] + (env[i] > threshold ? 1 : 0) - mean;
  const span = (a: number, b: number) => {
    a = Math.max(0, Math.min(n, a));
    b = Math.max(0, Math.min(n, b));
    return b > a ? pre[b] - pre[a] : 0;
  };
  const frames = sung.map(
    (l) => [Math.round(l.start / HOP), Math.round(l.end / HOP)] as const,
  );
  const total = frames.reduce((s, [a, b]) => s + (b - a), 0);

  const maxK = Math.round(MAX_SHIFT / HOP);
  const scores = new Float64Array(2 * maxK + 1);
  let bestK = 0;
  for (let k = -maxK; k <= maxK; k++) {
    let s = 0;
    for (const [a, b] of frames) s += span(a + k, b + k);
    scores[k + maxK] = s;
    if (s > scores[bestK + maxK]) bestK = k;
  }
  const best = scores[bestK + maxK];
  const atZero = scores[maxK];

  // Too small to hear, or not convincingly better than the LRC as is.
  if (Math.abs(bestK * HOP) < 0.3 || (best - atZero) / total < 0.05)
    return null;
  // A rival peak elsewhere (repeated choruses) means we can't be sure.
  const away = Math.round(3 / HOP);
  for (let k = -maxK; k <= maxK; k++) {
    if (Math.abs(k - bestK) > away && scores[k + maxK] > best * 0.95)
      return null;
  }
  return Math.round(bestK * HOP * 100) / 100;
}

/** How many alternative versions `alternatives` can produce. */
export function variantCount(lines: MergedLine[]): number {
  const words = lines.some(
    (l) => !l.alts && l.words.some((w) => (w as MergedWord).alt),
  )
    ? 1
    : 0;
  return Math.max(words, ...lines.map((l) => l.alts?.length ?? 0));
}

/**
 * Version `v` (1-based) of the lyrics: each line's v-th rival line, or for
 * lines without rivals (in version 1) the other side of disputed words.
 */
export function alternatives(lines: MergedLine[], v: number): string[][] {
  return lines.map((l) => {
    if (l.alts) return (l.alts[v - 1] ?? l.words).map((w) => w.text);
    return l.words.map((w) =>
      v === 1 ? ((w as MergedWord).alt ?? w.text) : w.text,
    );
  });
}

/** Indexes of the words of `longer` left over once `shorter` is matched in order (LCS). */
function extraWords(shorter: Word[], longer: Word[]): number[] {
  const a = shorter.map((w) => romanize(w.text));
  const b = longer.map((w) => romanize(w.text));
  const L = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i][j] =
        a[i] === b[j]
          ? L[i + 1][j + 1] + 1
          : Math.max(L[i + 1][j], L[i][j + 1]);
  const extra: number[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j] && L[i][j] === L[i + 1][j + 1] + 1) {
      i++;
      j++;
    } else if (i < a.length && L[i + 1][j] >= L[i][j + 1]) i++;
    else extra.push(j++);
  }
  return extra;
}

/**
 * Where Whisper and the LRC disagree, keep whichever version the vocal fits
 * better: per line for rival lines, per word for disputed words. `results[v]`
 * is the aligner's result for version v (0: `lines` as they are).
 */
export function chooseVariants(
  lines: MergedLine[],
  results: (WordTime | null)[][][],
): { lines: Line[]; changed: boolean } {
  const score = (t: WordTime | null | undefined) => t?.score ?? -8;
  const mean = (ts: (WordTime | null)[] | undefined) =>
    ts?.length ? ts.reduce((s, t) => s + score(t), 0) / ts.length : -Infinity;
  let changed = false;
  const out = lines.map((l, i) => {
    if (l.alts) {
      // A version with words this one lacks wins whenever the vocal has
      // them at all (a short or soft word drags the mean down, yet it is
      // sung): better a doubtful word to check than a missing one.
      let fuller = -1;
      let fullerExtra: number[] = [];
      l.alts.forEach((alt, k) => {
        // Only among a repeated line's own hearings: published rival lines
        // compete on fit alone.
        if (!l.repeats || alt.length <= l.words.length) return;
        const extra = extraWords(l.words, alt);
        const times = results[k + 1]?.[i];
        if (!extra.length || !extra.every((j) => score(times?.[j]) >= WORD_MIN))
          return;
        if (fuller < 0 || mean(times) > mean(results[fuller + 1]?.[i])) {
          fuller = k;
          fullerExtra = extra;
        }
      });
      if (fuller >= 0) {
        changed = true;
        const words = l.alts[fuller].map((w, j) =>
          fullerExtra.includes(j) ? { ...w, unsure: true } : w,
        );
        return { ...l, words, text: words.map((w) => w.text).join(" ") };
      }
      let best = 0;
      l.alts.forEach((_, k) => {
        if (mean(results[k + 1]?.[i]) > mean(results[best]?.[i])) best = k + 1;
      });
      if (best === 0) return l;
      changed = true;
      const words = l.alts[best - 1];
      return { ...l, words, text: words.map((w) => w.text).join(" ") };
    }
    const words = l.words.map((w, k) => {
      const other = (w as MergedWord).alt;
      if (!other || score(results[1]?.[i]?.[k]) <= score(results[0][i]?.[k]))
        return w;
      changed = true;
      return { ...w, text: other };
    });
    return { ...l, words, text: words.map((w) => w.text).join(" ") };
  });
  return { lines: out, changed };
}
