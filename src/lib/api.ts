import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ToolStatus {
  ready: boolean;
  ytdlp: boolean;
  deno: boolean;
  model: boolean;
}

export interface SongMeta {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  artwork: string | null;
  year: string | null;
  explicit: boolean;
  /** Picked from a YouTube search: this video is the recording to sing. */
  video?: Video;
}

/** A note of the original singer's melody: seconds in the recording, fractional MIDI. */
/** The song's beat: tempo and beat times (seconds in the recording). */
export interface Beats {
  bpm: number;
  times: number[];
  /** The music's loudness every `ENERGY_STEP` seconds. */
  energy: number[];
}

/** Seconds per `Beats.energy` value (as in audio/beats.rs). */
export const ENERGY_STEP = 0.5;

export interface MelodyNote {
  start: number;
  end: number;
  midi: number;
}

export interface Lyrics {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}

/** The automatic harmony: a synthesised "ooh" choir, or the singer's own voice shifted. */
/** "choir": a synthesised "ooh"; "voice": the singer's own, shifted; "original": the record's own backing vocals, split from the singer's. */
export type BackingStyle = "choir" | "voice" | "original";

/** One published lyrics entry (LRCLIB), for picking by hand. */
export interface LyricCandidate {
  track: string;
  artist: string;
  album: string;
  duration: number;
  lyrics: Lyrics;
}

export interface Video {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  views: number | null;
}

export interface KeyEstimate {
  tonic: number;
  minor: boolean;
  confidence: number;
}

/** A recording's lyric analysis in the backend queue. */
export interface LyricJob {
  source: string;
  stage: "queued" | "listen" | "time" | "separate";
  fraction: number;
}

/** A phrase Whisper heard in the separated vocal; word times are rough. */
export interface HeardLine {
  start: number;
  end: number;
  words: { text: string; start: number; end: number; p: number }[];
}

export interface WordTime {
  start: number;
  end: number;
  /** Mean log-probability of the word's letters; near 0 = clearly heard. */
  score: number;
}

export interface SongInfo {
  duration: number;
  sourceDuration: number;
  key: KeyEstimate | null;
  semitones: number;
  tempo: number;
  hasGuide: boolean;
  /** The AI is still separating; playback can already start. */
  separating: boolean;
  vocalRemoved: boolean;
}

export interface SeparateProgress {
  /** The job this event belongs to; anything else is stale. */
  job: number;
  fraction: number;
  /** Seconds of the song ready to play. */
  ready: number;
  /** Separation speed relative to real time. */
  speed: number;
}

export interface DeviceList {
  inputs: string[];
  outputs: string[];
  defaultInput: string | null;
  defaultOutput: string | null;
  /** Installed ASIO drivers (Windows). */
  asio: string[];
}

export interface AudioStatus {
  sampleRate: number;
  output: string;
  input: string | null;
  inputError: string | null;
  buffer: number | null;
  latencyMs: number;
  exclusive: boolean;
  exclusiveNote: string | null;
  /** The ASIO driver in use, if any. */
  asio: string | null;
}

/** Measured delay from singing to hearing yourself, by stage (ms). */
export interface LatencyReport {
  inputMs: number;
  queueMs: number;
  chainMs: number;
  outputMs: number;
  totalMs: number;
  inBlockMs: number;
  outBlockMs: number;
  mic: boolean;
}

export interface Score {
  accuracy: number;
  sung: number;
  points: number;
  streak: number;
}

/** [song seconds, sung MIDI, corrected MIDI, target note, voiced 0/1] */
export type PitchPoint = [number, number, number, number, number];

export interface Tick {
  pos: number;
  duration: number;
  playing: boolean;
  ended: boolean;
  recording: boolean;
  mic: number;
  out: number;
  pitch: PitchPoint[];
  score: Score;
  /** Voice Lab: [state 0 idle / 1 recording / 2 playing, position s, length s] */
  lab: [number, number, number];
  /** Playback caught up with the separator and is waiting. */
  buffering: boolean;
  /** Seconds of the song ready to play. */
  ready: number;
  error: string | null;
}

