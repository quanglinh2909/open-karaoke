/*
 * A stand-in for a 2D canvas that records the calls the lyric drawer makes
 * (`lyricDraw.ts`) instead of drawing them: the backend replays them on
 * every core (`fastvideo/canvas.rs`), which is many times faster than the
 * page's canvas. Text is still measured by a real canvas, so the layout is
 * exactly the page's. Opcodes and argument layouts match canvas.rs.
 */

const OP = {
  FRAME: 0,
  SAVE: 1,
  RESTORE: 2,
  TRANSLATE: 3,
  SCALE: 4,
  TRANSFORM: 5,
  FILL_COLOR: 6,
  STROKE_COLOR: 7,
  FILL_LINEAR: 8,
  STROKE_LINEAR: 9,
  FILL_RADIAL: 10,
  STROKE_RADIAL: 11,
  LINE_WIDTH: 12,
  LINE_JOIN: 13,
  LINE_CAP: 14,
  ALPHA: 15,
  SHADOW_COLOR: 16,
  SHADOW_BLUR: 17,
  FONT: 18,
  TEXT_ALIGN: 19,
  TEXT_BASELINE: 20,
  BEGIN_PATH: 21,
  MOVE_TO: 22,
  LINE_TO: 23,
  BEZIER_TO: 24,
  QUAD_TO: 25,
  ARC: 26,
  RECT: 27,
  ROUND_RECT: 28,
  CLOSE_PATH: 29,
  FILL: 30,
  STROKE: 31,
  CLIP: 32,
  FILL_RECT: 33,
  STROKE_RECT: 34,
  CLEAR_RECT: 35,
  FILL_TEXT: 36,
  STROKE_TEXT: 37,
  SHADOW_OFFSET: 38,
} as const;

type Rgba = [number, number, number, number];

class RecordedGradient {
  stops: [number, Rgba][] = [];
  constructor(
    readonly radial: boolean,
    readonly args: number[],
    private color: (c: string) => Rgba,
  ) {}
  addColorStop(offset: number, color: string) {
    this.stops.push([offset, this.color(color)]);
  }
}

type Style = string | RecordedGradient;

interface State {
  fillStyle: Style;
  strokeStyle: Style;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalCompositeOperation: GlobalCompositeOperation;
}

/** A growable little-endian byte buffer. */
class Bytes {
  buf = new ArrayBuffer(1 << 20);
  view = new DataView(this.buf);
  at = 0;
  private room(n: number) {
    if (this.at + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.at + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.at));
    this.buf = next;
    this.view = new DataView(next);
  }
  u8(v: number) {
    this.room(1);
    this.view.setUint8(this.at++, v);
  }
  u32(v: number) {
    this.room(4);
    this.view.setUint32(this.at, v, true);
    this.at += 4;
  }
  f32(...vs: number[]) {
    this.room(4 * vs.length);
    for (const v of vs) {
      this.view.setFloat32(this.at, v, true);
      this.at += 4;
    }
  }
}

const ALIGN: Record<string, number> = { left: 0, start: 0, center: 1, right: 2, end: 2 };
const BASELINE: Record<string, number> = { alphabetic: 0, middle: 1, top: 2, bottom: 3, hanging: 4, ideographic: 5 };
const JOIN: Record<string, number> = { miter: 0, round: 1, bevel: 2 };
const CAP: Record<string, number> = { butt: 0, round: 1, square: 2 };

