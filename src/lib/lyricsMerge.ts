import { romanize } from "./align";
import type { HeardLine } from "./api";
import type { Line, Word } from "./lrc";

/**
 * Make the lyrics say what this singer sings. Published lyrics (LRC) have
 * reliable spelling and tones but may belong to another version: words
 * changed in a cover, lines this recording repeats or leaves out. Whisper
 * hears the actual singer but misspells (wrong tones, near-homophones) and
 * now and then invents. So the line structure follows what Whisper heard,
 * each heard line is matched to the LRC line it is, and the LRC spelling is
 * used except where the singer clearly sings a different word. Anything
 * only one side has is marked unconfirmed (`heard: false`); forced
 * alignment then drops it unless it can hear it.
 */

/** Whisper must be at least this sure to overrule the published lyrics. */
const TRUST = 0.5;
/** Words only Whisper heard are considered only when it is this sure. */
const EXTRA_TRUST = 0.8;
/** Below this share of the LRC recognised, Whisper is too unreliable to use. */
const MIN_AGREEMENT = 0.35;

/**
 * A lyric word. `heard: false` marks a word only one side has (kept only if
 * the aligner hears it); `alt` is the other side's word where Whisper and
 * the LRC disagree outright, for the aligner to choose between.
 */
export type MergedWord = Word & { heard?: boolean; alt?: string };

/**
 * A lyric line. `alts` are other LRC lines the heard words match almost as
 * well (Whisper may have repeated the line before); the aligner picks.
 */
export type MergedLine = Line & {
  alts?: MergedWord[][];
  heardAt?: [number, number];
  /** `alts` are this line's other hearings where it repeats (no published lyrics). */
  repeats?: boolean;
};

interface Hw {
  text: string;
  p: number;
  seg: number;
  /** When Whisper heard it (seconds). */
  at: [number, number];
}

type Op = { a: number | null; b: number | null };

const key = (w: string) =>
  w
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}']/gu, "");

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return row[b.length];
}

const simCache = new Map<string, number>();

/** 1 = same word, 0.8 = same syllable with another tone, less = similar spelling, 0 = different. */
export function similarity(a: string, b: string): number {
  const id = `${a}|${b}`;
  let s = simCache.get(id);
  if (s === undefined) simCache.set(id, (s = rawSimilarity(a, b)));
  return s;
}

function rawSimilarity(a: string, b: string): number {
  if (key(a) === key(b)) return 1;
  const ra = romanize(a);
  const rb = romanize(b);
  if (ra && ra === rb) return 0.8;
  const r = 1 - levenshtein(ra, rb) / Math.max(ra.length, rb.length, 1);
  return r >= 0.5 ? r * 0.6 : 0;
}

/** Global alignment (Needleman–Wunsch) of two word sequences. */
function alignWords(A: string[], B: string[]): Op[] {
  const n = A.length;
  const m = B.length;
  const GAP = -0.6;
  const w = m + 1;
  const score = new Float64Array((n + 1) * w);
  const move = new Uint8Array((n + 1) * w); // 0 diag, 1 up (A only), 2 left (B only)
  for (let i = 1; i <= n; i++) ((score[i * w] = i * GAP), (move[i * w] = 1));
  for (let j = 1; j <= m; j++) ((score[j] = j * GAP), (move[j] = 2));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = similarity(A[i - 1], B[j - 1]);
      // A substitution must cost less than two gaps, or "quay ngoảnh" vs
      // "quay quay" becomes a skip plus an insertion instead of a pair.
      const diag =
        score[(i - 1) * w + j - 1] +
        (s >= 0.8 ? 2 * s : s > 0 ? s - 0.5 : -1.0);
      const up = score[(i - 1) * w + j] + GAP;
      const left = score[i * w + j - 1] + GAP;
      const best = Math.max(diag, up, left);
      score[i * w + j] = best;
      move[i * w + j] = best === diag ? 0 : best === up ? 1 : 2;
    }
  }
  const ops: Op[] = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    const mv = move[i * w + j];
    if (i > 0 && j > 0 && mv === 0) ops.push({ a: --i, b: --j });
    else if (i > 0 && (j === 0 || mv === 1)) ops.push({ a: --i, b: null });
    else ops.push({ a: null, b: --j });
  }
  return ops.reverse();
}

