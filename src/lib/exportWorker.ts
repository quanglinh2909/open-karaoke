/*
 * A worker of the video export: draws lyric frames (the same `drawer` as the
 * main thread, on a transparent canvas) and returns the rows holding the
 * lyrics as raw yuva420p (`lyricBand`). Several run
 * at once, each on its own core.
 */
import type { Line } from "./lrc";
import { drawer, lyricBand, type LyricStyle } from "./lyricDraw";
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
  faces: FontFaceSpec[];
  /** Text measured once fonts are in, to check this worker draws like the page. */
  probe: { font: string; text: string };
}

export type WorkerIn = WorkerInit | { type: "frame"; i: number; t: number };
export type WorkerOut =
  | { type: "ready"; width: number }
  | { type: "frame"; i: number; y: number; rows: number; data: ArrayBuffer }
  | { type: "error"; message: string };

const scope = self as unknown as {
  postMessage(m: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
  fonts?: { add(f: FontFace): void };
};

let canvas: OffscreenCanvas | null = null;
let size = { W: 0, H: 0 };
let draw: ((t: number, frame: "clear") => void) | null = null;
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
        draw = drawer(ctx, m.W, m.H, new OffscreenCanvas(1, 1), m.font, m.accent, m.lines, m.title, m.artist, m.style, m.singers);
        scope.postMessage({ type: "ready", width });
      } else {
        if (!draw || !canvas) throw new Error("not initialised");
        draw(m.t, "clear");
        const { y, rows, data } = lyricBand(canvas.getContext("2d")!, size.W, size.H);
        scope.postMessage({ type: "frame", i: m.i, y, rows, data }, [data]);
      }
    })
    .catch((err) => scope.postMessage({ type: "error", message: String(err?.message ?? err) }));
};