/** Records canvas calls; pass it to `drawer` as its context. */
export class CanvasRecorder {
  private out = new Bytes();
  private strings = new Map<string, number>();
  private colors = new Map<string, Rgba>();
  /** Text measured so far, by font and text: the same words are measured frame after frame. */
  private metrics = new Map<string, TextMetrics>();
  /** The font the measuring canvas has (set only when measuring: setting it parses CSS). */
  private measureFont = "";
  private st: State = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    globalAlpha: 1,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalCompositeOperation: "source-over",
  };
  private stack: State[] = [];
  /** Frames recorded since the last `take`. */
  count = 0;

  /** `measure`: a real canvas context, for measuring text and reading colours. */
  constructor(private measure: OffscreenCanvasRenderingContext2D) {}

  /** Start frame `i`. A canvas keeps its state from one frame to the next
   * (the drawer sets its font once), and each frame is replayed on its own:
   * so each starts by restating it. */
  frame(i: number) {
    this.out.u8(OP.FRAME);
    this.out.u32(i);
    this.count++;
    const s = this.st;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.lineJoin = s.lineJoin;
    this.lineCap = s.lineCap;
    this.globalAlpha = s.globalAlpha;
    this.shadowColor = s.shadowColor;
    this.shadowBlur = s.shadowBlur;
    this.shadowOffsetX = s.shadowOffsetX;
    this.font = s.font;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
  }

  /** The recorded chunk (strings table, then commands), and start a new one. */
  take(): ArrayBuffer {
    const enc = new TextEncoder();
    const parts = [...this.strings.keys()].map((s) => enc.encode(s));
    const head = 4 + parts.reduce((n, p) => n + 4 + p.length, 0);
    const all = new Uint8Array(head + this.out.at);
    const v = new DataView(all.buffer);
    v.setUint32(0, parts.length, true);
    let at = 4;
    for (const p of parts) {
      v.setUint32(at, p.length, true);
      all.set(p, at + 4);
      at += 4 + p.length;
    }
    all.set(new Uint8Array(this.out.buf, 0, this.out.at), at);
    this.out = new Bytes();
    this.strings.clear();
    this.count = 0;
    return all.buffer;
  }

  private color(c: string): Rgba {
    const hit = this.colors.get(c);
    if (hit) return hit;
    // The real canvas normalises any CSS colour to #rrggbb or rgba(…).
    this.measure.fillStyle = "#000000";
    this.measure.fillStyle = c;
    const n = String(this.measure.fillStyle);
    let rgba: Rgba = [0, 0, 0, 1];
    const m = n.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (m) rgba = [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, 1];
    else {
      const f = n.match(/rgba?\(([^)]+)\)/);
      if (f) {
        const p = f[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        rgba = [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
      }
    }
    this.colors.set(c, rgba);
    return rgba;
  }

  private text(s: string): number {
    let id = this.strings.get(s);
    if (id === undefined) {
      id = this.strings.size;
      this.strings.set(s, id);
    }
    return id;
  }

  private style(s: Style, fill: boolean) {
    if (typeof s === "string") {
      this.out.u8(fill ? OP.FILL_COLOR : OP.STROKE_COLOR);
      this.out.f32(...this.color(s));
      return;
    }
    this.out.u8(s.radial ? (fill ? OP.FILL_RADIAL : OP.STROKE_RADIAL) : fill ? OP.FILL_LINEAR : OP.STROKE_LINEAR);
    this.out.f32(...s.args);
    this.out.u32(s.stops.length);
    for (const [o, c] of s.stops) this.out.f32(o, ...c);
  }

  // ---- state
  get fillStyle(): Style {
    return this.st.fillStyle;
  }
  set fillStyle(v: Style) {
    this.st.fillStyle = v;
    this.style(v, true);
  }
  get strokeStyle(): Style {
    return this.st.strokeStyle;
  }
  set strokeStyle(v: Style) {
    this.st.strokeStyle = v;
    this.style(v, false);
  }
  get lineWidth() {
    return this.st.lineWidth;
  }
  set lineWidth(v: number) {
    if (!(v > 0)) return;
    this.st.lineWidth = v;
    this.out.u8(OP.LINE_WIDTH);
    this.out.f32(v);
  }
  get lineJoin() {
    return this.st.lineJoin;
  }
  set lineJoin(v: CanvasLineJoin) {
    this.st.lineJoin = v;
    this.out.u8(OP.LINE_JOIN);
    this.out.u8(JOIN[v] ?? 0);
  }
  get lineCap() {
    return this.st.lineCap;
  }
  set lineCap(v: CanvasLineCap) {
    this.st.lineCap = v;
    this.out.u8(OP.LINE_CAP);
    this.out.u8(CAP[v] ?? 0);
  }
  get globalAlpha() {
    return this.st.globalAlpha;
  }
  set globalAlpha(v: number) {
    if (!Number.isFinite(v)) return;
    this.st.globalAlpha = Math.max(0, Math.min(1, v));
    this.out.u8(OP.ALPHA);
    this.out.f32(this.st.globalAlpha);
  }
  get shadowColor() {
    return this.st.shadowColor;
  }
  set shadowColor(v: string) {
    this.st.shadowColor = v;
    this.out.u8(OP.SHADOW_COLOR);
    this.out.f32(...this.color(v));
  }
  get shadowBlur() {
    return this.st.shadowBlur;
  }
  set shadowBlur(v: number) {
    if (!(v >= 0)) return;
    this.st.shadowBlur = v;
    this.out.u8(OP.SHADOW_BLUR);
    this.out.f32(v);
  }
  get shadowOffsetX() {
    return this.st.shadowOffsetX;
  }
  set shadowOffsetX(v: number) {
    this.st.shadowOffsetX = v;
    this.out.u8(OP.SHADOW_OFFSET);
    this.out.f32(v, this.st.shadowOffsetY);
  }
  get shadowOffsetY() {
    return this.st.shadowOffsetY;
  }
  set shadowOffsetY(v: number) {
    this.st.shadowOffsetY = v;
    this.out.u8(OP.SHADOW_OFFSET);
    this.out.f32(this.st.shadowOffsetX, v);
  }
  get font() {
    return this.st.font;
  }
  set font(v: string) {
    this.st.font = v;
    const m = v.match(/(?:^|\s)(\d{3})\s.*?(\d+(?:\.\d+)?)px/) ?? v.match(/()(\d+(?:\.\d+)?)px/);
    const weight = m?.[1] ? Number(m[1]) : /\bbold\b/.test(v) ? 700 : 400;
    this.out.u8(OP.FONT);
    this.out.f32(weight, m ? Number(m[2]) : 10);
  }
  get textAlign() {
    return this.st.textAlign;
  }
  set textAlign(v: CanvasTextAlign) {
    this.st.textAlign = v;
    this.out.u8(OP.TEXT_ALIGN);
    this.out.u8(ALIGN[v] ?? 0);
  }
  get textBaseline() {
    return this.st.textBaseline;
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.st.textBaseline = v;
    this.out.u8(OP.TEXT_BASELINE);
    this.out.u8(BASELINE[v] ?? 0);
  }
  get globalCompositeOperation() {
    return this.st.globalCompositeOperation;
  }
  set globalCompositeOperation(v: GlobalCompositeOperation) {
    // Only source-over is replayed (all the lyric drawer uses).
    this.st.globalCompositeOperation = v;
  }

  save() {
    this.stack.push({ ...this.st });
    this.out.u8(OP.SAVE);
  }
  restore() {
    const s = this.stack.pop();
    if (s) this.st = s;
    this.out.u8(OP.RESTORE);
  }
  translate(x: number, y: number) {
    this.out.u8(OP.TRANSLATE);
    this.out.f32(x, y);
  }
  scale(x: number, y: number) {
    this.out.u8(OP.SCALE);
    this.out.f32(x, y);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.out.u8(OP.TRANSFORM);
    this.out.f32(a, b, c, d, e, f);
  }
  resetTransform() {
    this.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- paths
  beginPath() {
    this.out.u8(OP.BEGIN_PATH);
  }
  moveTo(x: number, y: number) {
    this.out.u8(OP.MOVE_TO);
    this.out.f32(x, y);
  }
  lineTo(x: number, y: number) {
    this.out.u8(OP.LINE_TO);
    this.out.f32(x, y);
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) {
    this.out.u8(OP.BEZIER_TO);
    this.out.f32(a, b, c, d, x, y);
  }
  quadraticCurveTo(a: number, b: number, x: number, y: number) {
    this.out.u8(OP.QUAD_TO);
    this.out.f32(a, b, x, y);
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false) {
    this.out.u8(OP.ARC);
    this.out.f32(x, y, Math.max(0, r), a0, a1, ccw ? 1 : 0);
  }
  rect(x: number, y: number, w: number, h: number) {
    this.out.u8(OP.RECT);
    this.out.f32(x, y, w, h);
  }
  roundRect(x: number, y: number, w: number, h: number, r: number | number[] | DOMPointInit = 0) {
    const radius = typeof r === "number" ? r : Array.isArray(r) ? Number(r[0] ?? 0) : Number((r as DOMPointInit).x ?? 0);
    this.out.u8(OP.ROUND_RECT);
    this.out.f32(x, y, w, h, radius);
  }
  closePath() {
    this.out.u8(OP.CLOSE_PATH);
  }
  fill() {
    this.out.u8(OP.FILL);
  }
  stroke() {
    this.out.u8(OP.STROKE);
  }
  clip() {
    this.out.u8(OP.CLIP);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.out.u8(OP.FILL_RECT);
    this.out.f32(x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number) {
    this.out.u8(OP.STROKE_RECT);
    this.out.f32(x, y, w, h);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.out.u8(OP.CLEAR_RECT);
    this.out.f32(x, y, w, h);
  }

  // ---- text
  fillText(s: string, x: number, y: number) {
    this.out.u8(OP.FILL_TEXT);
    this.out.u32(this.text(s));
    this.out.f32(x, y);
  }
  strokeText(s: string, x: number, y: number) {
    this.out.u8(OP.STROKE_TEXT);
    this.out.u32(this.text(s));
    this.out.f32(x, y);
  }
  measureText(s: string): TextMetrics {
    const key = `${this.st.font}\u0000${s}`;
    let m = this.metrics.get(key);
    if (!m) {
      if (this.measureFont !== this.st.font) {
        this.measure.font = this.st.font;
        this.measureFont = this.st.font;
      }
      m = this.measure.measureText(s);
      if (this.metrics.size > 20000) this.metrics.clear();
      this.metrics.set(key, m);
    }
    return m;
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number) {
    return new RecordedGradient(false, [x0, y0, x1, y1], (c) => this.color(c));
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
    return new RecordedGradient(true, [x0, y0, r0, x1, y1, r1], (c) => this.color(c));
  }

  /** Only the background picture is drawn with images, which the backend lays itself. */
  drawImage() {}
}

/** The font family the backend can draw (its bundled font). */
export const FAST_FAMILY = "Bricolage Grotesque Variable";