export const api = {
  toolsStatus: () => invoke<ToolStatus>("tools_status"),
  toolsInstall: () => invoke<ToolStatus>("tools_install"),
  searchSongs: (query: string) => invoke<SongMeta[]>("search_songs", { query }),
  /** Make the automatic harmony from the separated vocal (scale steps; none = off). */
  songBacking: (degrees: number[], style: BackingStyle) => invoke<void>("song_backing", { degrees, style }),
  /** Parts (seconds in the recording) that get the harmony, and parts the original singer sings. */
  /** `original`: [start, fullFrom, fullTo, end]; outside fullFrom–fullTo only the sung pitch is kept. */
  songParts: (backing: [number, number][], original: [number, number, number, number, number, number][]) =>
    invoke<void>("song_parts", { backing, original }),
  searchLyrics: (title: string, artist: string, duration: number) =>
    invoke<LyricCandidate[]>("search_lyrics", { title, artist, duration }),
  getLyrics: (m: SongMeta) =>
    invoke<Lyrics>("get_lyrics", { artist: m.artist, title: m.title, album: m.album, duration: m.duration }),
  ytSearch: (query: string, limit = 10) => invoke<Video[]>("yt_search", { query, limit }),
  ytDownload: (id: string) => invoke<string>("yt_download", { id }),
  /** The recording's video, picture only, up to 1080p (cached). */
  ytDownloadVideo: (id: string) => invoke<string>("yt_download_video", { id }),
  songSeparate: (path: string, id: string, job: number) => invoke<SongInfo>("song_separate", { path, id, job }),
  stemsCached: (ids: string[]) => invoke<string[]>("stems_cached", { ids }),
  /** Separated-vocal loudness every 50 ms; null until separation is done. */
  vocalActivity: () => invoke<number[] | null>("vocal_activity"),
  /** Forced alignment of romanized lyric words against the separated vocal. */
  /** `windows`: where speech recognition heard each line [start, end] (seconds), or null. */
  /** `lrc`: each line's published time (LRC), which guides lines the aligner misplaces; null without one. */
  alignLyrics: (source: string, lines: string[][], windows: ([number, number] | null)[] = [], lrc: (number | null)[] | null = null) =>
    invoke<(WordTime | null)[][]>("align_lyrics", { source, lines, windows, lrc }),
  /** What the singer actually sings, heard by Whisper; `prompt` (the published lyrics) primes it. */
  /** The original singer's melody, from the separated vocal (about a second, then cached). */
  melodyNotes: (source: string) => invoke<MelodyNote[]>("melody_notes", { source }),
  /** The song's beat, from its separated instrumental (a second or two, then cached). */
  songBeats: (source: string) => invoke<Beats>("song_beats", { source }),
  /** `language`: "vi", or null for Whisper to detect it. */
  transcribeVocal: (source: string, prompt: string | null, language: string | null) =>
    invoke<HeardLine[]>("transcribe_vocal", { source, prompt, language }),
  /** Lyric analyses waiting or running for these recordings. */
  lyricJobs: (sources: string[]) => invoke<LyricJob[]>("lyric_jobs", { sources }),
  /** Stop a recording's lyric analysis (queued or running) so others go first. */
  cancelLyrics: (source: string) => invoke<void>("cancel_lyrics", { source }),
  /** Delete a recording's stems, download and analyses (close the song first). */
  deleteSource: (source: string) => invoke<void>("delete_source", { source }),
  songVocalRemoval: (path: string) => invoke<SongInfo>("song_vocal_removal", { path }),
  songTransform: (semitones: number, tempo: number) => invoke<SongInfo>("song_transform", { semitones, tempo }),
  songUnload: () => invoke<void>("song_unload"),
  play: () => invoke<void>("transport_play"),
  pause: () => invoke<void>("transport_pause"),
  seek: (seconds: number) => invoke<void>("transport_seek", { seconds }),
  setParams: (params: [string, number][]) => invoke<string[]>("set_params", { params }),
  audioDevices: () => invoke<DeviceList>("audio_devices"),
  audioOpen: (input: string | null, output: string | null, buffer: number | null, exclusive = false, asio: string | null = null) =>
    invoke<AudioStatus>("audio_open", { input, output, buffer, exclusive, asio }),
  audioStatus: () => invoke<AudioStatus>("audio_status"),
  audioLatency: () => invoke<LatencyReport>("audio_latency"),
  recordStart: (name: string) => invoke<string>("record_start", { name }),
  recordStop: () => invoke<string | null>("record_stop"),
  labRecord: () => invoke<void>("lab_record"),
  labStopRecord: () => invoke<number>("lab_stop_record"),
  labPlay: (looped: boolean) => invoke<void>("lab_play", { looped }),
  labStop: () => invoke<void>("lab_stop"),
  labBypass: (on: boolean) => invoke<void>("lab_bypass", { on }),
  labExport: () => invoke<string>("lab_export"),
  recordingsDir: () => invoke<string>("recordings_dir"),
};

export function onTick(cb: (t: Tick) => void): Promise<UnlistenFn> {
  return listen<Tick>("engine://tick", (e) => cb(e.payload));
}

export function onSetupProgress(cb: (p: { step: string; label: string; fraction: number }) => void) {
  return listen<{ step: string; label: string; fraction: number }>("setup://progress", (e) => cb(e.payload));
}

/** Splitting a recording's own backing vocals (minutes, the first time). */
export function onBackingProgress(cb: (p: { source: string; fraction: number }) => void) {
  return listen<{ source: string; fraction: number }>("backing://progress", (e) => cb(e.payload));
}

export function onSeparateProgress(cb: (p: SeparateProgress) => void) {
  return listen<SeparateProgress>("separate://progress", (e) => cb(e.payload));
}

export function onSeparateDone(cb: (e: { job: number; info: SongInfo }) => void) {
  return listen<{ job: number; info: SongInfo }>("separate://done", (e) => cb(e.payload));
}

export function onSeparateError(cb: (e: { job: number; message: string }) => void) {
  return listen<{ job: number; message: string }>("separate://error", (e) => cb(e.payload));
}

export function onVideoProgress(cb: (p: { id: string; fraction: number }) => void) {
  return listen<{ id: string; fraction: number }>("download://video-progress", (e) => cb(e.payload));
}

export function onDownloadProgress(cb: (p: { id: string; fraction: number }) => void) {
  return listen<{ id: string; fraction: number }>("download://progress", (e) => cb(e.payload));
}

export function onAlignProgress(cb: (source: string, fraction: number) => void) {
  return listen<{ source: string; fraction: number }>("align://progress", (e) => cb(e.payload.source, e.payload.fraction));
}

export function onTranscribeProgress(cb: (source: string, fraction: number) => void) {
  return listen<{ source: string; fraction: number }>("transcribe://progress", (e) => cb(e.payload.source, e.payload.fraction));
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
