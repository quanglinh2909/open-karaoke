import type { FontFaceSpec, WorkerInit, WorkerOut } from "./exportWorker";

/** A lyric frame's non-blank rows, yuva420p planes from row `y` (see `lyricBand`). */
export interface Band {
  y: number;
  rows: number;
  data: ArrayBuffer;
}

/** The page's @font-face rules, with absolute URLs, for workers to load the same fonts. */
export function pageFontFaces(): FontFaceSpec[] {
  const out: FontFaceSpec[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(rules)) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const st = r.style;
      const base = sheet.href ?? location.href;
      const source = st
        .getPropertyValue("src")
        .replace(/url\((['"]?)([^'")]+)\1\)/g, (_, _q, u: string) => `url("${new URL(u, base).href}")`);
      out.push({
        family: st.getPropertyValue("font-family").replace(/^['"]|['"]$/g, ""),
        source,
        weight: st.getPropertyValue("font-weight"),
        style: st.getPropertyValue("font-style"),
        unicodeRange: st.getPropertyValue("unicode-range"),
      });
    }
  }
  return out;
}

/**
 * Lyric frames drawn by several workers at once and handed back in order.
 * `start` resolves to null when workers can't draw exactly like the page
 * (no fonts in workers, a different text width): the caller then draws
 * itself, as before.
 */
export class FramePool {
  private next = 0;
  private done = new Map<number, Band>();
  private waiting = new Map<number, (d: Band | null) => void>();
  private broken = false;

  private constructor(
    private workers: Worker[],
    private time: (i: number) => number,
    private total: number,
  ) {
    for (const w of workers) {
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        const m = e.data;
        if (m.type === "frame") {
          const wake = this.waiting.get(m.i);
          const band = { y: m.y, rows: m.rows, data: m.data };
          if (wake) {
            this.waiting.delete(m.i);
            wake(band);
          } else this.done.set(m.i, band);
        } else if (m.type === "error") this.fail();
      };
      w.onerror = () => this.fail();
    }
  }

  static async start(
    count: number,
    init: Omit<WorkerInit, "type" | "faces" | "probe">,
    probe: { font: string; text: string; width: number },
    time: (i: number) => number,
    total: number,
  ): Promise<FramePool | null> {
    if (typeof Worker === "undefined" || count < 2) return null;
    const workers: Worker[] = [];
    try {
      const faces = pageFontFaces();
      const ready = Array.from({ length: count }, () => {
        const w = new Worker(new URL("./exportWorker.ts", import.meta.url), { type: "module" });
        workers.push(w);
        return new Promise<number>((resolve, reject) => {
          w.onmessage = (e: MessageEvent<WorkerOut>) =>
            e.data.type === "ready" ? resolve(e.data.width) : reject(new Error(e.data.type === "error" ? e.data.message : "?"));
          w.onerror = (e) => reject(new Error(e.message));
          w.postMessage({ ...init, type: "init", faces, probe: { font: probe.font, text: probe.text } } satisfies WorkerInit);
        });
      });
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000));
      const widths = await Promise.race([Promise.all(ready), timeout]);
      // Same fonts, same layout: or not worth the risk of a different video.
      if (widths.some((w) => Math.abs(w - probe.width) > 0.01)) throw new Error(`text width ${widths[0]} ≠ ${probe.width}`);
      return new FramePool(workers, time, total);
    } catch (e) {
      console.warn("Export workers unavailable, drawing on the page:", e);
      workers.forEach((w) => w.terminate());
      return null;
    }
  }

  private fail() {
    if (this.broken) return;
    this.broken = true;
    this.waiting.forEach((wake) => wake(null));
    this.waiting.clear();
    this.close();
  }

  /** Frame `i`'s lyric rows (asked for in order), or null if the workers failed: draw it yourself then. */
  get(i: number): Promise<Band | null> {
    if (this.broken) return Promise.resolve(null);
    // Keep every worker a few frames ahead.
    const ahead = this.workers.length * 3;
    while (this.next < Math.min(this.total, i + ahead + 1)) {
      const k = this.next++;
      this.workers[k % this.workers.length].postMessage({ type: "frame", i: k, t: this.time(k) });
    }
    const have = this.done.get(i);
    if (have) {
      this.done.delete(i);
      return Promise.resolve(have);
    }
    return new Promise((resolve) => this.waiting.set(i, resolve));
  }

  close() {
    this.workers.forEach((w) => w.terminate());
  }
}