interface Out {
  text: string;
  /** Output line key; consecutive words with the same key form a line. */
  line: string;
  heard: boolean;
  alt?: string;
  /** On a line's first word: the whole line as other LRC lines. */
  altLines?: Out[][];
  /** When Whisper heard it (seconds), for words it heard. */
  at?: [number, number];
  unsure?: boolean;
}

/** A line's words: LRC line `ref` as the singer sang it (Whisper words `seg`). */
function lineWords(ref: string[], seg: Hw[], ops: Op[], key: string): Out[] {
  const out: Out[] = [];
  for (const o of pairUp(ops)) {
    if (o.b === null) {
      // In the LRC line but not heard: maybe skipped by this singer.
      out.push({ text: ref[o.a!], line: key, heard: false });
      continue;
    }
    const w = seg[o.b];
    if (o.a === null) {
      // Kept even when doubtful: better a wrong word to correct than a gap.
      out.push({
        text: w.text,
        line: key,
        heard: false,
        at: w.at,
        ...(w.p < EXTRA_TRUST ? { unsure: true } : {}),
      });
      continue;
    }
    // A look-alike is Whisper misspelling the LRC word. A different word
    // is either the singer's change ("Tìm" sung as "Gặp") or a mishearing
    // ("quay" for "ngoảnh"); the aligner hears which fits the vocal.
    if (similarity(ref[o.a], w.text) > 0)
      out.push({ text: ref[o.a], line: key, heard: true, at: w.at });
    else if (w.p >= TRUST)
      out.push({
        text: w.text,
        line: key,
        heard: true,
        alt: ref[o.a],
        at: w.at,
      });
    else
      out.push({
        text: ref[o.a],
        line: key,
        heard: true,
        alt: w.text,
        at: w.at,
      });
  }
  return out;
}

/** Runner-up LRC lines this close to the best match are offered as alternatives. */
const LINE_RIVAL = 0.45;
const MAX_RIVALS = 2;

/** Turn "LRC word skipped" next to "Whisper word added" into one substitution. */
function pairUp(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (
      last &&
      last.a !== null &&
      last.b === null &&
      o.a === null &&
      o.b !== null
    )
      last.b = o.b;
    else if (
      last &&
      last.a === null &&
      last.b !== null &&
      o.a !== null &&
      o.b === null
    )
      last.a = o.a;
    else out.push({ ...o });
  }
  return out;
}

/** Share of words two lines have in common (Dice), and their alignment. */
function lineMatch(
  ref: string[],
  words: string[],
): { score: number; ops: Op[] } {
  const ops = alignWords(ref, words);
  const same = ops.filter(
    (o) =>
      o.a !== null && o.b !== null && similarity(ref[o.a], words[o.b]) >= 0.5,
  ).length;
  return { score: (2 * same) / (ref.length + words.length), ops };
}

/** Words this close together, many in a row, are faster than anyone sings a ballad… */
const RUSHED_GAP = 0.22;
const RUSHED_RUN = 6;
/** …and the burst they belong to ends at a gap this long. */
const BURST_GAP = 0.45;

/** Words heard just before a burst that it may be repeating. */
const REPEAT_LOOKBACK = 80;

/**
 * Whether words `a..=b` of `all` mostly repeat the words heard just before
 * them: at least half their three-word runs already appear there.
 */
function repeatsEarlier(all: string[], a: number, b: number): boolean {
  const before = all.slice(Math.max(0, a - REPEAT_LOOKBACK), a);
  const seen = new Set<string>();
  for (let k = 0; k + 2 < before.length; k++)
    seen.add(before.slice(k, k + 3).join(" "));
  let runs = 0;
  let repeated = 0;
  for (let k = a; k + 2 <= b; k++) {
    runs++;
    if (seen.has(all.slice(k, k + 3).join(" "))) repeated++;
  }
  return runs > 0 && repeated * 2 >= runs;
}

/**
 * Drop Whisper's repeat hallucinations: when a line just sung leaks into the
 * next stretch, it comes out as a dozen words crammed into a second or two
 * (e.g. 12 words in 2 s, 0.13 s apart). Such a burst, when it repeats words
 * heard just before, is removed whole with the words glued to it. (Rap runs
 * at 0.2 s a word too, but with new words: it stays.)
 */
