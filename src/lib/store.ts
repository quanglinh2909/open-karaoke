import { create } from "zustand";
import { api, type AudioStatus, type Beats, type MelodyNote, type PitchPoint, type Score, type SeparateProgress, type SongInfo, type SongMeta, type Tick, type ToolStatus } from "./api";
import type { Line } from "./lrc";
import { DEFAULT_PARAMS, type Params } from "./presets";
import type { Ranked } from "./sources";

export type View = "boot" | "setup" | "search" | "stage" | "lab";
export type Phase = "searching" | "downloading" | "separating" | "ready" | "error";
export type Tab = "tune" | "voice" | "mix" | "song";

export interface LyricsState {
  status: "loading" | "ready" | "missing";
  lines: Line[] | null;
  plain: string | null;
  instrumental: boolean;
}

export interface SongState {
  meta: SongMeta;
  phase: Phase;
  message: string;
  progress: number;
  info: SongInfo | null;
  lyrics: LyricsState;
  /** Candidate recordings of the original song, best first. */
  originals: Ranked[];
  sourceId: string | null;
  sourcePath: string | null;
  /** Live AI separation progress; null when not separating. */
  separation: SeparateProgress | null;
  /** Manual lyric nudge, seconds (positive = lyrics later). */
  userOffset: number;
  /** While the lyrics are being fitted to the singer: waiting for other songs, listening (Whisper), then timing (MMS). */
  aligning: { stage: "queue" | "listen" | "time"; fraction: number } | null;
  /** This song's saved key, tempo and timing are back in place, so changes may be saved. */
  restored?: boolean;
  /** Seconds skipped at the start and end of the recording (ads, talk), in
   * the original recording's time. */
  trim?: { start: number; end: number };
  /** The original singer's melody, for the note bars (null until found). */
  melody?: MelodyNote[] | null;
  /** The song's beat, for counting in on it (null until found). */
  beats?: Beats | null;
  /** The recording's HD video for the background (when wanted). */
  video?: { status: "loading" | "ready" | "error"; path?: string; progress: number; message?: string } | null;
  /** Autotune key follows the detected song key. */
  keyAuto: boolean;
  busy: string | null;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}

export interface AudioPrefs {
  input: string | null;
  output: string | null;
  buffer: number | null;
  /** WASAPI exclusive mode on Windows (low latency). */
  exclusive?: boolean;
  /** ASIO driver to use for both mic and output (Windows), or none. */
  asio?: string | null;
}

const PERSIST_KEY = "openkaraoke.params.v1";
const PREFS_KEY = "openkaraoke.audio.v1";
const HISTORY_KEY = "openkaraoke.history.v1";
// Per-song values that should not survive a restart.
const VIDEO_BG_KEY = "openkaraoke.videoBg.v1";
const AIDS_KEY = "openkaraoke.aids.v3";

/** How the original melody is shown: a ribbon under the line, dots over the words, or a lane of notes. */
export type MelodyLook = "ribbon" | "dots" | "lane";
/** Singing aids: the melody (`pitch` on, as `look`) and countdowns on the beat. */
export interface Aids {
  pitch: boolean;
  look: MelodyLook;
  beat: boolean;
}
const TRANSIENT = new Set(["tune_key", "tune_scale", "drone"]);
const MY_PRESETS_KEY = "openkaraoke.mypresets.v1";

export interface MyPreset {
  name: string;
  values: Params;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

interface Store {
  view: View;
  tools: ToolStatus | null;
  audio: AudioStatus | null;
  audioPrefs: AudioPrefs;
  /** Show the recording's video behind the lyrics (and in exported videos). */
  videoBg: boolean;
  /** The karaoke video being exported, if any (it runs whatever view is open). */
  exportJob: { title: string; progress: number } | null;
  setVideoBg: (on: boolean) => void;
  /** Singing aids on the lyrics (stage and exports): the melody ribbon under the line, countdowns on the song's beat. */
  aids: Aids;
  setAids: (a: Partial<Aids>) => void;
  params: Params;
  song: SongState | null;
  history: SongMeta[];
  pos: number;
  duration: number;
  playing: boolean;
  ended: boolean;
  recording: boolean;
  buffering: boolean;
  ready: number;
  mic: number;
  out: number;
  score: Score;
  toasts: Toast[];
  tab: Tab;
  sidebar: boolean;
  settingsOpen: boolean;
  /** The full-page lyrics editor: the current lyrics to edit, or empty to write new ones. */
  lyricsEditor: null | "edit" | "new";
  /** The page for choosing parts (harmony, original singer) by lyric line. */
  partsEditor: boolean;
  lastRecording: string | null;
  /** Voice Lab transport, mirrored from ticks. */
  lab: { state: number; pos: number; len: number };
  myPresets: MyPreset[];

