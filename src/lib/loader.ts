import {
  api,
  errorText,
  onAlignProgress,
  onSeparateDone,
  onTranscribeProgress,
  onSeparateError,
  onSeparateProgress,
  onVideoProgress,
  type HeardLine,
  type Lyrics,
  type SeparateProgress,
  type SongInfo,
  type SongMeta,
  type Video,
  type WordTime,
  type BackingStyle,
} from "./api";
import {
  alternatives,
  chooseVariants,
  estimateLyricOffset,
  linesFromPlain,
  retime,
  spokenForm,
  variantCount,
  withHums,
} from "./align";
import { libraryEntry, saveToLibrary, withFixes, type LyricIssue, type LyricsPick, type SongParts } from "./library";
import {
  dropEchoes,
  dropRushed,
  mergeLyrics,
  type MergedLine,
  type MergeReport,
} from "./lyricsMerge";
import { parseLrc, type Line } from "./lrc";
import { mod12, SCALE_MAJOR, SCALE_MINOR } from "./music";
import { DEFAULT_PARAMS } from "./presets";
import { leadParts, lineSingers, normalizeParts, savedSegments, type Singer } from "./parts";
import { rankOriginals, type Ranked } from "./sources";
import { resetPitchTrail, useStore, type SongState } from "./store";

let loadToken = 0;
const isCurrent = (token: number) => token === loadToken;

const st = () => useStore.getState();

/** Seconds of separated audio to have ready before singing can start. */
const HEAD_START = 30;

function applySongKey(info: SongInfo) {
  const song = st().song;
  if (!info.key || (song && !song.keyAuto)) return;
  st().setParams({
    tune_key: mod12(info.key.tonic + Math.round(info.semitones)),
    tune_scale: info.key.minor ? SCALE_MINOR : SCALE_MAJOR,
  });
}

async function settle<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/**
 * How much audio must be separated before playback can start without ever
 * catching up with the separator. On fast machines that is the fixed head
 * start; on slow ones (separating slower than real time) it grows so the
 * rest of the song finishes before the singer gets there.
 */
export function startThreshold(p: SeparateProgress, duration: number): number {
  const speed = Math.max(p.speed, 0.05);
  const needed =
    speed >= 1.2 ? HEAD_START : duration * (1 - speed / 1.2) + HEAD_START;
  return Math.min(duration, needed);
}

let alignedFor = 0;

/** Bump when the alignment pipeline changes so cached results are redone. */
export const ALIGN_VERSION = 14;

/**
 * Once the separated vocal and the lyrics are both in: use this
 * recording's singer-fitted lyrics if they were prepared before, otherwise
 * shift the whole file onto the recording (instant). Fitting the lyrics to
 * the singer is heavy, so it only runs when asked (`startLyrics`).
 */
async function autoAlign(token: number) {
  const song = st().song;
  const ly = song?.lyrics;
  if (
    !isCurrent(token) ||
    alignedFor === token ||
    !song?.info ||
    song.info.separating ||
    song.info.vocalRemoved
  )
    return;
  // Reopened while its fit still runs (queued, so no events yet): say so.
  if (song.sourceId && preparing.has(song.sourceId) && !stopped.has(song.sourceId) && !song.aligning)
    st().patchSong({ aligning: { stage: "queue", fraction: 0 } });
  if (!ly || ly.status === "loading" || ly.instrumental || !song.sourceId)
    return;
  alignedFor = token;
  const cached = libraryEntry(song.meta.id)?.aligned;
  if (
    cached &&
    cached.sourceId === song.sourceId &&
    cached.v === ALIGN_VERSION
  ) {
    st().patchSong({
      lyrics: {
        ...ly,
        status: "ready",
        lines: withFixes(song.meta.id, cached.lines),
      },
      userOffset: 0,
    });
    return;
  }
  if (ly.lines) await shiftWhole(token, ly.lines);
}

/** Whether a song's lyrics have been fitted to its current recording. */
export function lyricsFitted(songId: string): boolean {
  const e = libraryEntry(songId);
  return (
    !!e?.sourceId &&
    e.aligned?.sourceId === e.sourceId &&
    e.aligned.v === ALIGN_VERSION
  );
}

/**
 * Lyrics fetched for a song before its library entry exists (the entry is
 * created once the recording is chosen and separating), so they still
 * reach the entry and the first fit uses them.
 */
const fetchedLyrics = new Map<string, Lyrics>();
const pickedLyrics = new Map<string, LyricsPick>();

const lyricsQueries = new Map<string, { title: string; artist: string }>();

/** Remember the title and artist the user searched lyrics under. */
export function rememberLyricsSearch(songId: string, title: string, artist: string) {
  const q = { title: title.trim(), artist: artist.trim() };
  lyricsQueries.set(songId, q);
  saveToLibrary(songId, { lyricsQuery: q });
}

/** The title and artist to search lyrics under: the user's last search, else the song's. */
export function lyricsSearch(songId: string): { title: string; artist: string } | null {
  const e = libraryEntry(songId);
  const pick = e?.lyricsPick ?? pickedLyrics.get(songId);
  return e?.lyricsQuery ?? lyricsQueries.get(songId) ?? (pick ? { title: pick.title, artist: pick.artist } : null);
}

/** The lyrics the user chose for a song, if they chose any. */
export function lyricsPick(songId: string): LyricsPick | null {
  return libraryEntry(songId)?.lyricsPick ?? pickedLyrics.get(songId) ?? null;
}

/** Recordings whose progress a listener already follows. */
const watching = new Set<string>();
/** Recordings to fit again once their stopped run has ended. */
const restartWanted = new Set<string>();

/** Recordings the user stopped, so their pipeline ends quietly. */
const stopped = new Set<string>();

/**
 * Fit a song's lyrics to its singer: queued behind songs started earlier,
 * and carried on even if the song is closed. The open song shows progress
 * and gets the lyrics when they are ready.
 */
