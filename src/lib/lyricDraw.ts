/*
 * Drawing one frame of the karaoke video: pure canvas code with no app
 * state, so it also runs in the export's worker threads (exportWorker.ts).
 */
import { lineAt, type Line } from "./lrc";
import {
  clamp01,
  linePitch,
  phraseStarts,
  ANCHOR,
  COUNT_GAP,
  LEAD_IN,
  cueAt,
  entryRing,
  focusAt,
  focusSince,
  GLIDE,
  glideEase,
  holdLength,
  isHeld,
  lineJoin,
  restAfter,
  wordProgress,
  wipeEdge,
  litAlong,
  restAt,
  breath,
  wavyTail,
} from "./lyricCues";
import { SINGER_LABEL, type Singer } from "./parts";

/** How the lyrics are laid out: gliding through the middle (as on stage),
 * classic two-line karaoke at the bottom, or subtitles. */
export type LyricStyle = "scroll" | "classic" | "subtitle";

/** The dimming laid over the recording's video so the lyrics stand out. */
export function drawShade(
  ctx: OffscreenCanvasRenderingContext2D,
  W: number,
  H: number,
) {
  const shade = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * 0.75);
  shade.addColorStop(0, "rgba(11, 10, 16, 0.5)");
  shade.addColorStop(1, "rgba(11, 10, 16, 0.75)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
}

/** A word placed in its line: where it sits and what follows it. */
interface Placed {
  k: number;
  x: number;
  row: number;
  width: number;
  /** Width of the hold bar after a held note, or 0. */
  hold: number;
  /** Mark after the word; after a line's last word, how it leads into the next. */
  rest: "short" | "long" | "link" | null;
}

/** Room taken by a rest mark after a word. */
const restWidth = (rest: Placed["rest"]) =>
  rest === "link" ? 0.5 : rest === "long" ? 0.42 : rest === "short" ? 0.26 : 0;

/** The score-style marks: ’ breath, // pause, ‿ straight on (as on the stage). */
const REST_GLYPH = { short: "\u2019", long: "//", link: "\u203f" } as const;

/** The legend under the title: mark, meaning. */
const LEGEND: [string, string][] = [
  ["\u2019", "lấy hơi"],
  ["//", "nghỉ"],
  ["\u203f", "hát liền câu sau"],
  ["", "ngân dài"],
  ["\u25cf", "sáng rõ là vào câu"],
];

/** One item of the scrolling track: the intro, or a lyric line. */
interface Item {
  top: number;
  height: number;
  words: Placed[];
}

/** Opacity and scale of a track item `p` places below the focused one (stage: .d0/.d1/.d2/.past). */
function look(p: number): { alpha: number; scale: number } {
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  if (p <= -1 || p >= 3) return { alpha: 0, scale: 0.72 };
  // The line just sung fades out faster than it glides (the stage's 0.45 s vs 0.6 s).
  if (p < 0)
    return { alpha: Math.max(0, 1 + p / 0.75), scale: lerp(1, 0.72, -p) };
  if (p < 1) return { alpha: lerp(1, 0.55, p), scale: lerp(1, 0.72, p) };
  if (p < 2) return { alpha: lerp(0.55, 0.25, p - 1), scale: 0.72 };
  return { alpha: lerp(0.25, 0, p - 2), scale: 0.72 };
}

/** Duets: each singer's colours (as on stage): the sung fill over the
 * artwork (scroll style), over a picture (classic, subtitle), and the tag. */
const SINGER_COLORS: Record<Singer, { soft: string; over: [string, string]; tag: string }> = {
  female: { soft: "#ff8fc0", over: ["#ff4f9a", "#ff8fc0"], tag: "rgba(255, 111, 174, 0.9)" },
  male: { soft: "#7cc0ff", over: ["#2f8dff", "#7cc0ff"], tag: "rgba(74, 168, 255, 0.9)" },
  both: { soft: "#ffd27a", over: ["#f0a81e", "#ffd27a"], tag: "rgba(214, 156, 40, 0.92)" },
};

