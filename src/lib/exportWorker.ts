/*
 * A worker of the video export: draws lyric frames (the same `drawer` as the
 * main thread, on a transparent canvas) and returns the rows holding the
 * lyrics as raw yuva420p (`lyricBand`). Several run
 * at once, each on its own core.
 */
import type { Line } from "./lrc";
import { CanvasRecorder } from "./canvasRecorder";
import { drawer, lyricBand, trackExtent, type LyricStyle } from "./lyricDraw";
import type { Singer } from "./parts";

export interface FontFaceSpec {
  family: string;
  source: string;
  weight: string;
  style: string;
  unicodeRange: string;
}

export interface WorkerInit {
  type: "init";
  W: number;
  H: number;
  font: string;
  accent: string;
  lines: Line[];
  title: string;
  artist: string;
  style: LyricStyle;
  singers: (Singer | undefined)[];
  /** Pitch marks and countdowns on the beat (see `drawer`). */
  aids: { notes: { start: number; end: number; midi: number }[] | null; look: "ribbon" | "dots" | "lane"; offset: number; beats: number[] | null };
  faces: FontFaceSpec[];
  /** Text measured once fonts are in, to check this worker draws like the page. */
  probe: { font: string; text: string };
}

/** Record frames `from`… (their lyric times `times`) as canvas calls for the backend. */
export interface WorkerRecord {
  type: "record";
  from: number;
  times: Float64Array;
}

export type WorkerIn = WorkerInit | { type: "frame"; i: number; t: number } | WorkerRecord;
export type WorkerOut =
  | { type: "ready"; width: number }
  | { type: "frame"; i: number; y: number; rows: number; data: ArrayBuffer }
  | { type: "chunk"; frames: number; data: ArrayBuffer }
  | { type: "recorded" }
  | { type: "error"; message: string };

/** Frames per recorded chunk sent back. */
const CHUNK_FRAMES = 300;

const scope = self as unknown as {
  postMessage(m: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
  fonts?: { add(f: FontFace): void };
};

let canvas: OffscreenCanvas | null = null;
let size = { W: 0, H: 0 };
let drawn: ReturnType<typeof trackExtent> | null = null;
let draw: ((t: number, frame: "clear") => void) | null = null;
let recorder: CanvasRecorder | null = null;
let record: ((t: number, frame: "clear") => void) | null = null;
// Frames are drawn one after another on the one canvas.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e) => {
  const m = e.data;
  queue = queue
    .then(async () => {
      if (m.type === "init") {
        if (!scope.fonts) throw new Error("no fonts in workers");
        await Promise.all(
          m.faces.map(async (f) => {
            const face = new FontFace(f.family, f.source, {
              weight: f.weight || "normal",
              style: f.style || "normal",
              unicodeRange: f.unicodeRange || undefined,
            });
            scope.fonts!.add(await face.load());
          }),
        );
        canvas = new OffscreenCanvas(m.W, m.H);
        size = { W: m.W, H: m.H };
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.font = m.probe.font;
        const width = ctx.measureText(m.probe.text).width;
        drawn = trackExtent(ctx, m.H);
        draw = drawer(ctx, m.W, m.H, new OffscreenCanvas(1, 1), m.font, m.accent, m.lines, m.title, m.artist, m.style, m.singers, m.aids);
        // The same drawer on a recorder, measuring text with a real canvas.
        recorder = new CanvasRecorder(new OffscreenCanvas(1, 1).getContext("2d")!);
        const rec = recorder as unknown as OffscreenCanvasRenderingContext2D;
        record = drawer(rec, m.W, m.H, new OffscreenCanvas(1, 1), m.font, m.accent, m.lines, m.title, m.artist, m.style, m.singers, m.aids);
        scope.postMessage({ type: "ready", width });
      } else if (m.type === "record") {
        if (!record || !recorder) throw new Error("not initialised");
        const send = () => {
          const frames = recorder!.count;
          const data = recorder!.take();
          scope.postMessage({ type: "chunk", frames, data }, [data]);
        };
        for (let k = 0; k < m.times.length; k++) {
          recorder.frame(m.from + k);
          record(m.times[k], "clear");
          if (recorder.count >= CHUNK_FRAMES) send();
        }
        if (recorder.count) send();
        scope.postMessage({ type: "recorded" });
      } else {
        if (!draw || !canvas) throw new Error("not initialised");
        drawn?.reset();
        draw(m.t, "clear");
        const { y, rows, data } = lyricBand(canvas.getContext("2d")!, size.W, size.H, drawn ? drawn.range() : [0, size.H]);
        scope.postMessage({ type: "frame", i: m.i, y, rows, data }, [data]);
      }
    })
    .catch((err) => scope.postMessage({ type: "error", message: String(err?.message ?? err) }));
};
