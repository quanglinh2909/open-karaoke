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
} from "./api";
import {
  alternatives,
  chooseVariants,
  estimateLyricOffset,
  linesFromPlain,
  retime,
  romanize,
  variantCount,
  withHums,
} from "./align";
import { libraryEntry, saveToLibrary, withFixes } from "./library";
import {
  dropEchoes,
  dropRushed,
  mergeLyrics,
  type MergedLine,
} from "./lyricsMerge";
import { parseLrc, type Line } from "./lrc";
import { mod12, SCALE_MAJOR, SCALE_MINOR } from "./music";
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
export const ALIGN_VERSION = 11;

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

/** Recordings the user stopped, so their pipeline ends quietly. */
const stopped = new Set<string>();

/**
 * Fit a song's lyrics to its singer: queued behind songs started earlier,
 * and carried on even if the song is closed. The open song shows progress
 * and gets the lyrics when they are ready.
 */
export function startLyrics(songId: string) {
  const entry = libraryEntry(songId);
  const sourceId = entry?.sourceId;
  if (!sourceId || preparing.has(sourceId)) return;
  stopped.delete(sourceId);
  const l = entry.lyrics;
  const published = l?.synced
    ? parseLrc(l.synced)
    : l?.plain
      ? linesFromPlain(l.plain)
      : null;
  const open = () => {
    const s = st().song;
    return s?.sourceId === sourceId ? s : null;
  };
  // Until this recording's turn comes the backend sends nothing: "queue".
  if (open()) st().patchSong({ aligning: { stage: "queue", fraction: 0 } });
  const show =
    (stage: "listen" | "time") => (source: string, fraction: number) => {
      if (source === sourceId && open())
        st().patchSong({ aligning: { stage, fraction } });
    };
  const unlisten = [
    onTranscribeProgress(show("listen")),
    onAlignProgress(show("time")),
  ];
  void prepareLyrics(songId, sourceId, published)
    .then((timed) => {
      const s = open();
      if (!s) return;
      if (timed) {
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
      } else {
        st().patchSong({ aligning: null });
        if (!stopped.has(sourceId))
          st().toast("Không khớp được lời theo ca sĩ này.", "error");
      }
    })
    .finally(() => {
      for (const u of unlisten) void u.then((f) => f());
    });
}

/** Stop fitting a song's lyrics (queued or running), so other songs go first. */
export function stopLyrics(songId: string) {
  const sourceId = libraryEntry(songId)?.sourceId;
  if (!sourceId) return;
  stopped.add(sourceId);
  void api.cancelLyrics(sourceId);
  if (st().song?.sourceId === sourceId) st().patchSong({ aligning: null });
}

/** Lyrics being prepared, per recording: one pipeline each, however often the song is opened. */
const preparing = new Map<string, Promise<Line[] | null>>();

/**
 * Listen to the singer, merge with the published lyrics, time every word,
 * and keep the result in the library. It runs to the end even if the song
 * is closed (the backend takes recordings one at a time, in order), so the
 * lyrics are ready next time. Null if it failed or was stopped.
 */
function prepareLyrics(
  songId: string,
  sourceId: string,
  published: Line[] | null,
): Promise<Line[] | null> {
  let job = preparing.get(sourceId);
  if (!job) {
    job = (async () => {
      try {
        const heard = dropEchoes(
          dropRushed((await listen(sourceId, published)) ?? []),
        );
        const lines = heard?.length ? mergeLyrics(published, heard) : published;
        if (!lines?.length) return null;
        const words = await timeWords(sourceId, lines);
        // Where the melody shows singing but no words were heard: a stand-in.
        const timed =
          words &&
          withHums(words, await api.melodyNotes(sourceId).catch(() => null));
        if (timed)
          saveToLibrary(songId, {
            aligned: { sourceId, lines: timed, v: ALIGN_VERSION },
          });
        return timed;
      } catch (e) {
        if (errorText(e) !== "cancelled")
          console.warn("Lyrics alignment failed:", errorText(e));
        return null;
      }
    })().finally(() => preparing.delete(sourceId));
    preparing.set(sourceId, job);
  }
  return job;
}

/** What the singer actually sings (Whisper), or null if it couldn't run. */
async function listen(
  sourceId: string,
  published: Line[] | null,
): Promise<HeardLine[] | null> {
  try {
    // Each distinct published line once: Whisper then knows the song's
    // words, which stops it inventing text over the singing.
    const prompt = published
      ? [...new Set(published.map((l) => l.text))].join(". ")
      : null;
    return await api.transcribeVocal(sourceId, prompt);
  } catch (e) {
    // Stopped by the user: end the whole pipeline, not just this step.
    if (errorText(e) === "cancelled") throw e;
    console.warn("Speech recognition failed:", errorText(e));
    return null;
  }
}

/** Word-level timing from the MMS aligner, choosing between disputed versions. */
async function timeWords(
  sourceId: string,
  lines: Line[],
): Promise<Line[] | null> {
  // Where Whisper heard each line (none for lines it didn't hear).
  const windows = (lines as MergedLine[]).map((l) => l.heardAt ?? null);
  const align = (texts: string[][]) =>
    api.alignLyrics(
      sourceId,
      texts.map((l) => l.map(romanize)),
      windows,
    );
  const first = await align(lines.map((l) => l.words.map((w) => w.text)));
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
  return retime(lines, times);
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
        if (!isCurrent(token)) return;
        showLyrics(l);
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
      saveToLibrary(songId, {
        sourceId: video.id,
        sourcePath: path,
        originals: originals.slice(0, 6),
      });
    }
    applySongKey(info);
    // Cached songs come back complete; otherwise wait for the head start.
    st().patchSong(
      info.separating ? { info } : { info, phase: "ready", separation: null },
    );
    void autoAlign(token).finally(() => restoreSettings(token));
    void loadMelody(token);
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
  if (isCurrent(token)) st().patchSong({ restored: true });
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
    },
  });
}

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