  savePreset: (name: string, values: Params) => void;
  deletePreset: (name: string) => void;
  setView: (v: View) => void;
  setParam: (name: string, value: number) => void;
  setParams: (p: Params) => void;
  patchSong: (p: Partial<SongState>) => void;
  toast: (text: string, kind?: Toast["kind"], action?: Toast["action"]) => void;
  dismiss: (id: number) => void;
  pushHistory: (m: SongMeta) => void;
  removeHistory: (id: string) => void;
  /** Change a song's name in the history where it is (no reordering). */
  renameHistory: (id: string, title: string, artist: string) => void;
  set: (p: Partial<Store>) => void;
}

let pending: Params = {};
let flushQueued = false;

function queueParams(p: Params) {
  Object.assign(pending, p);
  if (flushQueued) return;
  flushQueued = true;
  requestAnimationFrame(() => {
    const batch = Object.entries(pending) as [string, number][];
    pending = {};
    flushQueued = false;
    api.setParams(batch).catch(() => {});
  });
}

function persist(params: Params) {
  const keep: Params = {};
  for (const [k, v] of Object.entries(params)) if (!TRANSIENT.has(k)) keep[k] = v;
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(keep));
  } catch {
    /* storage unavailable */
  }
}

let toastId = 0;

function saveHistory(history: SongMeta[]) {
  useStore.setState({ history });
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* storage unavailable */
  }
}

/** Saved settings, with the old -50 dB noise gate default turned off once:
 * it closed on soft words from quiet headset mics. */
function loadParams(): Params {
  const params = load<Params>(PERSIST_KEY, DEFAULT_PARAMS);
  try {
    if (!localStorage.getItem("openkaraoke.gateOff.v1")) {
      localStorage.setItem("openkaraoke.gateOff.v1", "1");
      if (params.gate_db === -50) return { ...params, gate_db: DEFAULT_PARAMS.gate_db };
    }
  } catch {
    /* storage unavailable */
  }
  return params;
}

export const useStore = create<Store>((set, get) => ({
  view: "boot",
  tools: null,
  audio: null,
  audioPrefs: load<AudioPrefs>(PREFS_KEY, { input: null, output: null, buffer: 256 }),
  exportJob: null,
  aids: { pitch: true, look: "ribbon", beat: true, ...load<Partial<Aids>>(AIDS_KEY, {}) },
  setAids: (a) => {
    const aids = { ...get().aids, ...a };
    set({ aids });
    try {
      localStorage.setItem(AIDS_KEY, JSON.stringify(aids));
    } catch {
      /* storage unavailable */
    }
  },
  videoBg: (() => {
    try {
      return localStorage.getItem(VIDEO_BG_KEY) === "1";
    } catch {
      return false;
    }
  })(),
  setVideoBg: (on) => {
    set({ videoBg: on });
    try {
      localStorage.setItem(VIDEO_BG_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  },
  params: loadParams(),
  song: null,
  history: loadList<SongMeta>(HISTORY_KEY),
  pos: 0,
  duration: 0,
  playing: false,
  ended: false,
  recording: false,
  buffering: false,
  ready: 0,
  mic: 0,
  out: 0,
  score: { accuracy: 0, sung: 0, points: 0, streak: 0 },
  toasts: [],
  tab: "tune",
  sidebar: true,
  settingsOpen: false,
  lyricsEditor: null,
  partsEditor: false,
  lastRecording: null,
  lab: { state: 0, pos: 0, len: 0 },
  myPresets: loadList<MyPreset>(MY_PRESETS_KEY),

  savePreset: (name, values) => {
    const myPresets = [...get().myPresets.filter((p) => p.name !== name), { name, values }];
    set({ myPresets });
    try {
      localStorage.setItem(MY_PRESETS_KEY, JSON.stringify(myPresets));
    } catch {
      /* storage unavailable */
    }
  },
  deletePreset: (name) => {
    const myPresets = get().myPresets.filter((p) => p.name !== name);
    set({ myPresets });
    try {
      localStorage.setItem(MY_PRESETS_KEY, JSON.stringify(myPresets));
    } catch {
      /* storage unavailable */
    }
  },
  setView: (view) => set({ view }),
  setParam: (name, value) => get().setParams({ [name]: value }),
  setParams: (p) => {
    const params = { ...get().params, ...p };
    set({ params });
    queueParams(p);
    persist(params);
  },
  patchSong: (p) => {
    const s = get().song;
    if (s) set({ song: { ...s, ...p } });
  },
  toast: (text, kind = "info", action) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, kind, action }].slice(-4) });
    setTimeout(() => get().dismiss(id), kind === "error" ? 8000 : action ? 9000 : 4500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  pushHistory: (m) => saveHistory([m, ...get().history.filter((h) => h.id !== m.id)].slice(0, 12)),
  removeHistory: (id) => saveHistory(get().history.filter((h) => h.id !== id)),
  renameHistory: (id, title, artist) => saveHistory(get().history.map((h) => (h.id === id ? { ...h, title, artist } : h))),
  set: (p) => {
    set(p);
    if (p.audioPrefs) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(p.audioPrefs));
      } catch {
        /* storage unavailable */
      }
    }
  },
}));