export function dropRushed(heard: HeardLine[]): HeardLine[] {
  // Every word heard so far, to tell a repeat from new words sung fast.
  const all = heard.flatMap((l) => l.words.map((w) => key(w.text)));
  let base = 0;
  return heard
    .map((line) => {
      const ws = line.words;
      const from = base;
      base += ws.length;
      const drop = new Array<boolean>(ws.length).fill(false);
      for (let i = 0; i < ws.length;) {
        let j = i;
        while (j + 1 < ws.length && ws[j + 1].start - ws[j].start <= RUSHED_GAP)
          j++;
        // Rap is this fast too: only a burst repeating what was just heard
        // is the hallucination; new words sung fast stay.
        if (
          j - i + 1 >= RUSHED_RUN &&
          repeatsEarlier(all, from + i, from + j)
        ) {
          let a = i;
          let b = j;
          // At most two glued words each side, so real singing next to the
          // burst survives.
          while (
            a > 0 &&
            i - a < 2 &&
            ws[a].start - ws[a - 1].start < BURST_GAP
          )
            a--;
          while (
            b + 1 < ws.length &&
            b - j < 2 &&
            ws[b + 1].start - ws[b].start < BURST_GAP
          )
            b++;
          for (let k = a; k <= b; k++) drop[k] = true;
          j = b;
        }
        i = j + 1;
      }
      const words = ws.filter((_, k) => !drop[k]);
      return words.length === ws.length ? line : { ...line, words };
    })
    .filter((line) => line.words.length > 0);
}

/**
 * Drop Whisper's echoes: a phrase heard twice in overlapping segments (the
 * end of a line written again as its own segment: "… về nơi quá khứ" then
 * "Đời quá khứ" over the same seconds). When two segments overlap and the
 * sure words of one are a run of the other's, the shorter one goes.
 */
export function dropEchoes(heard: HeardLine[]): HeardLine[] {
  const sure = (l: HeardLine) =>
    l.words.filter((w) => w.p >= 0.4).map((w) => key(w.text));
  const within = (a: string[], b: string[]) =>
    a.length > 0 && b.some((_, i) => a.every((t, k) => b[i + k] === t));
  const drop = new Set<number>();
  for (let i = 1; i < heard.length; i++) {
    const [a, b] = [heard[i - 1], heard[i]];
    if (drop.has(i - 1) || b.start > a.end - 0.2) continue;
    const [sa, sb] = [sure(a), sure(b)];
    if (sb.length <= sa.length && within(sb, sa)) drop.add(i);
    else if (within(sa, sb)) drop.add(i - 1);
  }
  return heard.filter((_, i) => !drop.has(i));
}

/**
 * Lines to sing: what Whisper heard, cut into the LRC lines it matches
 * (choruses repeat, so any line may match anywhere), spelt as the LRC
 * spells them except where the singer clearly sings another word.
 */
/** How well the published lyrics matched what Whisper heard. */
export interface MergeReport {
  /** Share of the distinct published lines Whisper was heard singing (0–1). */
  agreement: number;
  /** The published lyrics looked like another song, so Whisper's words were used. */
  replaced: boolean;
}

/** Whisper is clear enough to stand in for lyrics that look wrong. */
const CLEAR_WORDS = 30;
const CLEAR_P = 0.6;

