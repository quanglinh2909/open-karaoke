import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Muxer, StreamTarget } from "mp4-muxer";
import { lineAt, type Line } from "./lrc";
import {
  ANCHOR,
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
import { useStore } from "./store";
import { VideoFrames } from "./videoFrames";

export type Orientation = "landscape" | "portrait";
/** How the lyrics are laid out: gliding through the middle (as on stage),
 * classic two-line karaoke at the bottom, or subtitles. */
export type LyricStyle = "scroll" | "classic" | "subtitle";

const FPS = 30;

const SIZES: Record<Orientation, [number, number]> = {
  landscape: [1280, 720],
  portrait: [720, 1280],
};
/** Over the recording's own HD video: Full HD. */
const HD_SIZES: Record<Orientation, [number, number]> = {
  landscape: [1920, 1080],
  portrait: [1080, 1920],
};

/**
 * Render the open song as a karaoke video: the instrumental (at the current
 * key and tempo) with word-by-word lyrics over the blurred artwork, drawn
 * like the stage (gliding lines, rests, held notes, countdowns). Encoded in
 * the webview (WebCodecs H.264 + AAC/Opus) and saved as MP4 in the
 * recordings folder. Returns the file's path.
 */
export async function exportKaraokeVideo(
  orientation: Orientation,
  style: LyricStyle,
  onProgress: (f: number) => void,
  cancelled: () => boolean,
): Promise<string> {
  const song = useStore.getState().song;
  if (!song?.info) throw new Error("Chưa mở bài hát nào");
  const lines = song.lyrics.lines ?? [];
  const tempo = song.info.tempo || 1;
  const offset = song.userOffset;
  // Over the recording's own video when it is the background: Full HD.
  const videoPath =
    useStore.getState().videoBg && song.video?.status === "ready"
      ? song.video.path
      : undefined;
  const [W, H] = (videoPath ? HD_SIZES : SIZES)[orientation];
  const bitrate = videoPath ? 10_000_000 : 4_000_000;

  // ---- audio
  const raw = await invoke<ArrayBuffer>("export_audio");
  const sr = new DataView(raw).getUint32(0, true);
  const all = new Float32Array(raw, 4);
  // Only the part between the song's trims (no ads at either end).
  const trim = song.trim ?? { start: 0, end: 0 };
  const samples = all.length / 2;
  const first = Math.min(samples, Math.round((trim.start / tempo) * sr));
  const last = Math.max(first, samples - Math.round((trim.end / tempo) * sr));
  const pcm = all.subarray(first * 2, last * 2);
  const skip = first / sr;
  const frames = pcm.length / 2;
  const duration = frames / sr;

  const video = await pickVideoCodec(W, H, bitrate);
  const audio = await pickAudioCodec(sr);
  if (!video) throw new Error("Máy này không mã hóa được video H.264.");
  if (!audio)
    throw new Error("Máy này không mã hóa được âm thanh AAC hoặc Opus.");

  // Written to disk as the muxer produces it, 8 MB at a time and in order:
  // a Full HD export runs to hundreds of MB, too much to hold and hand over
  // in one call. The `.part` file is renamed when done, dropped on failure.
  const name = `${song.meta.artist} - ${song.meta.title} (karaoke)`;
  const part = await invoke<string>("video_begin", { name });
  let writes: Promise<unknown> = Promise.resolve();
  let writeError: unknown = null;
  const target = new StreamTarget({
    chunked: true,
    chunkSize: 8 * 1024 * 1024,
    onData: (data, position) => {
      const piece = data.slice();
      writes = writes
        .then(() =>
          invoke("video_write", piece, {
            headers: {
              "x-path": encodeURIComponent(part),
              "x-pos": String(position),
            },
          }),
        )
        .catch((e) => (writeError = e));
    },
  });
  try {
    const muxer = new Muxer({
      target,
      video: { codec: "avc", width: W, height: H, frameRate: FPS },
      audio: { codec: audio.mux, numberOfChannels: 2, sampleRate: sr },
      fastStart: false,
    });
    let failure: unknown = null;

    const aenc = new AudioEncoder({
      output: (c, m) => muxer.addAudioChunk(c, m),
      error: (e) => (failure = e),
    });
    aenc.configure({
      codec: audio.codec,
      sampleRate: sr,
      numberOfChannels: 2,
      bitrate: 192_000,
    });
    const block = 4096;
    for (let at = 0; at < frames; at += block) {
      const n = Math.min(block, frames - at);
      const planar = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        planar[i] = pcm[(at + i) * 2];
        planar[n + i] = pcm[(at + i) * 2 + 1];
      }
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: sr,
        numberOfFrames: n,
        numberOfChannels: 2,
        timestamp: Math.round((at / sr) * 1e6),
        data: planar,
      });
      aenc.encode(data);
      data.close();
    }
    await aenc.flush();
    aenc.close();
    if (failure) throw failure;
    onProgress(0.03);

    // ---- video
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d")!;
    const bg = await background(song.meta.artwork, W, H);
    const css = getComputedStyle(document.documentElement);
    const font = css.getPropertyValue("--font-display").trim() || "sans-serif";
    const accent = css.getPropertyValue("--accent").trim() || "#ff3d7f";
    const draw = drawer(
      ctx,
      W,
      H,
      bg,
      font,
      accent,
      lines,
      song.meta.title,
      song.meta.artist,
      style,
    );

    const venc = new VideoEncoder({
      output: (c, m) => muxer.addVideoChunk(c, m),
      error: (e) => (failure = e),
    });
    venc.configure({
      codec: video,
      width: W,
      height: H,
      bitrate,
      framerate: FPS,
    });
    const total = Math.ceil(duration * FPS);
    // The original video, decoded in step with the frames we write.
    const source = videoPath
      ? await VideoFrames.open(convertFileSrc(videoPath))
      : null;
    source?.seek(skip * tempo);
    try {
      for (let i = 0; i < total; i++) {
        if (cancelled()) {
          venc.close();
          throw new Error("cancelled");
        }
        if (failure) throw failure;
        // Output time → recording time (the original video's and the lyrics' clock).
        const at = (skip + i / FPS) * tempo;
        draw(at - offset, source ? await source.at(at) : null);
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((i * 1e6) / FPS),
          duration: Math.round(1e6 / FPS),
        });
        venc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        while (venc.encodeQueueSize > 8)
          await new Promise((r) => setTimeout(r, 1));
        if (i % 15 === 0) {
          onProgress(0.03 + 0.95 * (i / total));
          await new Promise((r) => setTimeout(r, 0));
          if (writeError) throw writeError;
        }
      }
    } finally {
      source?.close();
    }
    await venc.flush();
    venc.close();
    if (failure) throw failure;
    muxer.finalize();
    onProgress(0.99);
    await writes;
    if (writeError) throw writeError;
    return await invoke<string>("video_finish", { path: part });
  } catch (e) {
    await writes;
    void invoke("video_abort", { path: part });
    throw e;
  }
}