/** Push every parameter to the engine (startup, after reconnecting). */
export function syncAllParams() {
  queueParams(useStore.getState().params);
}

// ---------------------------------------------------------------- clock --
// Ticks arrive ~30×/s; animation interpolates between them.

const clock = { pos: 0, at: 0, playing: false, shown: 0, wall: 0 };

/** A difference from the ticks bigger than this is a seek: jump to it. */
const JITTER = 0.25;
/** How fast the shown time catches up with the ticks (per second). */
const CATCH_UP = 3;

/**
 * The song's position for animation. It runs on the frame clock at exactly
 * real speed and is steered gently toward the engine's ticks, rather than
 * re-set by each one: ticks arrive ~30×/s with jitter and the audio position
 * moves in device-buffer steps, so following them directly made the lyric
 * wipe stutter (stall, then jump). A seek or a real drift still jumps.
 */
export function songTime(): number {
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0, (now - clock.wall) / 1000));
  clock.wall = now;
  if (!clock.playing) return (clock.shown = clock.pos);
  // The engine plays the rendered (tempo-adjusted) track in real time.
  const target = clock.pos + Math.min(0.12, (now - clock.at) / 1000);
  if (Math.abs(target - clock.shown) > JITTER) return (clock.shown = target);
  const next = clock.shown + dt;
  // Never step back: lyrics would flicker between lines at a boundary.
  return (clock.shown = Math.max(clock.shown, next + (target - next) * Math.min(1, dt * CATCH_UP)));
}

// ---------------------------------------------------------------- pitch --

/** Pitch history; element 0 is wall-clock seconds (performance.now). */
export const pitchTrail: PitchPoint[] = [];
const PITCH_HOP = 0.004;

export function resetPitchTrail() {
  pitchTrail.length = 0;
}

/** Where singing starts and stops in playback seconds, after the song's trim. */
export function trimRange(s: Pick<Store, "song" | "duration"> = useStore.getState()): { start: number; end: number } {
  const tempo = s.song?.info?.tempo || 1;
  const trim = s.song?.trim;
  const start = (trim?.start ?? 0) / tempo;
  const end = trim?.end ? Math.max(start, s.duration - trim.end / tempo) : s.duration;
  return { start, end };
}

export function handleTick(t: Tick) {
  clock.pos = t.pos;
  clock.at = performance.now();
  clock.playing = t.playing;
  if (t.pitch.length) {
    // Re-stamp on a wall clock (one analysis hop ≈ 4 ms apart) so the graph
    // keeps scrolling while the song is paused.
    const wall = performance.now() / 1000;
    const n = t.pitch.length;
    t.pitch.forEach((p, k) => pitchTrail.push([wall - (n - 1 - k) * PITCH_HOP, p[1], p[2], p[3], p[4]]));
    if (pitchTrail.length > 3000) pitchTrail.splice(0, pitchTrail.length - 3000);
  }
  const s = useStore.getState();
  const patch: Partial<Store> = {};
  if (Math.abs(s.pos - t.pos) > 0.05) patch.pos = t.pos;
  if (s.duration !== t.duration) patch.duration = t.duration;
  if (s.playing !== t.playing) patch.playing = t.playing;
  // Past the trimmed end (an ad, an outro): stop as if the song had ended.
  const cut = !!s.song?.trim?.end && t.duration > 0 && t.pos >= trimRange({ song: s.song, duration: t.duration }).end - 0.05;
  if (cut && t.playing) void api.pause();
  const ended = t.ended || cut;
  if (s.ended !== ended) patch.ended = ended;
  if (s.recording !== t.recording) patch.recording = t.recording;
  if (s.buffering !== t.buffering) patch.buffering = t.buffering;
  if (Math.abs(s.ready - t.ready) > 0.5) patch.ready = t.ready;
  if (Math.abs(s.mic - t.mic) > 0.01) patch.mic = t.mic;
  if (Math.abs(s.out - t.out) > 0.01) patch.out = t.out;
  if (s.score.points !== t.score.points || s.score.streak !== t.score.streak) patch.score = t.score;
  const [ls, lp, ll] = t.lab;
  if (s.lab.state !== ls || Math.abs(s.lab.pos - lp) > 0.05 || s.lab.len !== ll) patch.lab = { state: ls, pos: lp, len: ll };
  if (Object.keys(patch).length) useStore.setState(patch);
  if (t.error) s.toast(t.error, "error");
}