export function mergeLyrics(
  lrc: Line[] | null,
  heard: HeardLine[],
  report?: MergeReport,
): MergedLine[] {
  const B: Hw[] = heard.flatMap((l, seg) =>
    l.words.map((w) => ({
      text: w.text,
      p: w.p,
      seg,
      at: [w.start, w.end] as [number, number],
    })),
  );
  // No published lyrics: Whisper's words are all there is. Words it was
  // unsure of stay, marked, so the singer can see where to correct.
  if (!lrc?.length) {
    // A long phrase Whisper wrote as one segment: a new line at each
    // capitalised word (where it starts a sentence), once a line has a few words.
    let sub = 0;
    let run = 0;
    return withRepeatAlts(
      toLines(
        B.map((w, i) => {
          if (i > 0 && B[i - 1].seg !== w.seg) {
            sub = 0;
            run = 0;
          } else if (run >= 4 && /^\p{Lu}/u.test(w.text)) {
            sub++;
            run = 0;
          }
          run++;
          return {
            text: w.text,
            line: `h${w.seg}.${sub}`,
            heard: true,
            at: w.at,
            unsure: w.p < 0.4,
          };
        }),
      ),
    );
  }
  if (!B.length) return lrc;
  const allRefs = lrc.map((l) => l.words.map((w) => w.text));
  // Choruses repeat in the LRC; match against each distinct line once.
  const byText = new Map<string, number>();
  const refs: string[][] = [];
  const uniqOf = allRefs.map((r) => {
    const t = r.join(" ").toLowerCase();
    if (!byText.has(t)) byText.set(t, refs.push(r) - 1);
    return byText.get(t)!;
  });
  const texts = B.map((w) => w.text);
  const m = B.length;

  // Partition Whisper's words into matched LRC lines and unmatched words,
  // maximising matched words weighted by match quality.
  /** Words `from`.. matched to LRC line `line` (-1: one unmatched word). */
  type Step = { from: number; line: number; ops?: Op[] };
  const best = new Float64Array(m + 1).fill(-Infinity);
  const step: Step[] = new Array(m + 1);
  best[0] = 0;
  for (let j = 0; j < m; j++) {
    if (best[j] === -Infinity) continue;
    // Leaving a word out of every line costs a little, so a line keeps its
    // first word even when the singer changed it ("Gặp" for "Tìm").
    if (best[j] - 0.1 > best[j + 1])
      ((best[j + 1] = best[j] - 0.1), (step[j + 1] = { from: j, line: -1 }));
    refs.forEach((ref, li) => {
      for (
        let k = j + Math.max(1, ref.length - 4);
        k <= Math.min(m, j + ref.length + 4);
        k++
      ) {
        const { score, ops } = lineMatch(ref, texts.slice(j, k));
        if (score < 0.5) continue;
        // Credit no more words than the LRC line has: a stray word tacked on
        // the end must not pay off (it belongs to the next line).
        const gain = best[j] + score * Math.min(k - j, ref.length);
        if (gain > best[k])
          ((best[k] = gain), (step[k] = { from: j, line: li, ops }));
      }
    });
  }
  const parts: Step[] = [];
  for (let k = m; k > 0; k = step[k].from) parts.push(step[k]);
  parts.reverse();
  const matched = parts.filter((p) => p.line >= 0);
  const covered = new Set(matched.map((p) => p.line)).size;
  if (report) report.agreement = covered / refs.length;
  if (covered < refs.length * MIN_AGREEMENT) {
    // Hardly any published line was sung. If Whisper heard the singer
    // clearly, the lyrics are most likely another song's: forcing them onto
    // this vocal would be wrong everywhere, so what was heard is used.
    const meanP = B.reduce((a, w) => a + w.p, 0) / B.length;
    if (B.length >= CLEAR_WORDS && meanP >= CLEAR_P) {
      if (report) report.replaced = true;
      return mergeLyrics(null, heard);
    }
    return lrc;
  }

  const out: Out[] = [];
  parts.forEach((part, i) => {
    if (part.line < 0) {
      // Not in the published lyrics: something the singer adds, or Whisper
      // inventing. Kept (marked when doubtful) for the singer to correct.
      const w = B[part.from];
      out.push({
        text: w.text,
        line: `h${w.seg}`,
        heard: false,
        at: w.at,
        ...(w.p < EXTRA_TRUST ? { unsure: true } : {}),
      });
      return;
    }
    const key = `p${i}`;
    const seg = B.slice(
      part.from,
      part.from + part.ops!.filter((o) => o.b !== null).length,
    );
    const words = lineWords(refs[part.line], seg, part.ops!, key);
    // Whisper sometimes repeats the line before instead of what is sung:
    // a different LRC line matching nearly as well is the alternative.
    const segText = seg.map((w) => w.text);
    const mine = lineMatch(refs[part.line], segText).score;
    const seen = new Set([
      words
        .map((w) => w.text)
        .join(" ")
        .toLowerCase(),
    ]);
    const rivals = refs
      .map((ref, li) => ({ li, ...lineMatch(ref, segText) }))
      .filter(
        (r) =>
          r.li !== part.line && r.score >= 0.5 && mine - r.score <= LINE_RIVAL,
      )
      .sort((a, b) => b.score - a.score)
      .map((r) => lineWords(refs[r.li], seg, r.ops, key))
      .filter((ws) => {
        const t = ws
          .map((w) => w.text)
          .join(" ")
          .toLowerCase();
        return !seen.has(t) && seen.add(t);
      })
      .slice(0, MAX_RIVALS);
    if (rivals.length && words.length) words[0].altLines = rivals;
    out.push(...words);
  });
  // Place each heard line at its occurrence in the LRC's order.
  let prev = -1;
  const order = parts.map((p) => {
    if (p.line < 0) return -1;
    const at = allRefs.map((_, i) => i).filter((i) => uniqOf[i] === p.line);
    prev = at.find((i) => i > prev) ?? at[0];
    return prev;
  });
  return toLines(withMissedLines(out, order, allRefs));
}

