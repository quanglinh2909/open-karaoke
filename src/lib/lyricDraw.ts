/*
 * Drawing one frame of the karaoke video: pure canvas code with no app
 * state, so it also runs in the export's worker threads (exportWorker.ts).
 */
import { lineAt, type Line } from "./lrc";
import {
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
) {
  const portrait = H > W;
  // Same proportions as the stage: one size for every line, wrapped once.
  const size = Math.round(portrait ? W * 0.068 : H * 0.072);
  const em = (x: number) => x * size;
  const lh = em(1.15);
  const margin = em(0.16);
  const maxWidth = W - 2 * Math.max(em(0.9), W * 0.05);
  const fontLine = `700 ${size}px ${font}`;
  ctx.font = fontLine;
  const space = ctx.measureText(" ").width;

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
    line.words.forEach((w, k) => {
      const last = k === line.words.length - 1;
      const width = ctx.measureText(w.text).width;
      // A stand-in for unheard singing (♪♪♪) has no held-note trail.
      const hold = isHeld(w, last) && !line.hum ? em(holdLength(w) + 0.14) : 0;
      const rest = last ? lineJoin(lines, li) : restAfter(line, k);
      const total = width + hold + em(restWidth(rest));
      // Classic karaoke keeps each line on one row (shrunk to fit when drawn).
      if (x > 0 && x + space + total > maxWidth && style !== "classic") {
        row++;
        x = 0;
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
    focused: boolean,
  ) => {
    const line = lines[li];
    const w = line.words[pl.k];
    const lastWord = pl.k === line.words.length - 1;
    const { lit, hold, held } = wordProgress(w, t, lastWord);
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
    if (lit <= 0) {
      ctx.fillStyle = todo;
    } else {
      const g = ctx.createLinearGradient(x, 0, x + pl.width, 0);
      g.addColorStop(0, doneA);
      if (lit < 1) {
        g.addColorStop(focused ? Math.max(0, lit - 0.04) : lit, doneB);
        g.addColorStop(lit, todo);
        g.addColorStop(1, todo);
      } else {
        g.addColorStop(1, doneB);
      }
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
    const parts = LEGEND.map(([m, say]) => {
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
        focused,
      );
    const who = singers[li];
    if (who) drawTag(who, xOf(widths[0] ?? 0), top + em(0.9));
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
      [3, 2, 1].slice(3 - n).forEach((num, j) => {
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
    drawCue(cueAt(lines, i, t), W / 2, anchorY - em(0.35));
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
    drawCue(cueAt(lines, i, t), W / 2, top0 - em(0.35));
  };

  /** Subtitles: the line to sing near the bottom, the next one smaller
   * under it; the rest of the picture stays clear. */
  const subtitleFrame = (t: number) => {
    const i = lineAt(lines, t);
    const f = focusAt(lines, i, t);
    if (f < 0) {
      introFrame(t);
      drawCue(cueAt(lines, i, t), W / 2, H * 0.8);
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
    drawCue(cueAt(lines, i, t), W / 2, top - em(0.3));
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
  };
}

/**
 * The rows of a transparent lyric frame that hold anything, from row `y`
 * (even), `rows` of them (even), converted to yuva420p as ffmpeg overlays it
 * with no conversion of its own: planes Y, U, V (half size), A, one after
 * another. BT.601 limited range, as ffmpeg's own conversion. Empty when the
 * frame is blank.
 */
export function lyricBand(ctx: OffscreenCanvasRenderingContext2D, W: number, H: number): { y: number; rows: number; data: ArrayBuffer } {
  const img = ctx.getImageData(0, 0, W, H);
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
  for (let i = 0; i < n; i++) {
    const o = base + i * 4;
    const a = rgba[o + 3];
    A[i] = a;
    Y[i] = a ? 16 + ((65.738 * rgba[o] + 129.057 * rgba[o + 1] + 25.064 * rgba[o + 2]) / 256 + 0.5) : 16;
  }
  // Chroma per 2×2 block, weighted by alpha (so transparent pixels don't grey the edges).
  for (let r = 0; r < rows; r += 2) {
    for (let c = 0; c < cw; c++) {
      let sa = 0, sr = 0, sg = 0, sb = 0;
      for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const o = base + ((r + dr) * W + 2 * c + dc) * 4;
        const a = rgba[o + 3];
        sa += a;
        sr += rgba[o] * a;
        sg += rgba[o + 1] * a;
        sb += rgba[o + 2] * a;
      }
      const k = (r >> 1) * cw + c;
      if (!sa) {
        U[k] = 128;
        V[k] = 128;
        continue;
      }
      const [R, G, B] = [sr / sa, sg / sa, sb / sa];
      U[k] = 128 + (-37.945 * R - 74.494 * G + 112.439 * B) / 256 + 0.5;
      V[k] = 128 + (112.439 * R - 94.154 * G - 18.285 * B) / 256 + 0.5;
    }
  }
  return { y: top, rows, data: out.buffer };
}