/** How to fit: the aligner alone (fast, the default), or Whisper hearing the whole song first. */
export type FitMode = "fast" | "whisper";

export function startLyrics(songId: string, mode: FitMode = "fast") {
  const entry = libraryEntry(songId);
  const sourceId = entry?.sourceId;
  if (!sourceId) return;
  const isOpen = st().song?.sourceId === sourceId;
  const running = preparing.get(sourceId);
  if (running && stopped.has(sourceId)) {
    // Stopped, but its current step hasn't ended yet (Whisper notices
    // between chunks): start again as soon as it has.
    restartWanted.add(sourceId);
    if (isOpen) st().patchSong({ aligning: { stage: "queue", fraction: 0 } });
    // After every callback on the old run (its listener's clean-up too).
    void running.finally(() =>
      setTimeout(() => {
        if (restartWanted.delete(sourceId)) startLyrics(songId, mode);
      }),
    );
    return;
  }
  if (!running) {
    stopped.delete(sourceId);
    const l = entry.lyrics ?? fetchedLyrics.get(songId) ?? null;
    const published = l?.synced
      ? parseLrc(l.synced)
      : l?.plain
        ? linesFromPlain(l.plain)
        : null;
    prepareLyrics(songId, sourceId, published, mode);
  }
  // Until this recording's turn comes the backend sends nothing: "queue".
  if (isOpen) st().patchSong({ aligning: { stage: "queue", fraction: 0 } });
  // Already followed (a second click, or the song reopened): the earlier
  // listener still updates whichever song is open.
  if (watching.has(sourceId)) return;
  watching.add(sourceId);
  const name =
    st().history.find((m) => m.id === songId)?.title ??
    (isOpen ? st().song?.meta.title : undefined) ??
    "bài hát";
  const open = () => {
    const s = st().song;
    return s?.sourceId === sourceId ? s : null;
  };
  const show =
    (stage: "listen" | "time") => (source: string, fraction: number) => {
      if (source === sourceId && open() && !stopped.has(sourceId))
        st().patchSong({ aligning: { stage, fraction } });
    };
  const unlisten = [
    onTranscribeProgress(show("listen")),
    onAlignProgress(show("time")),
  ];
  void preparing
    .get(sourceId)!
    .then(({ lines: timed, error, warning }) => {
      const s = open();
      if (warning) st().toast(`${name}: ${warning}`, "error");
      if (timed && s) {
        // The new times are absolute, so an earlier nudge no longer applies.
        st().patchSong({
          aligning: null,
          lyrics: {
            ...s.lyrics,
            status: "ready",
            lines: withFixes(songId, timed),
          },
          userOffset: 0,
        });
        st().toast("Lời đã khớp theo giọng ca sĩ, từng chữ.", "success");
      } else if (timed) {
        st().toast(`Đã khớp xong lời "${name}".`, "success");
      } else {
        if (s && !restartWanted.has(sourceId)) st().patchSong({ aligning: null });
        if (error && error !== "cancelled")
          st().toast(`Không khớp được lời "${name}": ${error}`, "error");
      }
    })
    .finally(() => {
      watching.delete(sourceId);
      for (const u of unlisten) void u.then((f) => f());
    });
}

/** Stop fitting a song's lyrics (queued or running), so other songs go first. */
export function stopLyrics(songId: string) {
  const sourceId = libraryEntry(songId)?.sourceId;
  if (!sourceId) return;
  stopped.add(sourceId);
  restartWanted.delete(sourceId);
  void api.cancelLyrics(sourceId);
  if (st().song?.sourceId === sourceId) st().patchSong({ aligning: null });
}

const hasLetters = (t: string) => /\p{L}/u.test(t);
const lineWords = (t: string) =>
  t.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}']+/gu) ?? [];

/** The open song's lyrics as text, a line each, corrections applied (stand-in hums left out). */
export function lyricsText(): string {
  const ly = st().song?.lyrics;
  if (!ly) return "";
  if (ly.lines)
    return ly.lines
      .map((l) => l.words.map((w) => w.text).join(" "))
      .filter(hasLetters)
      .join("\n");
  return ly.plain ?? "";
}

/** Share of words two lines have in common, in order (0–1). */
function lineLikeness(a: string, b: string): number {
  const [x, y] = [lineWords(a), lineWords(b)];
  if (!x.length || !y.length) return 0;
  let prev = new Array(y.length + 1).fill(0);
  for (const w of x) {
    const cur = [0];
    for (let j = 1; j <= y.length; j++)
      cur[j] = w === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return (2 * prev[y.length]) / (x.length + y.length);
}

const lrcTime = (t: number) => {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, "0")}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
};

/**
 * Lyrics the user edited or wrote. Lines kept from the current lyrics keep
 * their time, and new ones get one between their neighbours, so the result
 * is LRC and still guides the aligner; without any timed line, plain text.
 */