/**
 * LRC lines Whisper may have missed: where an LRC line sits between two
 * lines that were heard next to each other in the LRC's order, it is put
 * back unconfirmed (the aligner drops it if nobody sings it).
 */
function withMissedLines(out: Out[], order: number[], refs: string[][]): Out[] {
  const heardLines = order
    .map((line, i) => ({ line, key: `p${i}` }))
    .filter((p) => p.line >= 0);
  const insertAfter = new Map<string, number[]>();
  for (let i = 0; i + 1 < heardLines.length; i++) {
    const [a, b] = [heardLines[i].line, heardLines[i + 1].line];
    // Only small gaps in the LRC's own order: a skipped line or two.
    if (b - a >= 2 && b - a <= 3)
      insertAfter.set(
        heardLines[i].key,
        Array.from({ length: b - a - 1 }, (_, k) => a + 1 + k),
      );
  }
  const res: Out[] = [];
  out.forEach((w, i) => {
    res.push(w);
    const missed = insertAfter.get(w.line);
    if (missed && out[i + 1]?.line !== w.line) {
      for (const li of missed)
        for (const t of refs[li])
          res.push({ text: t, line: `m${li}.${w.line}`, heard: false });
    }
  });
  return res;
}

/** Word-level edit distance (insertions, deletions, substitutions). */
function wordEdits(a: string[], b: string[]): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return row[b.length];
}

/** Most other versions of a repeated line offered to the aligner. */
const MAX_REPEAT_ALTS = 3;

/**
 * A chorus is sung several times, and Whisper hears each time a little
 * differently: a word missed once ("chẳng quay lại"), heard the next time
 * ("chẳng quay ngoài lại"), or misspelt ("hiếm" for "hiểu"). Each line gets
 * the other versions of itself as alternatives; the aligner keeps whichever
 * the vocal there fits best.
 */
function withRepeatAlts(lines: MergedLine[]): MergedLine[] {
  const keys = lines.map((l) => l.words.map((w) => key(w.text)));
  return lines.map((l, i) => {
    const mine = keys[i];
    if (mine.length < 4 || l.alts) return l;
    const seen = new Set([mine.join(" ")]);
    const alts: MergedWord[][] = [];
    lines.forEach((o, j) => {
      const theirs = keys[j];
      const text = theirs.join(" ");
      if (
        j === i ||
        // Only versions with as many words or more: a word is never taken away.
        theirs.length < mine.length ||
        seen.has(text) ||
        alts.length >= MAX_REPEAT_ALTS
      )
        return;
      const edits = wordEdits(mine, theirs);
      if (edits > 2 || edits > Math.max(mine.length, theirs.length) / 3) return;
      seen.add(text);
      alts.push(
        o.words.map((w) => ({
          text: w.text,
          start: 0,
          end: 0,
          ...(w.unsure ? { unsure: true } : {}),
        })),
      );
    });
    return alts.length ? { ...l, alts, repeats: true } : l;
  });
}

/** Consecutive words with the same line key become one untimed line. */
function toLines(words: Out[]): MergedLine[] {
  const toWord = (w: Out): MergedWord => {
    const word: MergedWord = { text: w.text, start: 0, end: 0 };
    if (!w.heard) word.heard = false;
    if (w.alt) word.alt = w.alt;
    if (w.unsure) word.unsure = true;
    return word;
  };
  const lines: MergedLine[] = [];
  let key = "";
  for (const w of words) {
    if (w.line !== key || !lines.length) {
      lines.push({ start: 0, end: 0, next: 0, text: "", words: [] });
      key = w.line;
      if (w.altLines)
        lines[lines.length - 1].alts = w.altLines.map((l) => l.map(toWord));
    }
    const line = lines[lines.length - 1];
    line.words.push(toWord(w));
    // Where Whisper heard the line: keeps the aligner from wandering off.
    if (w.at)
      line.heardAt = line.heardAt
        ? [
            Math.min(line.heardAt[0], w.at[0]),
            Math.max(line.heardAt[1], w.at[1]),
          ]
        : [w.at[0], w.at[1]];
  }
  for (const l of lines) l.text = l.words.map((w) => w.text).join(" ");
  return lines;
}