/** Draws one frame at lyric time `t` (exported for previews). */
export function drawer(
  ctx: OffscreenCanvasRenderingContext2D,
  W: number,
  H: number,
  bg: OffscreenCanvas,
  font: string,
  accent: string,
  lines: Line[],
  title: string,
  artist: string,
  style: LyricStyle = "scroll",
  singers: (Singer | undefined)[] = [],
  /** Singing aids: the original melody (recording time, `offset` = lyric to
   * recording time) for pitch marks above the words, and the song's beats
   * (lyric time) for counting in on the beat. */
  aids: {
    notes?: { start: number; end: number; midi: number }[] | null;
    /** How the melody shows: a ribbon under the line, dots over the words, or a lane of notes. */
    look?: "ribbon" | "dots" | "lane";
    offset?: number;
    beats?: number[] | null;
  } = {},
) {
  const portrait = H > W;
  // Same proportions as the stage: one size for every line, wrapped once.
  const size = Math.round(portrait ? W * 0.068 : H * 0.072);
  const em = (x: number) => x * size;
  // The melody ribbon needs room under each row.
  const pitchOn = !!aids.notes?.length;
  const melodyLook = aids.look ?? "ribbon";
  // On the words (ribbon under, dots over): room around each row. The lane needs none.
  const onWords = pitchOn && melodyLook !== "lane";
  const lh = em(onWords ? 1.78 : 1.15);
  const margin = em(0.16);
  const maxWidth = W - 2 * Math.max(em(0.9), W * 0.05);
  const fontLine = `700 ${size}px ${font}`;
  ctx.font = fontLine;
  const space = ctx.measureText(" ").width;

  // Classic karaoke shows a line on one row: a line too long for it is
  // split into its phrases (at its breaths and pauses) rather than shrunk a lot.
  if (style === "classic") {
    const avail = W - 2 * Math.max(em(0.9), W * 0.06);
    const split: Line[] = [];
    const who: (Singer | undefined)[] = [];
    lines.forEach((line, li) => {
      const widths = line.words.map((w) => ctx.measureText(w.text).width + em(0.3));
      const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, widths.length - 1);
      const starts = phraseStarts(line);
      if (total <= avail / 0.85 || starts.filter(Boolean).length < 2) {
        split.push(line);
        who.push(singers[li]);
        return;
      }
      // Phrases packed into rows that fit.
      let chunk: number[] = [];
      let used = 0;
      const flush = () => {
        if (!chunk.length) return;
        const ws = chunk.map((k) => line.words[k]);
        split.push({ ...line, words: ws, start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.text).join(" ") });
        who.push(singers[li]);
        chunk = [];
        used = 0;
      };
      let k = 0;
      while (k < line.words.length) {
        let j = k;
        while (j + 1 < line.words.length && !starts[j + 1]) j++;
        const group = Array.from({ length: j - k + 1 }, (_, n) => k + n);
        const gw = group.reduce((a, n) => a + widths[n], 0) + space * group.length;
        if (chunk.length && used + gw > avail) flush();
        chunk.push(...group);
        used += gw;
        k = j + 1;
      }
      flush();
    });
    lines = split;
    singers = who;
  }
  // The melody over each word, for the ribbon under the line.
  const pitches = lines.map((l) => (onWords ? linePitch(l, aids.notes, aids.offset ?? 0) : null));

  // ---- lay out the whole track once (intro, then every line)
  const titleSize = Math.round(em(1.2));
  const artistSize = Math.round(em(0.4));
  const items: Item[] = [];
  let y = 0;
  const legendSize = Math.round(em(0.3));
  const introHeight =
    titleSize * 1.05 +
    em(0.25) +
    artistSize * 1.3 +
    em(0.35) +
    legendSize * 1.3;
  items.push({ top: y, height: introHeight, words: [] });
  y += introHeight + em(0.6) + margin;
  for (const line of lines) {
    const placed: Placed[] = [];
    let row = 0;
    let x = 0;
    const li = items.length - 1;
    const sizes = line.words.map((w, k) => {
      const last = k === line.words.length - 1;
      const width = ctx.measureText(w.text).width;
      // A stand-in for unheard singing (♪♪♪) has no held-note trail.
      const hold = isHeld(w, last) && !line.hum ? em(holdLength(w) + 0.14) : 0;
      const rest = last ? lineJoin(lines, li) : restAfter(line, k);
      return { width, hold, rest, total: width + hold + em(restWidth(rest)) };
    });
    // Rows break between phrases (at breaths and pauses), so each row is
    // sung in one go; inside a phrase only when it alone is too long.
    const starts = phraseStarts(line);
    const phraseWidth = (k: number) => {
      let w = sizes[k].total;
      for (let j = k + 1; j < sizes.length && !starts[j]; j++) w += space + sizes[j].total;
      return w;
    };
    line.words.forEach((_, k) => {
      const { width, hold, rest, total } = sizes[k];
      // Classic karaoke keeps each line on one row (shrunk to fit when drawn).
      if (x > 0 && style !== "classic") {
        const fits = starts[k] ? x + space + phraseWidth(k) <= maxWidth : x + space + total <= maxWidth;
        if (!fits) {
          row++;
          x = 0;
        }
      }
      if (x > 0) x += space;
      placed.push({ k, x, row, width, hold, rest });
      x += total;
    });
    const rows = row + 1;
    items.push({ top: y + margin, height: rows * lh, words: placed });
    y += margin + rows * lh + margin;
  }
  // Each row's width, to centre it.
  const rowWidth = (item: Item, row: number) => {
    const ws = item.words.filter((p) => p.row === row);
    const last = ws[ws.length - 1];
    return last
      ? last.x + last.width + last.hold + em(restWidth(last.rest))
      : 0;
  };
  const rowWidths = items.map((item) => {
    const n = item.words.length ? item.words[item.words.length - 1].row + 1 : 0;
    return Array.from({ length: n }, (_, r) => rowWidth(item, r));
  });

  const anchorY = H * ANCHOR;
  const dim = "rgba(245, 242, 251, 0.4)";

  /** A held note's trail from `x`: `fill` of it lit, tapering to nothing at the end. */
  const tail = (x: number, y: number, width: number, fill: number) => {
    const h = em(0.09);
    const fade = (c: string) => {
      const g = ctx.createLinearGradient(x, 0, x + width, 0);
      g.addColorStop(0, c);
      g.addColorStop(0.5, c);
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      return g;
    };
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = h;
    ctx.strokeStyle = fade("rgba(255, 255, 255, 0.22)");
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
    if (fill > 0) {
      ctx.strokeStyle = fade(accent);
      ctx.shadowColor = "rgba(255, 61, 127, 0.55)";
      ctx.shadowBlur = em(0.2);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + width * fill, y);
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawWord = (
    li: number,
    pl: Placed,
    x: number,
    baseline: number,
    t: number,
  ) => {
    const line = lines[li];
    const w = line.words[pl.k];
    const lastWord = pl.k === line.words.length - 1;
    const { lit, hold, held } = wordProgress(w, t, lastWord, line, pl.k);
    if (pl.k === 0) {
      // Entry glow: swells and brightens like a breath in during a short
      // gap before the line, fullest when it is time to sing.
      const e = entryRing(lines, li, t);
      if (e !== null) {
        const cx = x - em(0.45);
        const cy = baseline - em(0.32);
        const r = em(0.15) * (0.4 + 0.9 * e);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.5);
        g.addColorStop(0, "#ffffff");
        g.addColorStop(0.33, accent);
        g.addColorStop(1, "rgba(255, 61, 127, 0)");
        ctx.save();
        ctx.globalAlpha *= 0.35 + 0.65 * e;
        ctx.shadowColor = accent;
        ctx.shadowBlur = em(0.45) * e;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    // The wipe, with a soft edge on the line being sung (the stage's gradient).
    // Over a picture (classic, subtitle) it's the karaoke-machine look
    // instead: solid white still to sing, filling with pink as it is sung.
    const over = style !== "scroll";
    const todo = over ? "#ffffff" : dim;
    const who = singers[li];
    const [doneA, doneB] = over
      ? who
        ? SINGER_COLORS[who].over
        : [accent, "#ff7aa8"]
      : ["#ffffff", who ? SINGER_COLORS[who].soft : "#ffe0ec"];
    // One soft edge sliding through the line (`wipeEdge`, as on stage).
    const edge = wipeEdge(line, pl.k, t);
    if (lit <= 0 || edge.to <= 0) {
      ctx.fillStyle = todo;
    } else if (edge.from >= 1) {
      const g = ctx.createLinearGradient(x, 0, x + pl.width, 0);
      g.addColorStop(0, doneA);
      g.addColorStop(1, doneB);
      ctx.fillStyle = g;
    } else {
      // From the word's start (or the edge, if it starts before) to the
      // edge's end: done colours, then the fade to unlit.
      const x0 = x + Math.min(0, edge.from) * pl.width;
      const x1 = x + edge.to * pl.width;
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      const span = Math.max(1e-6, x1 - x0);
      g.addColorStop(0, doneA);
      g.addColorStop(Math.min(1, Math.max(0, (x + edge.from * pl.width - x0) / span)), doneB);
      g.addColorStop(1, todo);
      ctx.fillStyle = g;
    }
    if (t >= w.end) {
      ctx.shadowColor = "rgba(255, 61, 127, 0.35)";
      ctx.shadowBlur = em(0.5);
    }
    if (style !== "scroll") {
      // Over a busy picture (classic and subtitle styles): a dark outline.
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.lineJoin = "round";
      ctx.lineWidth = em(0.14);
      ctx.strokeStyle = "rgba(8, 6, 12, 0.8)";
      ctx.strokeText(w.text, x, baseline);
      ctx.restore();
    }
    ctx.fillText(w.text, x, baseline);
    ctx.shadowBlur = 0;
    let after = x + pl.width;
    if (held) {
      // Held note: a tapering trail after the word, lighting up as it is held.
      tail(after + em(0.14), baseline - em(0.36), pl.hold - em(0.14), hold);
      after += pl.hold;
    }
    if (pl.rest) {
      // Rest mark: ’ breath, // pause, ‿ straight on; glowing while it applies.
      const until = lastWord
        ? lines[li + 1]?.start
        : line.words[pl.k + 1]?.start;
      const on = until !== undefined && t >= w.end && t < until;
      ctx.fillStyle = on ? "#ffd2e4" : "rgba(255, 61, 127, 0.45)";
      if (on) {
        ctx.shadowColor = accent;
        ctx.shadowBlur = em(0.35);
      }
      ctx.font = `600 ${Math.round(em(0.62))}px ${font}`;
      const lift = pl.rest === "link" ? em(0.03) : em(0.26);
      ctx.fillText(REST_GLYPH[pl.rest], after + em(0.1), baseline - lift);
      ctx.font = fontLine;
      ctx.shadowBlur = 0;
    }
  };

  /** A frame of the recording's video, filling the canvas (cropped to fit), dimmed for the lyrics. */
  const drawVideo = (frame: VideoFrame) => {
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const s = Math.max(W / fw, H / fh);
    ctx.drawImage(frame, (W - fw * s) / 2, (H - fh * s) / 2, fw * s, fh * s);
    drawShade(ctx, W, H);
  };

  /** The title, artist and the marks' legend, centred, from `top`. */
  const drawIntro = (top: number) => {
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 ${titleSize}px ${font}`;
    ctx.fillText(title, W / 2, top + titleSize * 0.9, maxWidth);
    ctx.fillStyle = "rgba(245, 242, 251, 0.6)";
    ctx.font = `500 ${artistSize}px ${font}`;
    ctx.fillText(
      artist,
      W / 2,
      top + titleSize * 1.05 + em(0.25) + artistSize,
      maxWidth,
    );
    // What the marks mean, accent mark then grey meaning, centred.
    ctx.textAlign = "left";
    const gapX = em(0.5);
    const legend: [string, string][] = pitchOn
      ? [...LEGEND, melodyLook === "dots" ? ["•", "giai điệu (chấm trên chữ)"] : melodyLook === "lane" ? ["▬", "giai điệu (làn nốt)"] : ["∿", "giai điệu (đường dưới câu)"]]
      : LEGEND;
    const parts = legend.map(([m, say]) => {
      ctx.font = `700 ${legendSize}px ${font}`;
      const mw = m ? ctx.measureText(m + " ").width : legendSize * 1.6;
      ctx.font = `500 ${legendSize}px ${font}`;
      return { m, say, mw, sw: ctx.measureText(say).width };
    });
    const total =
      parts.reduce((a, q) => a + q.mw + q.sw, 0) + gapX * (parts.length - 1);
    let lx = (W - total) / 2;
    const ly =
      top +
      titleSize * 1.05 +
      em(0.25) +
      artistSize * 1.3 +
      em(0.35) +
      legendSize;
    for (const q of parts) {
      ctx.font = `700 ${legendSize}px ${font}`;
      ctx.fillStyle = accent;
      // No glyph = the held-note trail.
      if (q.m) ctx.fillText(q.m, lx, ly);
      else tail(lx, ly - legendSize * 0.32, legendSize * 1.2, 1);
      ctx.font = `500 ${legendSize}px ${font}`;
      ctx.fillStyle = "rgba(245, 242, 251, 0.5)";
      ctx.fillText(q.say, lx + q.mw, ly);
      lx += q.mw + q.sw + gapX;
    }
  };

  /** Line `li` from `top`, each row starting at `xOf(row width)`. */
  const drawLine = (
    li: number,
    top: number,
    xOf: (rowWidth: number) => number,
    t: number,
    focused: boolean,
  ) => {
    ctx.font = fontLine;
    const widths = rowWidths[li + 1];
    for (const pl of items[li + 1].words)
      drawWord(
        li,
        pl,
        xOf(widths[pl.row]) + pl.x,
        top + pl.row * lh + em(0.9),
        t,
      );
    const who = singers[li];
    if (who) drawTag(who, xOf(widths[0] ?? 0), top + em(0.9));
    // The melody ribbon, on the line being sung (classic: both rows, each a line to sing next).
    if (focused || style === "classic") {
      if (melodyLook === "ribbon") drawRibbon(li, top, xOf, t);
      else if (melodyLook === "dots") drawDots(li, top, xOf, t);
    }
  };

  /**
   * The melody as dots over the words of line `li`: one per note, higher for
   * higher notes, joined by a faint line; lit once sung.
   */
  const drawDots = (li: number, top: number, xOf: (rowWidth: number) => number, t: number) => {
    const segs = pitches[li];
    if (!segs) return;
    const line = lines[li];
    const widths = rowWidths[li + 1];
    const rows = new Map<number, { x: number; y: number; on: boolean }[]>();
    for (const pl of items[li + 1].words) {
      const ws = segs[pl.k];
      if (!ws?.length) continue;
      const w = line.words[pl.k];
      const dur = Math.max(0.08, w.end - w.start);
      const x = xOf(widths[pl.row]) + pl.x;
      const base = top + pl.row * lh + em(0.9);
      const row = rows.get(pl.row) ?? [];
      for (const sg of ws)
        row.push({ x: x + ((sg.from + sg.to) / 2) * pl.width, y: base - em(1.1) - sg.h * em(0.32), on: t >= w.start + sg.from * dur });
      rows.set(pl.row, row);
    }
    const color = singers[li] ? SINGER_COLORS[singers[li]!].over[1] : "#ff8fc0";
    ctx.save();
    for (const dots of rows.values()) {
      if (style !== "scroll") {
        ctx.strokeStyle = "rgba(8, 6, 12, 0.45)";
        ctx.lineWidth = em(0.06);
        ctx.beginPath();
        dots.forEach((d, k) => (k ? ctx.lineTo(d.x, d.y) : ctx.moveTo(d.x, d.y)));
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      ctx.lineWidth = em(0.022);
      ctx.beginPath();
      dots.forEach((d, k) => (k ? ctx.lineTo(d.x, d.y) : ctx.moveTo(d.x, d.y)));
      ctx.stroke();
      for (const d of dots) {
        ctx.shadowBlur = 0;
        if (style !== "scroll") {
          ctx.fillStyle = "rgba(8, 6, 12, 0.55)";
          ctx.beginPath();
          ctx.arc(d.x, d.y, em(d.on ? 0.09 : 0.075), 0, Math.PI * 2);
          ctx.fill();
        }
        if (d.on) {
          ctx.shadowColor = accent;
          ctx.shadowBlur = em(0.18);
        }
        ctx.fillStyle = d.on ? color : "rgba(255, 255, 255, 0.5)";
        ctx.beginPath();
        ctx.arc(d.x, d.y, em(d.on ? 0.065 : 0.05), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  };

  // The lane: the song's own pitch range (most of its notes), so bars keep their places.
  const laneRange = (() => {
    const ms = (aids.notes ?? []).map((n) => n.midi).sort((a, b) => a - b);
    if (!ms.length) return [60, 72];
    const lo = ms[Math.floor(ms.length * 0.03)];
    const hi = ms[Math.floor(ms.length * 0.97)];
    return [lo - 1, Math.max(hi + 1, lo + 8)];
  })();

  /**
   * The melody as a lane of notes above the lyrics: bars sliding left past a
   * "now" line, higher for higher notes, longer for longer ones; lit once
   * sung, glowing while sung. Shown while there are notes nearby.
   */
  const drawLane = (t: number) => {
    const notes = aids.notes;
    if (!notes?.length) return;
    const rec = t + (aids.offset ?? 0);
    const span = 5;
    const behind = 1.2;
    const from = rec - behind;
    const to = from + span;
    // First note ending after the window starts.
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].end <= from) lo = mid + 1;
      else hi = mid;
    }
    const shown = [];
    for (let k = lo; k < notes.length && notes[k].start < to; k++) shown.push(notes[k]);
    // Fades in and out with the singing around it.
    const near = (k: number) => (k < 0 || k >= notes.length ? Infinity : Math.min(Math.abs(notes[k].start - rec), Math.abs(notes[k].end - rec)));
    const gapTo = Math.min(near(lo - 1), near(lo), shown.length ? 0 : Infinity);
    const alpha = shown.length ? 1 : clamp01(1 - (gapTo - 0.5) / 1.5);
    if (alpha <= 0) return;
    const lx = W * (portrait ? 0.06 : 0.12);
    const lw = W - 2 * lx;
    const lhgt = em(1.15);
    // Scrolling lyrics fill the middle: the lane goes at the top. Classic and
    // subtitles sit low: the lane just above them, close to where the eyes are.
    const lt =
      style === "classic" ? H * 0.66 - em(2.5) : style === "subtitle" ? H - em(6.3) : portrait ? H * 0.12 : H * 0.075;
    const pad = em(0.16);
    const xAt = (s: number) => lx + ((s - from) / span) * lw;
    const now = xAt(rec);
    const [mlo, mhi] = laneRange;
    const yAt = (m: number) => lt + pad + (1 - clamp01((m - mlo) / (mhi - mlo))) * (lhgt - 2 * pad);
    const color = "#ff8fc0";
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = "rgba(10, 8, 16, 0.5)";
    ctx.beginPath();
    ctx.roundRect(lx, lt, lw, lhgt, em(0.2));
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = Math.max(1, em(0.012));
    for (let k = 1; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(lx + pad, lt + (k * lhgt) / 4);
      ctx.lineTo(lx + lw - pad, lt + (k * lhgt) / 4);
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(lx + pad * 0.5, lt, lw - pad, lhgt);
    ctx.clip();
    const bar = em(0.11);
    for (const n of shown) {
      const a = xAt(n.start);
      const b = Math.max(a + bar, xAt(n.end) - em(0.03));
      const y = yAt(n.midi) - bar / 2;
      const past = n.end <= rec;
      const cur = n.start <= rec && rec < n.end;
      ctx.shadowBlur = 0;
      if (cur) {
        ctx.shadowColor = accent;
        ctx.shadowBlur = em(0.25);
      }
      ctx.fillStyle = cur ? color : past ? "rgba(255, 143, 192, 0.7)" : "rgba(255, 255, 255, 0.32)";
      ctx.beginPath();
      ctx.roundRect(a, y, b - a, bar, bar / 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
    ctx.lineWidth = Math.max(1.5, em(0.025));
    ctx.beginPath();
    ctx.moveTo(now, lt + em(0.08));
    ctx.lineTo(now, lt + lhgt - em(0.08));
    ctx.stroke();
    ctx.restore();
  };

  /**
   * The melody ribbon under each row of line `li`: a thin line that rises
   * and falls with the original melody under the words, lit up to where the
   * singing is, with a dot there.
   */
  const drawRibbon = (li: number, top: number, xOf: (rowWidth: number) => number, t: number) => {
    const segs = pitches[li];
    if (!segs) return;
    const line = lines[li];
    const widths = rowWidths[li + 1];
    type Span = { k: number; x: number; w: number };
    const rows = new Map<number, { pts: [number, number][]; lit: number; head: [number, number] | null; words: Span[]; tails: Span[] }>();
    for (const pl of items[li + 1].words) {
      const ws = segs[pl.k];
      if (!ws?.length) continue;
      const x = xOf(widths[pl.row]) + pl.x;
      const base = top + pl.row * lh + em(0.9);
      const yOf = (h: number) => base + em(0.34) + (1 - h) * em(0.38);
      const row = rows.get(pl.row) ?? { pts: [], lit: -Infinity, head: null, words: [], tails: [] };
      for (const sg of ws) {
        // Always forward (a curve that turned back would look like a scribble).
        const prev = row.pts.length ? row.pts[row.pts.length - 1][0] : -Infinity;
        const a = Math.max(prev + em(0.02), x + sg.from * pl.width + em(0.04));
        const b = Math.max(a + em(0.04), x + sg.to * pl.width - em(0.04));
        row.pts.push([a, yOf(sg.h)], [b, yOf(sg.h)]);
      }
      row.words.push({ k: pl.k, x, w: pl.width });
      // A held note: the ribbon runs on under its trail, gently waving.
      if (pl.hold > 0 && row.pts.length) {
        const tx = x + pl.width + em(0.14);
        const y = row.pts[row.pts.length - 1][1];
        row.pts.push(...wavyTail(row.pts[row.pts.length - 1][0], tx + pl.hold - em(0.14), y, em(0.035), em(0.16)));
        row.tails.push({ k: pl.k, x: tx, w: pl.hold - em(0.14) });
      }
      rows.set(pl.row, row);
    }
    // Where the singing is: with the text's wipe, crossing the spaces too,
    // and on along a held note's trail.
    rows.forEach((row) => {
      row.lit = litAlong(line, row.words, t);
      for (const tl of row.tails) {
        const { hold } = wordProgress(line.words[tl.k], t, tl.k === line.words.length - 1, line, tl.k);
        if (hold > 0) row.lit = Math.max(row.lit, tl.x + hold * tl.w);
      }
    });
    // Resting: the dot breathes, so stillness reads as a rest, not a stop.
    const rest = restAt(line, t);
    const puff = rest ? breath(rest.f, line.words[rest.k + 1].start - line.words[rest.k].end) : 1;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const color = singers[li] ? SINGER_COLORS[singers[li]!].over[1] : "#ff8fc0";
    for (const row of rows.values()) {
      const P = row.pts;
      if (P.length < 2) continue;
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]);
        for (let k = 1; k < P.length; k++) {
          const [px, py] = P[k - 1];
          const [cx, cy] = P[k];
          const mx = (px + cx) / 2;
          ctx.bezierCurveTo(mx, py, mx, cy, cx, cy);
        }
      };
      if (style !== "scroll") {
        ctx.strokeStyle = "rgba(8, 6, 12, 0.5)";
        ctx.lineWidth = em(0.09);
        path();
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = em(0.045);
      path();
      ctx.stroke();
      if (row.lit > P[0][0]) {
        const litTo = Math.min(row.lit, P[P.length - 1][0]);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, litTo, H);
        ctx.clip();
        ctx.shadowColor = accent;
        ctx.shadowBlur = em(0.18);
        ctx.strokeStyle = color;
        ctx.lineWidth = em(0.055);
        path();
        ctx.stroke();
        ctx.restore();
        // The dot where the singing is, while the row is being sung.
        if (row.lit < P[P.length - 1][0]) {
          let y = P[0][1];
          for (let k = 1; k < P.length; k++) {
            if (P[k][0] >= litTo) {
              const u = clamp01((litTo - P[k - 1][0]) / Math.max(1, P[k][0] - P[k - 1][0]));
              const e = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
              y = P[k - 1][1] + (P[k][1] - P[k - 1][1]) * e;
              break;
            }
          }
          ctx.shadowColor = accent;
          ctx.shadowBlur = em(0.22);
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(litTo, y, em(0.07) * puff, 0, Math.PI * 2);
          ctx.fill();
          // Resting: a small ring round the dot fills until the next word.
          if (rest) {
            const r = em(0.15);
            ctx.shadowBlur = 0;
            ctx.lineWidth = em(0.025);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
            ctx.beginPath();
            ctx.arc(litTo, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = accent;
            ctx.shadowColor = accent;
            ctx.shadowBlur = em(0.08);
            ctx.beginPath();
            ctx.arc(litTo, y, r, -Math.PI / 2, -Math.PI / 2 + rest.f * Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }
    ctx.restore();
  };
  /** The singer's tag left of a line's first row (above it when there is no room). */
  const drawTag = (who: Singer, x0: number, baseline: number) => {
    const label = SINGER_LABEL[who].toUpperCase();
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.font = `700 ${Math.round(em(0.3))}px ${font}`;
    const pw = ctx.measureText(label).width + em(0.36);
    const ph = em(0.44);
    let x = x0 - pw - em(0.22);
    let y = baseline - em(0.33) - ph / 2;
    if (x < em(0.2)) {
      x = x0;
      y = baseline - em(0.95) - ph;
    }
    ctx.fillStyle = SINGER_COLORS[who].tag;
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, ph / 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + em(0.18), y + ph / 2 + em(0.01));
    ctx.restore();
  };
  const lineHeight = (li: number) => items[li + 1]?.height ?? lh;

  /** The countdown: dots for short gaps, the seconds-and-bar panel for
   * breaks, centred on `cx` with its bottom at `bottom`. */
  const drawCue = (
    cue: ReturnType<typeof cueAt>,
    cx: number,
    bottom: number,
  ) => {
    if (cue.breakLeft > 0) {
      const bw = Math.min(W * 0.4, em(4.2));
      const by = bottom - em(0.2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
      ctx.fillRect(cx - bw / 2, by, bw, Math.max(3, em(0.08)));
      ctx.fillStyle = accent;
      ctx.fillRect(cx - bw / 2, by, bw * cue.bar, Math.max(3, em(0.08)));
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(245, 242, 251, 0.85)";
      ctx.font = `600 ${Math.round(em(0.36))}px ${font}`;
      ctx.fillText(
        `♪ ${cue.intro ? "Dạo đầu" : "Nhạc dạo"} · ${cue.breakLeft}s`,
        cx,
        by - em(0.3),
      );
      ctx.textAlign = "left";
    } else if (cue.count > 0) {
      const r = em(0.14);
      const gap = em(0.27);
      const n = cue.dots;
      const width = n * 2 * r + (n - 1) * gap;
      Array.from({ length: n }, (_, j) => n - j).forEach((num, j) => {
        const on = cue.count <= num;
        ctx.beginPath();
        ctx.arc(
          cx - width / 2 + r + j * (2 * r + gap),
          bottom - r,
          on ? r * 1.15 : r,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = on ? accent : "rgba(255, 255, 255, 0.18)";
        if (on) {
          ctx.shadowColor = accent;
          ctx.shadowBlur = em(0.3);
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      });
    }
  };

  /** Lines gliding up through the middle, as on the stage. */
  const scrollFrame = (t: number) => {
    const i = lineAt(lines, t);
    const f = focusAt(lines, i, t);
    const e = f < 0 ? 1 : glideEase((t - focusSince(lines, f)) / GLIDE);
    const pos = f - 1 + e; // fractional focus, for scroll and fades
    const topOf = (k: number) =>
      items[Math.max(0, Math.min(items.length - 1, k + 1))].top;
    const from = topOf(f - 1);
    const to = topOf(f);
    const shift = anchorY - (from + (to - from) * e);
    for (
      let k = Math.max(-1, Math.floor(pos) - 1);
      k <= Math.min(lines.length - 1, Math.ceil(pos) + 3);
      k++
    ) {
      const item = items[k + 1];
      const { alpha, scale } = look(k - pos);
      if (alpha <= 0.01) continue;
      const top = item.top + shift;
      const cy = top + item.height / 2;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(W / 2, cy);
      ctx.scale(scale, scale);
      ctx.translate(-W / 2, -cy);
      if (k < 0) drawIntro(top);
      else drawLine(k, top, (rw) => (W - rw) / 2, t, Math.abs(k - pos) < 0.5);
      ctx.restore();
    }
    drawCue(cueAt(lines, i, t, aids.beats), W / 2, anchorY - em(0.35));
  };

  /** Before the lines come up (classic and subtitle): the title in the middle. */
  const introUntil = lines.length ? lines[0].start - LEAD_IN - 0.5 : Infinity;
  const introFrame = (t: number) => {
    const fade = Math.min(1, Math.max(0, (introUntil - t) / 0.4));
    ctx.save();
    ctx.globalAlpha = fade;
    drawIntro(H * 0.42 - items[0].height / 2);
    ctx.restore();
  };

  /** Classic karaoke: two lines low on screen, the upper one left, the lower
   * one right; each slot moves on to the line after next once its line is sung. */
  // Classic style: lines alternate top and bottom row, starting again at the
  // top after every pause long enough for a countdown (and after the intro's
  // ♪♪♪ placeholder), so the line sung after a rest is always the upper one.
  const rowOf: number[] = [];
  lines.forEach((l, k) => {
    const prev = lines[k - 1];
    rowOf.push(!prev || l.start - prev.end >= COUNT_GAP ? 0 : 1 - rowOf[k - 1]);
  });
  const classicFrame = (t: number) => {
    const i = lineAt(lines, t);
    if (t < introUntil) introFrame(t);
    const margin = Math.max(em(0.9), W * 0.06);
    const showFrom = Math.min(introUntil, lines[0]?.start ?? 0);
    const slot = (s: number) => {
      // The first line of this row not sung yet (a moment after it ends).
      let k = 0;
      let before = -1;
      // (A line lingers half a second after it ends, unless a later one has started.)
      while (k < lines.length && (rowOf[k] !== s || lines[k].end + 0.5 <= t || k < i)) {
        if (rowOf[k] === s) before = k;
        k++;
      }
      if (k >= lines.length || k > Math.max(i, -1) + 2 || t < showFrom - 0.4)
        return null;
      const since = before >= 0 ? lines[before].end + 0.5 : showFrom - 0.4;
      return { k, alpha: Math.min(1, Math.max(0, (t - since) / 0.3)) };
    };
    let a = slot(0);
    let b = slot(1);
    // Read top to bottom in the order sung: a later line never shows above
    // the one waiting to be sung, only below it.
    const next = Math.max(i, -1) + 1;
    if (a && a.k > next) a = null;
    if (b && b.k > next && a?.k !== next) b = null;
    const top0 = H * 0.66;
    const top1 = top0 + lh + em(0.3);
    for (const [sl, top, left] of [
      [a, top0, true],
      [b, top1, false],
    ] as const) {
      if (!sl) continue;
      // One row per line: a line too long for the frame is drawn smaller,
      // on the same baseline, rather than wrapped below the frame.
      const rw = rowWidths[sl.k + 1]?.[0] ?? 0;
      const s = Math.min(1, (W - 2 * margin) / Math.max(1, rw));
      const x0 = left ? margin : W - margin - rw * s;
      ctx.save();
      ctx.globalAlpha = sl.alpha;
      ctx.translate(x0, top + em(0.9) * (1 - s));
      ctx.scale(s, s);
      drawLine(sl.k, 0, () => 0, t, sl.k === i);
      ctx.restore();
    }
    drawCue(cueAt(lines, i, t, aids.beats), W / 2, top0 - em(0.35));
  };

  /** Subtitles: the line to sing near the bottom, the next one smaller
   * under it; the rest of the picture stays clear. */
  const subtitleFrame = (t: number) => {
    const i = lineAt(lines, t);
    const f = focusAt(lines, i, t);
    if (f < 0) {
      introFrame(t);
      drawCue(cueAt(lines, i, t, aids.beats), W / 2, H * 0.8);
      return;
    }
    const e = glideEase((t - focusSince(lines, f)) / GLIDE);
    const small = 0.72;
    const nextH = lines[f + 1] ? lineHeight(f + 1) * small : 0;
    const nextTop = H - em(0.7) - nextH;
    const top = nextTop - em(0.15) - lineHeight(f);
    const centred = (rw: number) => (W - rw) / 2;
    // The line just sung fades out where the new one fades in.
    if (f > 0 && e < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - e;
      drawLine(f - 1, top, centred, t, false);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = e;
    drawLine(f, top, centred, t, true);
    ctx.restore();
    if (lines[f + 1]) {
      const cy = nextTop + nextH / 2;
      ctx.save();
      ctx.globalAlpha = 0.6 * e;
      ctx.translate(W / 2, cy);
      ctx.scale(small, small);
      ctx.translate(-W / 2, -cy);
      drawLine(f + 1, cy - lineHeight(f + 1) / 2, centred, t, false);
      ctx.restore();
    }
    drawCue(cueAt(lines, i, t, aids.beats), W / 2, top - em(0.3));
  };

  /** `frame`: the video's picture under the lyrics, null for the artwork,
   * "clear" for the lyrics alone on a transparent frame (laid over the
   * background by ffmpeg). */
  return (t: number, frame: VideoFrame | null | "clear" = null) => {
    if (frame === "clear") ctx.clearRect(0, 0, W, H);
    else if (frame) drawVideo(frame);
    else ctx.drawImage(bg, 0, 0);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    if (style === "classic") classicFrame(t);
    else if (style === "subtitle") subtitleFrame(t);
    else scrollFrame(t);
    if (pitchOn && melodyLook === "lane") drawLane(t);
  };
}

/**
 * The rows of a transparent lyric frame that hold anything, from row `y`
 * (even), `rows` of them (even), converted to yuva420p as ffmpeg overlays it
 * with no conversion of its own: planes Y, U, V (half size), A, one after
 * another. BT.601 limited range, as ffmpeg's own conversion. Empty when the
 * frame is blank.
 */
export function lyricBand(
  ctx: OffscreenCanvasRenderingContext2D,
  W: number,
  FH: number,
  /** Rows drawn on this frame (`trackExtent`): only those are read back. */
  drawn: [number, number] | null = [0, FH],
): { y: number; rows: number; data: ArrayBuffer } {
  if (!drawn) return { y: 0, rows: 0, data: new ArrayBuffer(0) };
  // Reading pixels back is the slow part (8 MB for a whole frame): read the
  // drawn rows only, from an even row.
  const from = Math.max(0, Math.floor(drawn[0])) & ~1;
  const H = Math.min(FH, Math.ceil(drawn[1])) - from;
  if (H <= 0) return { y: 0, rows: 0, data: new ArrayBuffer(0) };
  const img = ctx.getImageData(0, from, W, H);
  const rgba = img.data;
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H);
  const blank = (y: number) => {
    // Alpha only (the top byte, little-endian): what's fully transparent is blank.
    for (let x = y * W, end = x + W; x < end; x++) if (px[x] >>> 24) return false;
    return true;
  };
  let top = 0;
  while (top < H && blank(top)) top++;
  if (top === H) return { y: 0, rows: 0, data: new ArrayBuffer(0) };
  let bottom = H - 1;
  while (bottom > top && blank(bottom)) bottom--;
  top -= top % 2;
  const rows = Math.min(H - top, bottom - top + 1 + ((bottom - top + 1) % 2));
  const n = W * rows;
  const cw = W >> 1;
  const out = new Uint8Array(n * 2 + (n >> 1));
  const Y = out.subarray(0, n);
  const U = out.subarray(n, n + (n >> 2));
  const V = out.subarray(n + (n >> 2), n + (n >> 1));
  const A = out.subarray(n + (n >> 1));
  const base = top * W * 4;
  for (let i = 0, o = base; i < n; i++, o += 4) {
    const a = rgba[o + 3];
    A[i] = a;
    // Integer BT.601 (as ffmpeg): no work at all where it's transparent.
    Y[i] = a ? 16 + ((66 * rgba[o] + 129 * rgba[o + 1] + 25 * rgba[o + 2] + 128) >> 8) : 16;
  }
  // Chroma per 2×2 block, weighted by alpha (so transparent pixels don't grey the edges).
  // (Plain index arithmetic: this runs for every frame, so no arrays per pixel.)
  const stride = W * 4;
  for (let r = 0; r < rows; r += 2) {
    let o = base + r * stride;
    let k = (r >> 1) * cw;
    for (let c = 0; c < cw; c++, o += 8, k++) {
      const a0 = rgba[o + 3], a1 = rgba[o + 7], a2 = rgba[o + stride + 3], a3 = rgba[o + stride + 7];
      const sa = a0 + a1 + a2 + a3;
      if (sa === 0) {
        U[k] = 128;
        V[k] = 128;
        continue;
      }
      const R = (rgba[o] * a0 + rgba[o + 4] * a1 + rgba[o + stride] * a2 + rgba[o + stride + 4] * a3) / sa;
      const G = (rgba[o + 1] * a0 + rgba[o + 5] * a1 + rgba[o + stride + 1] * a2 + rgba[o + stride + 5] * a3) / sa;
      const B = (rgba[o + 2] * a0 + rgba[o + 6] * a1 + rgba[o + stride + 2] * a2 + rgba[o + stride + 6] * a3) / sa;
      U[k] = 128 + (-37.945 * R - 74.494 * G + 112.439 * B) / 256 + 0.5;
      V[k] = 128 + (112.439 * R - 94.154 * G - 18.285 * B) / 256 + 0.5;
    }
  }
  return { y: from + top, rows, data: out.buffer };
}

/**
 * Follow which rows of `ctx` (`H` high) get drawn on: every text, rectangle
 * and path point marks its rows (through the current transform, with room
 * for glows and outlines). `range()` gives the rows drawn since `reset()`,
 * or null when nothing was.
 */
export function trackExtent(ctx: OffscreenCanvasRenderingContext2D, H: number) {
  let lo = Infinity;
  let hi = -Infinity;
  const mark = (y0: number, y1: number) => {
    const m = ctx.getTransform();
    const room = ctx.shadowBlur * 2 + ctx.lineWidth + 6;
    const [a, b] = [m.d * y0 + m.f, m.d * y1 + m.f];
    lo = Math.min(lo, Math.min(a, b) - room);
    hi = Math.max(hi, Math.max(a, b) + room);
  };
  const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 48);
  const wrap = <K extends keyof OffscreenCanvasRenderingContext2D>(name: K, extent: (...args: number[]) => [number, number]) => {
    const orig = (ctx[name] as (...a: unknown[]) => unknown).bind(ctx);
    (ctx as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const nums = args.map((v) => (typeof v === "number" ? v : NaN));
      mark(...extent(...nums));
      return orig(...args);
    };
  };
  // Text: from above the stacked Vietnamese accents to below the descenders.
  const text = (_t: number, _x: number, y: number): [number, number] => [y - size() * 1.3, y + size() * 0.5];
  wrap("fillText", text);
  wrap("strokeText", text);
  wrap("fillRect", (_x, y, _w, h) => [y, y + h]);
  wrap("strokeRect", (_x, y, _w, h) => [y, y + h]);
  wrap("roundRect", (_x, y, _w, h) => [y, y + h]);
  wrap("arc", (_x, y, r) => [y - r, y + r]);
  wrap("moveTo", (_x, y) => [y, y]);
  wrap("lineTo", (_x, y) => [y, y]);
  wrap("bezierCurveTo", (_a, y1, _b, y2, _x, y) => [Math.min(y1, y2, y), Math.max(y1, y2, y)]);
  wrap("drawImage", () => [0, H]);
  return {
    reset() {
      lo = Infinity;
      hi = -Infinity;
    },
    range(): [number, number] | null {
      return hi < lo ? null : [Math.max(0, lo), Math.min(H, hi)];
    },
  };
}

/** An opaque picture (`canvas`, even width and height) as yuv420p: planes Y, U, V; BT.601 limited, as `lyricBand`. */
export function stillYuv(canvas: OffscreenCanvas): Uint8Array {
  const W = canvas.width;
  const H = canvas.height;
  const rgba = canvas.getContext("2d")!.getImageData(0, 0, W, H).data;
  const n = W * H;
  const cw = W >> 1;
  const out = new Uint8Array(n + (n >> 1));
  const U = out.subarray(n, n + (n >> 2));
  const V = out.subarray(n + (n >> 2));
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = 16 + ((65.738 * rgba[o] + 129.057 * rgba[o + 1] + 25.064 * rgba[o + 2]) / 256 + 0.5);
  }
  for (let r = 0; r < H; r += 2) {
    for (let c = 0; c < cw; c++) {
      let R = 0, G = 0, B = 0;
      for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const o = ((r + dr) * W + 2 * c + dc) * 4;
        R += rgba[o];
        G += rgba[o + 1];
        B += rgba[o + 2];
      }
      const k = (r >> 1) * cw + c;
      U[k] = 128 + (-37.945 * R - 74.494 * G + 112.439 * B) / 1024 + 0.5;
      V[k] = 128 + (112.439 * R - 94.154 * G - 18.285 * B) / 1024 + 0.5;
    }
  }
  return out;
}