async function pickVideoCodec(
  width: number,
  height: number,
  bitrate: number,
): Promise<string | null> {
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
    const r = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate,
      framerate: FPS,
    }).catch(() => null);
    if (r?.supported) return codec;
  }
  return null;
}

async function pickAudioCodec(
  sampleRate: number,
): Promise<{ codec: string; mux: "aac" | "opus" } | null> {
  for (const [codec, mux] of [
    ["mp4a.40.2", "aac"],
    ["opus", "opus"],
  ] as const) {
    const r = await AudioEncoder.isConfigSupported({
      codec,
      sampleRate,
      numberOfChannels: 2,
      bitrate: 192_000,
    }).catch(() => null);
    if (r?.supported) return { codec, mux };
  }
  return null;
}

/** The blurred, darkened artwork filling the frame (or a plain gradient). */
async function background(
  artwork: string | null,
  W: number,
  H: number,
): Promise<OffscreenCanvas> {
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1a1024");
  grad.addColorStop(1, "#0b0a10");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  if (!artwork) return c;
  try {
    const blob = await (await fetch(artwork)).blob();
    const img = await createImageBitmap(blob);
    const s = Math.max(W / img.width, H / img.height) * 1.15;
    g.filter = "blur(36px) brightness(0.38) saturate(1.2)";
    g.drawImage(
      img,
      (W - img.width * s) / 2,
      (H - img.height * s) / 2,
      img.width * s,
      img.height * s,
    );
    g.filter = "none";
  } catch {
    // Artwork unavailable (offline or blocked): keep the gradient.
  }
  return c;
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
      if (x > 0 && x + space + total > maxWidth) {
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
    const [doneA, doneB] = over ? [accent, "#ff7aa8"] : ["#ffffff", "#ffe0ec"];
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
    const shade = ctx.createRadialGradient(
      W / 2,
      H * 0.42,
      0,
      W / 2,
      H * 0.42,
      Math.max(W, H) * 0.75,
    );
    shade.addColorStop(0, "rgba(11, 10, 16, 0.5)");
    shade.addColorStop(1, "rgba(11, 10, 16, 0.75)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, W, H);
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
  const classicFrame = (t: number) => {
    const i = lineAt(lines, t);
    if (t < introUntil) introFrame(t);
    const margin = Math.max(em(0.9), W * 0.06);
    const showFrom = Math.min(introUntil, lines[0]?.start ?? 0);
    const slot = (s: number) => {
      // The first line of this slot not sung yet (a moment after it ends).
      let k = s;
      while (k < lines.length && lines[k].end + 0.5 <= t) k += 2;
      if (k >= lines.length || k > Math.max(i, -1) + 2 || t < showFrom - 0.4)
        return null;
      const since = k >= 2 ? lines[k - 2].end + 0.5 : showFrom - 0.4;
      return { k, alpha: Math.min(1, Math.max(0, (t - since) / 0.3)) };
    };
    const a = slot(0);
    const b = slot(1);
    const top0 = H * 0.66;
    const top1 = top0 + Math.max(lineHeight(a?.k ?? 0), lh) + em(0.3);
    for (const [sl, top, xOf] of [
      [a, top0, () => margin],
      [b, top1, (rw: number) => W - margin - rw],
    ] as const) {
      if (!sl) continue;
      ctx.save();
      ctx.globalAlpha = sl.alpha;
      drawLine(sl.k, top, xOf, t, sl.k === i);
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

  return (t: number, frame: VideoFrame | null = null) => {
    if (frame) drawVideo(frame);
    else ctx.drawImage(bg, 0, 0);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    if (style === "classic") classicFrame(t);
    else if (style === "subtitle") subtitleFrame(t);
    else scrollFrame(t);
  };
}