export function editedLyrics(text: string): Lyrics {
  const typed = text
    .split(/\r?\n/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(hasLetters);
  const old = (st().song?.lyrics.lines ?? []).filter(
    (l) => hasLetters(l.text) && l.start > 0,
  );
  // Each typed line to the next current line it resembles, in order.
  let at = 0;
  const times: (number | null)[] = typed.map((t) => {
    for (let i = at; i < Math.min(old.length, at + 6); i++)
      if (lineLikeness(t, old[i].words.map((w) => w.text).join(" ")) >= 0.6) {
        at = i + 1;
        return old[i].start;
      }
    return null;
  });
  const known = times.flatMap((t, i) => (t === null ? [] : [i]));
  if (!typed.length || !known.length)
    return { synced: null, plain: typed.join("\n") || null, instrumental: false };
  // New lines: evenly between the timed lines around them (3 s apart at the ends).
  const filled = times.map((t, i) => {
    if (t !== null) return t;
    const a = [...known].reverse().find((k) => k < i);
    const b = known.find((k) => k > i);
    if (a === undefined) return times[b!]! - 3 * (b! - i);
    if (b === undefined) return times[a]! + 3 * (i - a);
    return times[a]! + ((times[b]! - times[a]!) * (i - a)) / (b - a);
  });
  for (let i = 1; i < filled.length; i++)
    filled[i] = Math.max(filled[i], filled[i - 1] + 0.05);
  const lrc = typed.map((t, i) => `[${lrcTime(Math.max(0, filled[i]))}] ${t}`);
  return { synced: lrc.join("\n"), plain: null, instrumental: false };
}

/** Fit the open song again to its lyrics as corrected (word fixes and deleted lines folded in). */
export function refitWithFixes(): boolean {
  const song = st().song;
  if (!song) return false;
  const q = lyricsSearch(song.meta.id);
  return replaceLyrics(
    editedLyrics(lyricsText()),
    { label: "lời bạn đã sửa", title: q?.title ?? song.meta.title, artist: q?.artist ?? song.meta.artist },
    true,
  );
}

/** Whether the open song has word fixes or deleted lines not yet fitted again. */
export function hasFixes(): boolean {
  const id = st().song?.meta.id;
  return !!id && Object.keys(libraryEntry(id)?.fixes ?? {}).length > 0;
}

/** Whether the open song's lyrics are being fitted right now (they can't be swapped then). */
export function lyricsBusy(): boolean {
  const id = st().song?.sourceId;
  return !!id && preparing.has(id) && !stopped.has(id);
}

/**
 * Use lyrics the user picked or pasted for the open song: forget the old
 * fit, place them on the recording, and fit them to the singer again.
 */
export function replaceLyrics(
  l: Lyrics,
  pick: LyricsPick,
  /** The lyrics already include the user's word fixes: drop them. */
  clearFixes = false,
): boolean {
  const song = st().song;
  if (!song) return false;
  if (lyricsBusy()) {
    st().toast(
      "Đang khớp lời theo lời cũ. Bấm dừng khớp lời rồi chọn lại.",
      "error",
    );
    return false;
  }
  const id = song.meta.id;
  fetchedLyrics.set(id, l);
  pickedLyrics.set(id, pick);
  // Before the recording is chosen there is no entry yet: `buildFrom`
  // stores both when it creates it.
  saveToLibrary(id, {
    lyrics: l,
    lyricsPick: pick,
    aligned: undefined,
    ...(clearFixes ? { fixes: {} } : {}),
  });
  const lines = l.synced ? withFixes(id, parseLrc(l.synced)) : null;
  st().patchSong({
    lyrics: {
      status: lines?.length || l.plain || l.instrumental ? "ready" : "missing",
      lines: lines?.length ? lines : null,
      plain: l.plain,
      instrumental: l.instrumental,
    },
    userOffset: 0,
  });
  alignedFor = 0;
  void autoAlign(loadToken);
  const info = song.info;
  if (song.sourceId && info && !info.separating && !info.vocalRemoved && !l.instrumental)
    startLyrics(id);
  st().toast(`Đã lưu lời: ${pick.label}`, "success");
  return true;
}

/** A finished fit: the timed lines, or why there are none, and anything to warn about. */
interface Prepared {
  lines: Line[] | null;
  error: string | null;
  warning: string | null;
}

/** Lyrics being prepared, per recording: one pipeline each, however often the song is opened. */
const preparing = new Map<string, Promise<Prepared>>();

/**
 * Listen to the singer, merge with the published lyrics, time every word,
 * and keep the result in the library. It runs to the end even if the song
 * is closed (the backend takes recordings one at a time, in order), so the
 * lyrics are ready next time; it ends between steps once stopped.
 */
function prepareLyrics(
  songId: string,
  sourceId: string,
  published: Line[] | null,
  mode: FitMode = "fast",
): Promise<Prepared> {
  let job = preparing.get(sourceId);
  if (!job) {
    const halt = () => {
      if (stopped.has(sourceId)) throw "cancelled";
    };
    job = (async (): Promise<Prepared> => {
      const warnings: string[] = [];
      try {
        // Whisper hears the singer and merges what it heard with the lyrics.
        const hear = async () => {
          const { heard: raw, error } = await listen(sourceId, published);
          halt();
          if (error)
            warnings.push(
              published?.length
                ? `AI không nghe được giọng ca sĩ (${error}), nên chỉ canh theo lời có sẵn.`
                : `AI không nghe được giọng ca sĩ: ${error}`,
            );
          const heard = dropEchoes(dropRushed(raw ?? []));
          const report: MergeReport = { agreement: 1, replaced: false };
          const lines = heard.length ? mergeLyrics(published, heard, report) : published;
          if (published?.length && heard.length && report.agreement < 0.35) {
            const pct = Math.round(report.agreement * 100);
            warnings.push(
              report.replaced
                ? `lời tìm được có vẻ là bài khác (AI chỉ nghe thấy ${pct}% số dòng), nên dùng lời AI nghe ra. Chọn lại lời đúng ở tab Bài hát → Lời bài hát.`
                : `lời có vẻ không khớp bản thu này (AI chỉ nghe thấy ${pct}% số dòng). Kiểm tra lại ở tab Bài hát → Lời bài hát.`,
            );
          }
          return { lines, error };
        };
        // With published lyrics the words are known: only their timing is
        // needed, which the aligner (MMS) finds on its own, far lighter than
        // having Whisper hear the whole song. Whisper is for songs without
        // lyrics, and for lyrics the vocal doesn't fit.
        // Whisper only when asked for (or when there are no lyrics to time:
        // then hearing the singer is the only way to get any).
        const listened = mode === "whisper" || !published?.length;
        const { lines, error: heardError } = listened
          ? await hear()
          : { lines: published, error: null as string | null };
        if (!lines?.length)
          return { lines: null, error: heardError ?? "không có lời để canh", warning: null };
        const fit = { score: 0, unsung: false, lineScores: [] as number[] };
        const words = await timeWords(sourceId, lines, fit);
        halt();
        if (!listened && fit.score < MISFIT_SCORE)
          warnings.push(
            "lời có vẻ không khớp giọng hát (AI canh được rất ít chữ). Kiểm tra lại lời ở tab Bài hát → Lời bài hát, hoặc thử “Khớp kỹ (Whisper)”.",
          );
        // Lines the aligner could hardly find: shown for the user to check.
        const issues: LyricIssue[] = [];
        if (words)
          lines.forEach((l, i) => {
            const sc = fit.lineScores[i];
            // Same lines in the same order (the fast fit drops none); a chorus
            // repeats, so match by position, by text only as a fallback.
            const placed = words.length === lines.length ? words[i] : words.find((w) => w.text === l.text);
            if (sc !== undefined && sc < DOUBT_SCORE && placed)
              issues.push({ text: placed.text, start: placed.start, score: Math.round(sc * 100) / 100 });
          });
        if (issues.length)
          warnings.push(
            `${issues.length} dòng có thể canh sai (đánh dấu ⚠). Xem ở tab Bài hát → Dòng cần kiểm tra; sửa lời hoặc thử “Khớp kỹ (Whisper)”.`,
          );
        const warning = warnings.join(" ") || null;
        // Where the melody shows singing but no words were heard: a stand-in.
        const timed =
          words &&
          withHums(words, await api.melodyNotes(sourceId).catch(() => null));
        halt();
        if (timed)
          saveToLibrary(songId, {
            aligned: { sourceId, lines: timed, v: ALIGN_VERSION, issues },
          });
        return { lines: timed, error: timed ? null : "canh thời gian thất bại", warning };
      } catch (e) {
        const error = errorText(e);
        if (error !== "cancelled") console.warn("Lyrics alignment failed:", error);
        return { lines: null, error, warning: null };
      }
    })().finally(() => preparing.delete(sourceId));
    preparing.set(sourceId, job);
  }
  return job;
}

/** Letters only Vietnamese uses among Latin-script languages. */
const VI_LETTERS =
  /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

/**
 * The language Whisper should hear: "vi" (which also picks the Vietnamese
 * lyrics model) unless the published lyrics are plainly another language,
 * then null for Whisper to detect it. Without lyrics: Vietnamese, as before.
 */
export function lyricLanguage(published: Line[] | null): "vi" | null {
  if (!published?.length) return "vi";
  const words = published.flatMap((l) => l.text.split(/\s+/)).filter(Boolean);
  const vi = words.filter((w) => VI_LETTERS.test(w)).length;
  return vi >= words.length * 0.15 ? "vi" : null;
}

/** What the singer actually sings (Whisper), or why it couldn't run. */
async function listen(
  sourceId: string,
  published: Line[] | null,
): Promise<{ heard: HeardLine[] | null; error: string | null }> {
  try {
    // Each distinct published line once: Whisper then knows the song's
    // words, which stops it inventing text over the singing.
    const prompt = published
      ? [...new Set(published.map((l) => l.text))].join(". ")
      : null;
    const heard = await api.transcribeVocal(sourceId, prompt, lyricLanguage(published));
    return { heard, error: null };
  } catch (e) {
    // Stopped by the user: end the whole pipeline, not just this step.
    if (errorText(e) === "cancelled") throw e;
    console.warn("Speech recognition failed:", errorText(e));
    return { heard: null, error: errorText(e) };
  }
}

/**
 * Below this median line score (mean log-probability of a line's letters)
 * the vocal doesn't fit the lyrics. Measured on one song: its own lyrics
 * -0.74, another song's under the same title -3.96.
 */
const MISFIT_SCORE = -2;

/**
 * A line scoring below this wasn't really found in the vocal. One alone is
 * often a tag or a hum ("(Hey, Kewtiie)", "Uhm-mm", still placed right);
 * two in a row are a passage this recording doesn't sing (a cover dropping
 * a verse: -6.9 to -8.7), which only hearing the singer can sort out.
 */
const UNSUNG_SCORE = -5;

/** A fitted line scoring below this is reported for the user to check. */
const DOUBT_SCORE = -3;

/** The open song's doubtful lines from its last fit (for the ⚠ marks and the list). */
export function lyricIssues(songId: string): LyricIssue[] {
  return libraryEntry(songId)?.aligned?.issues ?? [];
}

/** Whether two lines in a row score below `UNSUNG_SCORE`. */
function unsungPassage(times: (WordTime | null)[][]): boolean {
  const low = times.map((ws) => {
    const placed = ws.filter((w): w is WordTime => !!w);
    return placed.length > 0 && placed.reduce((a, w) => a + w.score, 0) / placed.length < UNSUNG_SCORE;
  });
  return low.some((l, i) => l && low[i + 1]);
}

/** The median over lines of each line's mean word score (0 = clearly sung). */
function medianLineScore(times: (WordTime | null)[][]): number {
  const lines = times
    .map((ws) => ws.filter((w): w is WordTime => !!w))
    .filter((ws) => ws.length)
    .map((ws) => ws.reduce((a, w) => a + w.score, 0) / ws.length)
    .sort((a, b) => a - b);
  return lines.length ? lines[Math.floor(lines.length / 2)] : -Infinity;
}

/** Word-level timing from the MMS aligner, choosing between disputed versions. */
async function timeWords(
  sourceId: string,
  lines: Line[],
  fit?: { score: number; unsung: boolean; lineScores: number[] },
): Promise<Line[] | null> {
  // Where Whisper heard each line (none for lines it didn't hear).
  const windows = (lines as MergedLine[]).map((l) => l.heardAt ?? null);
  // Published line times (LRC), when the lines are the published ones.
  const timed = lines.some((l) => l.start > 0);
  const lrc = timed && windows.every((w) => !w) ? lines.map((l) => l.start) : null;
  // Numbers are aligned as they are read out, in the lyrics' language.
  const vietnamese = lyricLanguage(lines) === "vi";
  const align = (texts: string[][]) =>
    api.alignLyrics(
      sourceId,
      texts.map((l) => l.map((w) => spokenForm(w, vietnamese))),
      windows,
      lrc,
    );
  const first = await align(lines.map((l) => l.words.map((w) => w.text)));
  if (fit) {
    fit.score = medianLineScore(first);
    fit.unsung = unsungPassage(first);
    fit.lineScores = first.map((ws) => {
      const placed = ws.filter((w): w is WordTime => !!w);
      return placed.length ? placed.reduce((a, w) => a + w.score, 0) / placed.length : NaN;
    });
  }
  let times = first.flat();
  // Where Whisper and the LRC disagree outright, align the other version
  // too and keep whichever the vocal fits better; then time the result.
  const merged = lines as MergedLine[];
  const variants = variantCount(merged);
  if (variants) {
    const results = [first];
    for (let v = 1; v <= variants; v++)
      results.push(await align(alternatives(merged, v)));
    const chosen = chooseVariants(merged, results);
    if (chosen.changed) {
      lines = chosen.lines;
      times = (
        await align(lines.map((l) => l.words.map((w) => w.text)))
      ).flat();
    }
  }
  return retime(lines, times, lrc);
}

/** Move the whole LRC to where the vocal activity fits best; the applied offset, or null. */
async function shiftWhole(
  token: number,
  lines: Line[],
): Promise<number | null> {
  const env = await api.vocalActivity().catch(() => null);
  const now = st().song;
  if (!env || !isCurrent(token) || !now || now.userOffset !== 0) return null;
  const offset = estimateLyricOffset(env, lines);
  if (offset === null) return null;
  st().patchSong({ userOffset: offset });
  return offset;
}

/** Search for the original → download → AI separation. Lyrics load in parallel. */
export async function openSong(meta: SongMeta) {
  const token = ++loadToken;
  resetPitchTrail();
  await api.pause().catch(() => {});
  const initial: SongState = {
    meta,
    phase: "searching",
    message: "Đang tìm bản thu gốc…",
    progress: 0,
    info: null,
    lyrics: {
      status: "loading",
      lines: null,
      plain: null,
      instrumental: false,
    },
    originals: [],
    sourceId: null,
    sourcePath: null,
    separation: null,
    userOffset: 0,
    aligning: null,
    keyAuto: true,
    busy: null,
  };
  useStore.setState({ song: initial, view: "stage", ended: false, pos: 0 });
  st().pushHistory(meta);

  const saved = libraryEntry(meta.id);
  const showLyrics = (l: Lyrics) => {
    const lines = l.synced ? withFixes(meta.id, parseLrc(l.synced)) : null;
    st().patchSong({
      lyrics: {
        status:
          lines?.length || l.plain || l.instrumental ? "ready" : "missing",
        lines: lines?.length ? lines : null,
        plain: l.plain,
        instrumental: l.instrumental,
      },
    });
    void autoAlign(token);
  };
  if (saved?.lyrics) {
    showLyrics(saved.lyrics);
  } else {
    api
      .getLyrics(meta)
      .then((l) => {
        // The user already picked lyrics by hand: keep theirs.
        if (!isCurrent(token) || pickedLyrics.has(meta.id)) return;
        showLyrics(l);
        fetchedLyrics.set(meta.id, l);
        saveToLibrary(meta.id, { lyrics: l });
      })
      .catch(() => {
        if (!isCurrent(token)) return;
        st().patchSong({
          lyrics: {
            status: "missing",
            lines: null,
            plain: null,
            instrumental: false,
          },
        });
        void autoAlign(token);
      });
  }

  // Sung before: reuse the chosen recording instead of searching again.
  if (saved?.sourceId) {
    st().patchSong({ originals: saved.originals });
    const source = saved.originals.find((r) => r.video.id === saved.sourceId)
      ?.video ?? {
      id: saved.sourceId,
      title: meta.title,
      channel: meta.artist,
      duration: meta.duration,
      views: null,
    };
    const ready = await api
      .stemsCached([saved.sourceId])
      .catch(() => [] as string[]);
    if (!isCurrent(token)) return;
    await buildFrom(source, token, ready.length ? saved.sourcePath : undefined);
    return;
  }

  // Picked from a YouTube search: that video is the recording.
  if (meta.video) {
    const originals = [{ video: meta.video, score: 100 }];
    st().patchSong({ originals });
    saveToLibrary(meta.id, { originals });
    await buildFrom(meta.video, token);
    return;
  }

  const q = `${meta.artist} ${meta.title.replace(/\s*[([].*?[)\]]/g, "")}`;
  const [official, plain] = await Promise.all([
    settle(api.ytSearch(`${q} official audio`, 8)),
    settle(api.ytSearch(`${q} audio`, 6)),
  ]);
  if (!isCurrent(token)) return;
  if (!official && !plain) {
    st().patchSong({
      phase: "error",
      message: "Không kết nối được YouTube. Kiểm tra mạng rồi thử lại.",
    });
    return;
  }
  const originals = rankOriginals(
    [...(official ?? []), ...(plain ?? [])],
    meta,
  );
  st().patchSong({ originals });
  saveToLibrary(meta.id, { originals: originals.slice(0, 6) });
  if (!originals.length) {
    st().patchSong({
      phase: "error",
      message: "Không tìm thấy bản thu nào của bài này.",
    });
    return;
  }
  await buildFrom(originals[0].video, token);
}

/**
 * Prepare `video` as the song's recording. `cachedPath` skips the download
 * when the separated stems are already on disk (the backend then never
 * needs the original file).
 */
async function buildFrom(video: Video, token: number, cachedPath?: string) {
  let path = cachedPath ?? "";
  if (!cachedPath) {
    st().patchSong({
      phase: "downloading",
      message: "Đang tải bản thu gốc…",
      progress: 0,
    });
    try {
      path = await api.ytDownload(video.id);
    } catch (e) {
      if (isCurrent(token))
        st().patchSong({ phase: "error", message: errorText(e) });
      return;
    }
    if (!isCurrent(token)) return;
  }
  st().patchSong({
    phase: "separating",
    message: cachedPath
      ? "Đang mở bài đã tách sẵn…"
      : "Đang tách giọng bằng AI…",
    sourceId: video.id,
    sourcePath: path,
    // Already separated: nothing to track, the stems just load.
    separation: cachedPath
      ? null
      : { job: token, fraction: 0, ready: 0, speed: 0 },
  });
  void loadVideo();
  try {
    // The load token doubles as the job id, so events from a song the user
    // has already left can be recognised and ignored.
    const info = await api.songSeparate(path, video.id, token);
    if (!isCurrent(token)) return;
    const songId = st().song?.meta.id;
    if (songId) {
      const originals = st().song?.originals ?? [];
      const prev = libraryEntry(songId);
      // A pick the user made while the recording was being prepared wins.
      const pick = prev?.lyricsPick ?? pickedLyrics.get(songId);
      const query = prev?.lyricsQuery ?? lyricsQueries.get(songId);
      const lyrics = (pick && fetchedLyrics.get(songId)) || prev?.lyrics || fetchedLyrics.get(songId);
      saveToLibrary(songId, {
        sourceId: video.id,
        sourcePath: path,
        originals: originals.slice(0, 6),
        ...(lyrics ? { lyrics } : {}),
        ...(pick ? { lyricsPick: pick } : {}),
        ...(query ? { lyricsQuery: query } : {}),
      });
    }
    applySongKey(info);
    // Cached songs come back complete; otherwise wait for the head start.
    st().patchSong(
      info.separating ? { info } : { info, phase: "ready", separation: null },
    );
    void autoAlign(token).finally(() => restoreSettings(token));
    void loadMelody(token);
    void applyBacking(token);
  } catch (e) {
    if (!isCurrent(token) || errorText(e) === "superseded") return;
    await fallBackToRemover(path, errorText(e), token);
  }
}

/** Fetch the recording's HD video (picture only) for the background, when wanted. */
export async function loadVideo() {
  const { song, videoBg } = st();
  if (
    !videoBg ||
    !song?.sourceId ||
    song.video?.status === "loading" ||
    song.video?.status === "ready"
  )
    return;
  const id = song.sourceId;
  const mine = () => st().song?.sourceId === id;
  st().patchSong({ video: { status: "loading", progress: 0 } });
  const un = onVideoProgress((p) => {
    if (p.id === id && mine() && st().song?.video?.status === "loading")
      st().patchSong({ video: { status: "loading", progress: p.fraction } });
  });
  try {
    const path = await api.ytDownloadVideo(id);
    if (mine())
      st().patchSong({ video: { status: "ready", path, progress: 1 } });
  } catch (e) {
    if (mine())
      st().patchSong({
        video: { status: "error", progress: 0, message: errorText(e) },
      });
  } finally {
    void un.then((f) => f());
  }
}


/** Told when the harmony is turned on from elsewhere (the parts page), so its controls catch up. */
const backingListeners = new Set<() => void>();
export function onBackingChange(f: () => void): () => void {
  backingListeners.add(f);
  return () => backingListeners.delete(f);
}

/** The open song's automatic harmony (scale steps, empty = off; and its style): each song its own. */
export function backingChoice(): { degrees: number[]; style: BackingStyle } {
  const id = st().song?.meta.id;
  const b = id ? (libraryEntry(id)?.settings?.backing ?? pendingBacking.get(id)) : undefined;
  return { degrees: b?.degrees ?? [], style: b?.style ?? "choir" };
}

/** A harmony chosen before the song's library entry exists (saved with its settings later). */
const pendingBacking = new Map<string, { degrees: number[]; style: BackingStyle }>();

/** Choose the automatic harmony and make it for the open song (a few seconds). */
export async function setBacking(degrees: number[], style: BackingStyle) {
  const id = st().song?.meta.id;
  if (id) {
    pendingBacking.set(id, { degrees, style });
    saveSettings();
  }
  st().patchSong({ busy: degrees.length ? "Đang tạo bè…" : null });
  try {
    await api.songBacking(degrees, style);
    if (degrees.length)
      st().toast(style === "choir" ? "Đã tạo bè hợp xướng theo giai điệu bài." : "Đã tạo bè từ giọng ca sĩ gốc.", "success");
  } catch (e) {
    if (errorText(e) !== "superseded") st().toast(`Không tạo được bè: ${errorText(e)}`, "error");
  } finally {
    st().patchSong({ busy: null });
  }
}

/** The parts chosen for a song (none = harmony on the whole song, no original singer). */
export function songParts(songId: string): SongParts {
  return libraryEntry(songId)?.parts ?? { backing: [], original: [] };
}

/** Who sings each line of the open song's lyrics (duets), as marked in the parts editor. */
export function songSingers(): (Singer | undefined)[] {
  const song = st().song;
  const lines = song?.lyrics.lines ?? [];
  if (!song) return [];
  return lineSingers(lines, songParts(song.meta.id).singers, song.userOffset);
}

/** Choose the open song's parts: kept with the song and applied now. */
export async function setParts(parts: SongParts, lead?: [number, number, number, number, number, number][]) {
  const song = st().song;
  if (!song) return;
  saveToLibrary(song.meta.id, { parts });
  // Overlaps reaching into the user's lines are split by the male/female
  // model the first time: some seconds each.
  const overlaps = (lead ?? []).some(([a, fa, fb, b]) => fa - a > 0.02 || b - fb > 0.02);
  if (overlaps) st().toast("Đang tách hai giọng ở chỗ hát chồng (lần đầu mất khoảng 20 giây mỗi chỗ)…", "info");
  try {
    await api.songParts(parts.backing, lead ?? parts.original.map(([a, b]): [number, number, number, number, number, number] => [a, a, b, b, 0, 0]));
    // Lines marked for harmony with the harmony off: turn it on (a choir a
    // third above), or marking them would do nothing.
    if (parts.backing.length && !backingChoice().degrees.length) {
      st().toast("Đã lưu phân đoạn và bật bè hợp xướng quãng 3 trên. Đổi kiểu bè ở tab Trộn → Bè tự động.", "success");
      await setBacking([2], "choir");
      backingListeners.forEach((f) => f());
      return;
    }
    st().toast("Đã lưu phân đoạn.", "success");
  } catch (e) {
    if (errorText(e) !== "superseded") st().toast(`Không áp dụng được phân đoạn: ${errorText(e)}`, "error");
  }
}

/** Once the separated vocal is in: the song's parts, then the chosen automatic harmony. */
async function applyBacking(token: number) {
  const song = st().song;
  if (song && isCurrent(token) && song.info && !song.info.separating) {
    // Redrawn by the current rules around the lines they cover (older saves
    // could reach into the next line).
    const saved = songParts(song.meta.id);
    const lines = song.lyrics.lines ?? [];
    const parts = {
      original: lines.length
        ? leadParts(savedSegments(lines, saved.original, song.userOffset), saved.adjust?.original, saved.laps)
        : saved.original.map(([a, b]): [number, number, number, number, number, number] => [a, a, b, b, 0, 0]),
      backing: normalizeParts(lines, saved.backing, song.userOffset, saved.adjust?.backing),
    };
    if (parts.backing.length || parts.original.length)
      await api.songParts(parts.backing, parts.original).catch(() => undefined);
  }
  const { degrees, style } = backingChoice();
  if (!degrees.length || !isCurrent(token) || !song?.info || song.info.separating || song.info.vocalRemoved) return;
  // The choir follows the melody: have it first (cached after the first time).
  await api.songBacking(degrees, style).catch(() => undefined);
}

/** Find the original singer's melody (once per recording, then cached) for the note bars. */
async function loadMelody(token: number) {
  const song = st().song;
  if (
    !isCurrent(token) ||
    !song?.sourceId ||
    !song.info ||
    song.info.separating ||
    song.info.vocalRemoved ||
    song.melody
  )
    return;
  const notes = await api.melodyNotes(song.sourceId).catch(() => null);
  if (isCurrent(token) && notes) st().patchSong({ melody: notes });
}

/** Put back the key, tempo, lyric timing and autotune key set for this song last time. */
async function restoreSettings(token: number) {
  const song = st().song;
  if (
    !isCurrent(token) ||
    song?.restored ||
    !song?.info ||
    song.info.separating
  )
    return;
  const s = libraryEntry(song.meta.id)?.settings;
  // Each song has its own mix; a song without one starts from the defaults,
  // not from whatever the last song used.
  st().setParams(Object.fromEntries(SONG_MIX.map((k) => [k, s?.mix?.[k] ?? DEFAULT_PARAMS[k]])));
  if (s) {
    if (s.userOffset) st().patchSong({ userOffset: s.userOffset });
    if (s.trim) st().patchSong({ trim: s.trim });
    if (s.key) {
      st().patchSong({ keyAuto: false });
      st().setParams({ tune_key: s.key.tonic, tune_scale: s.key.scale });
    }
    if (
      s.semitones !== song.info.semitones ||
      Math.abs(s.tempo - song.info.tempo) > 1e-3
    )
      await transform(s.semitones, s.tempo);
  }
  // Kept on the song itself, so a reload of this module can't lose it.
  if (isCurrent(token)) {
    st().patchSong({ restored: true });
    // A harmony chosen before the settings were back: keep it with them.
    if (pendingBacking.has(song.meta.id)) saveSettings();
  }
}

/** Key and tempo just picked but still being rendered (song id, values). */
let wanted: { song: string; semitones: number; tempo: number } | null = null;

/** Save this song's settings as they are now (the key/tempo being rendered counts). */
function saveSettings() {
  const { song, params } = st();
  if (!song?.info || !song.restored) return;
  const w = wanted?.song === song.meta.id ? wanted : null;
  saveToLibrary(song.meta.id, {
    settings: {
      semitones: w?.semitones ?? song.info.semitones,
      tempo: w?.tempo ?? song.info.tempo,
      userOffset: song.userOffset,
      key: song.keyAuto
        ? undefined
        : {
            tonic: Math.round(params.tune_key),
            scale: Math.round(params.tune_scale),
          },
      trim: song.trim,
      mix: Object.fromEntries(SONG_MIX.map((k) => [k, params[k] ?? DEFAULT_PARAMS[k]])),
      backing: pendingBacking.get(song.meta.id) ?? libraryEntry(song.meta.id)?.settings?.backing,
    },
  });
}

/** Levels that belong to a song (its mix), not to the singer's voice. */
const SONG_MIX = ["instrumental", "guide", "backing", "lead"] as const;

/** Remember a key/tempo the moment it is picked, before it has been rendered. */
export function rememberTransform(semitones: number, tempo: number) {
  const id = st().song?.meta.id;
  if (!id) return;
  wanted = { song: id, semitones, tempo };
  saveSettings();
}

// Remember per-song changes (after the saved ones are back in place).
useStore.subscribe((s, prev) => {
  const song = s.song;
  const was = prev.song;
  if (
    !song?.info ||
    !was ||
    song.meta.id !== was.meta.id ||
    !song.restored ||
    !was.restored
  )
    return;
  const changed =
    song.userOffset !== was.userOffset ||
    song.info.semitones !== was.info?.semitones ||
    song.info.tempo !== was.info?.tempo ||
    song.keyAuto !== was.keyAuto ||
    song.trim !== was.trim ||
    SONG_MIX.some((k) => s.params[k] !== prev.params[k]) ||
    (!song.keyAuto &&
      (s.params.tune_key !== prev.params.tune_key ||
        s.params.tune_scale !== prev.params.tune_scale));
  if (changed) saveSettings();
});

/** When the AI can't run, the basic remover still gives a usable track. */
async function fallBackToRemover(path: string, reason: string, token: number) {
  st().toast(
    `Không tách giọng bằng AI được (${reason}). Chuyển sang lọc giọng cơ bản.`,
    "error",
  );
  st().patchSong({
    phase: "separating",
    message: "Đang lọc giọng…",
    separation: null,
  });
  try {
    const info = await api.songVocalRemoval(path);
    if (!isCurrent(token)) return;
    applySongKey(info);
    st().patchSong({ info, phase: "ready" });
  } catch (e) {
    if (isCurrent(token) && errorText(e) !== "superseded")
      st().patchSong({ phase: "error", message: errorText(e) });
  }
}

/** Route separator events to the current song. Call once at startup. */
export function listenForSeparation() {
  const progress = onSeparateProgress((p) => {
    const song = st().song;
    if (p.job !== loadToken || !song?.info?.separating) return;
    const patch: Partial<SongState> = { separation: p };
    if (
      song.phase === "separating" &&
      p.ready >= startThreshold(p, song.info.sourceDuration)
    )
      patch.phase = "ready";
    st().patchSong(patch);
  });
  const done = onSeparateDone(({ job, info }) => {
    const song = st().song;
    if (job !== loadToken || !song) return;
    st().patchSong({
      info,
      separation: null,
      phase: song.phase === "separating" ? "ready" : song.phase,
    });
    void autoAlign(job).finally(() => restoreSettings(job));
    void loadMelody(job);
    void applyBacking(job);
  });
  const failed = onSeparateError(({ job, message }) => {
    const song = st().song;
    if (job !== loadToken || !song?.sourcePath) return;
    void api.pause();
    void fallBackToRemover(song.sourcePath, message, job);
  });
  return () => {
    for (const un of [progress, done, failed]) void un.then((f) => f());
  };
}

/** Use a different recording of the song (e.g. if the first had an intro). */
export async function switchSource(r: Ranked) {
  const token = ++loadToken;
  await api.pause().catch(() => {});
  resetPitchTrail();
  st().patchSong({
    userOffset: 0,
    info: null,
    restored: false,
    melody: null,
    video: null,
  });
  await buildFrom(r.video, token);
}

export async function switchToVocalRemover() {
  const path = st().song?.sourcePath;
  if (!path) return;
  const token = ++loadToken;
  await api.pause().catch(() => {});
  st().patchSong({
    phase: "separating",
    message: "Đang lọc giọng…",
    separation: null,
  });
  try {
    const info = await api.songVocalRemoval(path);
    if (!isCurrent(token)) return;
    applySongKey(info);
    st().patchSong({ info, phase: "ready" });
  } catch (e) {
    if (isCurrent(token) && errorText(e) !== "superseded")
      st().patchSong({ phase: "error", message: errorText(e) });
  }
}

export async function transform(semitones: number, tempo: number) {
  const song = st().song;
  if (!song?.info) return;
  st().patchSong({
    busy:
      semitones !== song.info.semitones
        ? "Đang đổi tông…"
        : "Đang đổi nhịp độ…",
  });
  try {
    const info = await api.songTransform(semitones, tempo);
    if (
      wanted &&
      wanted.semitones === info.semitones &&
      Math.abs(wanted.tempo - info.tempo) < 1e-3
    )
      wanted = null;
    st().patchSong({ info, busy: null });
    applySongKey(info);
  } catch (e) {
    st().patchSong({ busy: null });
    if (errorText(e) !== "superseded") st().toast(errorText(e), "error");
  }
}

/**
 * Correct the spelling of word `k` in line `li` of the open song. The fix is
 * kept for the song and applied to every line with the same text.
 */
export function fixWord(li: number, k: number, text: string) {
  const song = st().song;
  const line = song?.lyrics.lines?.[li];
  const w = line?.words[k];
  const t = text.trim().replace(/\s+/g, " ");
  if (!song || !line || !w || t === w.text) return;
  // Fixes are kept per original word; this one may already be a piece of
  // a split word, so rebuild the whole original word's text around it.
  const src = w.src ?? k;
  const group = line.words.filter((x, j) => (x.src ?? j) === src);
  const replaced = group
    .map((x) => (x === w ? t : x.text))
    .filter(Boolean)
    .join(" ");
  const orig = line.orig ?? line.text;
  const key = `${orig}|${src}`;
  const fixes = { ...(libraryEntry(song.meta.id)?.fixes ?? {}) };
  if (replaced === (line.base ?? line.words)[src]?.text) delete fixes[key];
  else fixes[key] = replaced;
  saveToLibrary(song.meta.id, { fixes });
  st().patchSong({
    lyrics: {
      ...song.lyrics,
      lines: withFixes(song.meta.id, song.lyrics.lines!),
    },
  });
}

/**
 * Delete a whole line (the audience shouting, an announcer): every word of
 * it fixed to nothing, so it stays gone when the lyrics are fitted again.
 * Lines with the same text go too. Offers to undo.
 */
export function deleteLine(li: number) {
  const song = st().song;
  const line = song?.lyrics.lines?.[li];
  if (!song || !line) return;
  const id = song.meta.id;
  const before = libraryEntry(id)?.fixes ?? {};
  const orig = line.orig ?? line.text;
  const fixes = { ...before };
  (line.base ?? line.words).forEach((_, k) => (fixes[`${orig}|${k}`] = ""));
  saveToLibrary(id, { fixes });
  const lines = song.lyrics.lines!;
  st().patchSong({ lyrics: { ...song.lyrics, lines: withFixes(id, lines) } });
  st().toast(`Đã xóa dòng “${line.text}”.`, "info", {
    label: "Hoàn tác",
    run: () => {
      saveToLibrary(id, { fixes: before });
      const now = st().song;
      // The lines as they were (the deleted one included), corrections re-applied.
      if (now?.meta.id === id)
        st().patchSong({
          lyrics: { ...now.lyrics, lines: withFixes(id, lines) },
        });
    },
  });
}

export function closeSong() {
  loadToken++;
  void api.songUnload();
  useStore.setState({ song: null, view: "search", playing: false });
}
