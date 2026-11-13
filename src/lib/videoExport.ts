import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FAST_FAMILY } from "./canvasRecorder";
import { Muxer, StreamTarget } from "mp4-muxer";
import { AMBIENT_PERIOD, paintAmbient } from "./ambient";
import { songSingers } from "./loader";
import { FramePool } from "./framePool";
import { drawer, drawShade, lyricBand, stillYuv, type LyricStyle } from "./lyricDraw";
import { exportPrefs } from "./exportPrefs";
import { useStore } from "./store";
import { VideoFrames } from "./videoFrames";

export type Orientation = "landscape" | "portrait";
export type { LyricStyle } from "./lyricDraw";

/** Frames per second of the export being made (30, or 25 to export faster). */
let FPS = 30;

/** The frame rates offered: 30 is smoother, 25 makes a sixth fewer frames. */
export type FrameRate = 30 | 25;

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
  backdrop: Backdrop,
  onProgress: (f: number) => void,
  cancelled: () => boolean,
  fps: FrameRate = 30,
): Promise<string> {
  FPS = fps;
  const song = useStore.getState().song;
  if (!song?.info) throw new Error("Chưa mở bài hát nào");
  const lines = song.lyrics.lines ?? [];
  const tempo = song.info.tempo || 1;
  const offset = song.userOffset;
  // Over the recording's own video (fetched now if it isn't yet).
  const videoPath = backdrop === "video" ? await recordingVideo() : undefined;
  if (cancelled()) throw new Error("cancelled");
  const linux = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  // Full HD over the video, and always through ffmpeg (which compresses better).
  const [W, H] = (videoPath || linux ? HD_SIZES : SIZES)[orientation];
  const bitrate = videoPath ? 12_000_000 : 6_000_000;

  // WebKitGTK (Linux) kills its web process as soon as WebCodecs is touched,
  // even to ask what it supports: there ffmpeg encodes instead.
  if (linux) {
    if (!(await invoke<boolean>("video_ffmpeg_available")))
      throw new Error("Trên Linux cần cài ffmpeg (có libx264) để xuất video: sudo apt install ffmpeg");
    return exportWithFfmpeg(W, H, style, videoPath, backdrop, onProgress, cancelled);
  }

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
  const name = exportName();
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
    const bg = await stillBackground(backdrop, song.meta.artwork, W, H);
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
      songSingers(),
      singingAids(),
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
        if (backdrop === "plain") paintAmbient(bg.getContext("2d")!, W, H, i / FPS);
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

/** Key names for file names (ASCII: no ♯/♭). */
const FILE_NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/**
 * The exported video's file name: the song's name (as the user corrected it)
 * and the key it is sung in, e.g. "Bùi Công Nam - Anh Không Theo Đuổi Em Nữa
 * (Karaoke - Tone G, hạ 2 nửa cung)", or "… (Karaoke - Tone gốc A)"; a changed
 * tempo is added too.
 */
export function exportName(): string {
  const song = useStore.getState().song;
  if (!song) return "Karaoke";
  const semis = song.info?.semitones ?? 0;
  const key = song.info?.key;
  const keyText = (shift: number) =>
    key ? `${FILE_NOTES[(((key.tonic + shift) % 12) + 12) % 12]}${key.minor ? "m" : ""}` : "";
  const parts = [
    semis === 0
      ? `Tone gốc${key ? ` ${keyText(0)}` : ""}`
      : `Tone ${keyText(semis) || ""}${key ? ", " : ""}${semis < 0 ? "hạ" : "nâng"} ${Math.abs(semis)} nửa cung`.replace("Tone , ", "Tone "),
  ];
  const tempo = song.info?.tempo ?? 1;
  if (Math.abs(tempo - 1) > 0.001) parts.push(`${tempo > 1 ? "nhanh" : "chậm"} ${Math.round(tempo * 100)}%`);
  const who = song.meta.artist ? `${song.meta.artist} - ` : "";
  return `${who}${song.meta.title} (Karaoke - ${parts.join(", ")})`;
}

/** Where the export's picture comes from: the recording's video, the song's artwork, or the app's plain dark background. */
export type Backdrop = "video" | "artwork" | "plain" | "image";

/** This song's own background picture, if one was chosen. */
export function exportImage(): string | null {
  return exportPrefs(useStore.getState().song?.meta.id).image ?? null;
}

/** The background for `backdrop` other than the video: the user's picture, the blurred artwork, or the plain gradient. */
async function stillBackground(backdrop: Backdrop, artwork: string | null, W: number, H: number): Promise<OffscreenCanvas> {
  if (backdrop === "image") {
    const path = exportImage();
    if (!path) throw new Error("Chưa chọn hình nền: bấm \"Chọn hình\" ở mục Xuất video");
    return background(convertFileSrc(path), W, H, "picture");
  }
  return background(backdrop === "artwork" ? artwork : null, W, H);
}

/** The singing aids for the open song, as the drawer takes them (beats in lyric time). */
function singingAids() {
  const { song, aids } = useStore.getState();
  const offset = song?.userOffset ?? 0;
  return {
    notes: aids.pitch ? (song?.melody ?? null) : null,
    look: aids.look,
    offset,
    beats: aids.beat && song?.beats ? song.beats.times.map((b) => b - offset) : null,
  };
}

/** The recording's picture-only video, downloaded first if needed. */
async function recordingVideo(): Promise<string> {
  const song = useStore.getState().song;
  if (song?.video?.status === "ready" && song.video.path) return song.video.path;
  if (!song?.sourceId) throw new Error("Bài này không có video gốc để làm nền");
  try {
    return await invoke<string>("yt_download_video", { id: song.sourceId });
  } catch (e) {
    throw new Error(`Không tải được video gốc: ${typeof e === "string" ? e : String(e)}`);
  }
}

/**
 * The same karaoke video, encoded by ffmpeg (Linux). Only the lyrics are
 * drawn here, frame by frame on a transparent canvas and sent as PNG
 * (sharp edges, no JPEG blur); ffmpeg lays them over the background: the
 * recording's own video (seeked and run at the song's tempo, dimmed by a
 * still shade) or the artwork. The sound is mixed and written by the backend.
 */
async function exportWithFfmpeg(
  W: number,
  H: number,
  style: LyricStyle,
  videoPath: string | undefined,
  backdrop: Backdrop,
  onProgress: (f: number) => void,
  cancelled: () => boolean,
): Promise<string> {
  const song = useStore.getState().song;
  if (!song?.info) throw new Error("Chưa mở bài hát nào");
  const lines = song.lyrics.lines ?? [];
  const tempo = song.info.tempo || 1;
  const offset = song.userOffset;
  const trim = song.trim ?? { start: 0, end: 0 };
  const name = exportName();
  const part = await invoke<string>("video_begin", { name });
  const png = async (c: OffscreenCanvas) => new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  try {
    // The still layer: the whole picture, or the shade over the video.
    const bg = await stillBackground(backdrop, song.meta.artwork, W, H);
    let still = bg;
    const ambient = !videoPath && backdrop === "plain";
    if (videoPath) {
      still = new OffscreenCanvas(W, H);
      drawShade(still.getContext("2d")!, W, H);
    } else if (ambient) {
      // The moving background: one period, half size (it is all soft), looped by ffmpeg.
      still = new OffscreenCanvas(W, H);
      const lw = Math.round(W / 2);
      const lh = Math.round(H / 2);
      const loop = new OffscreenCanvas(lw, lh);
      const lctx = loop.getContext("2d")!;
      const n = AMBIENT_PERIOD * FPS;
      let batch: Uint8Array[] = [];
      let size = 0;
      const flush = async () => {
        const all = new Uint8Array(size);
        let at = 0;
        for (const b of batch) {
          all.set(b, at);
          at += b.length;
        }
        await invoke("video_ffmpeg_loop", all, { headers: { "x-path": encodeURIComponent(part) } });
        batch = [];
        size = 0;
      };
      for (let i = 0; i < n; i++) {
        if (cancelled()) throw new Error("cancelled");
        paintAmbient(lctx, lw, lh, i / FPS);
        const jpeg = new Uint8Array(await (await loop.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
        batch.push(jpeg);
        size += jpeg.length;
        if (size > 4 << 20) await flush();
        if (i % 30 === 0) onProgress(0.03 * (i / n));
      }
      if (size) await flush();
    }
    if (!videoPath && !ambient) {
      // A still picture: sent once in the video's own format; the lyrics are
      // laid on it in the backend and ffmpeg only encodes (much faster).
      await invoke("video_ffmpeg_backdrop", stillYuv(bg), {
        headers: { "x-path": encodeURIComponent(part), "x-format": "yuv420p" },
      });
      // Fastest: the backend draws the lyrics too, from recorded canvas calls.
      const fast = await exportFast(part, W, H, style, onProgress, cancelled);
      if (fast) return fast;
    } else {
      await invoke("video_ffmpeg_backdrop", await png(still), {
        headers: { "x-path": encodeURIComponent(part) },
      });
    }
    const sound = await invoke<{ sampleRate: number; first: number; frames: number; hardware: boolean }>("video_ffmpeg_begin", {
      path: part,
      width: W,
      height: H,
      fps: FPS,
      trimStart: trim.start / tempo,
      trimEnd: trim.end / tempo,
      video: videoPath ?? null,
      ambient,
      // The first frame's moment in the recording (its video's clock).
      videoFrom: trim.start,
      tempo,
    });
    const skip = sound.first / sound.sampleRate;
    const total = Math.ceil((sound.frames / sound.sampleRate) * FPS);
    onProgress(0.03);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const css = getComputedStyle(document.documentElement);
    const font = css.getPropertyValue("--font-display").trim() || "sans-serif";
    const accent = css.getPropertyValue("--accent").trim() || "#ff3d7f";
    const singers = songSingers();
    const aids = singingAids();
    const draw = drawer(ctx, W, H, bg, font, accent, lines, song.meta.title, song.meta.artist, style, singers, aids);
    const timeOf = (i: number) => (skip + i / FPS) * tempo - offset;
    // Frames drawn by several workers at once (the same drawing code and
    // fonts, checked), sent to ffmpeg in order; on the page if they can't.
    const probe = { font: `700 64px ${font}`, text: "Đây sẽ là lý do em ’ // ‿ Hey" };
    ctx.font = probe.font;
    const pool = await FramePool.start(
      // With x264 on the CPU too, fewer workers: they would only take turns.
      Math.min(sound.hardware ? 8 : 5, Math.max(0, (navigator.hardwareConcurrency || 4) - (sound.hardware ? 2 : 6))),
      { W, H, font, accent, lines, title: song.meta.title, artist: song.meta.artist, style, singers, aids },
      { ...probe, width: ctx.measureText(probe.text).width },
      timeOf,
      total,
    );
    const started = performance.now();
    try {
      for (let i = 0; i < total; i++) {
        if (cancelled()) throw new Error("cancelled");
        let band = pool ? await pool.get(i) : null;
        if (!band) {
          draw(timeOf(i), "clear");
          band = lyricBand(ctx, W, H);
        }
        // Awaited: ffmpeg's pace sets ours, so frames never pile up in memory.
        await invoke("video_ffmpeg_frame", new Uint8Array(band.data), {
          headers: { "x-y": String(band.y), "x-rows": String(band.rows), "x-w": String(W), "x-h": String(H) },
        });
        if (i % 15 === 0) onProgress(0.03 + 0.95 * (i / total));
      }
    } finally {
      pool?.close();
    }
    void invoke("dev_log", {
      text: `export: ${total} frames in ${((performance.now() - started) / 1000).toFixed(1)} s, ${pool ? "workers" : "page"}, ${sound.hardware ? "GPU" : "x264"}`,
    }).catch(() => undefined);
    onProgress(0.99);
    return await invoke<string>("video_ffmpeg_finish", { path: part });
  } catch (e) {
    void invoke("video_ffmpeg_abort", { path: part });
    throw e;
  }
}

/**
 * The lyric video over a still picture, drawn and encoded by the backend
 * (`fastvideo`): workers run the same drawer on a recorder (canvas calls,
 * no pixels), which the backend replays on every core while x264 encodes
 * only the rows the lyrics move in. Null when it can't (no workers, or a
 * font the backend doesn't have): the caller exports the usual way.
 */
async function exportFast(
  part: string,
  W: number,
  H: number,
  style: LyricStyle,
  onProgress: (f: number) => void,
  cancelled: () => boolean,
): Promise<string | null> {
  const song = useStore.getState().song;
  if (!song?.info) return null;
  const css = getComputedStyle(document.documentElement);
  const font = css.getPropertyValue("--font-display").trim() || "sans-serif";
  if (!font.includes(FAST_FAMILY)) return null;
  const accent = css.getPropertyValue("--accent").trim() || "#ff3d7f";
  const lines = song.lyrics.lines ?? [];
  const tempo = song.info.tempo || 1;
  const offset = song.userOffset;
  const trim = song.trim ?? { start: 0, end: 0 };
  const started = performance.now();
  // The workers start (loading fonts) while the backend prepares the sound.
  const probe = { font: `700 64px ${font}`, text: "Đây sẽ là lý do em ’ // ‿ Hey" };
  const measure = new OffscreenCanvas(1, 1).getContext("2d")!;
  measure.font = probe.font;
  const [sound, pool] = await Promise.all([
    invoke<{ sampleRate: number; first: number; frames: number }>("video_fast_begin", {
      path: part,
      width: W,
      height: H,
      fps: FPS,
      trimStart: trim.start / tempo,
      trimEnd: trim.end / tempo,
    }),
    FramePool.start(
      Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)),
      { W, H, font, accent, lines, title: song.meta.title, artist: song.meta.artist, style, singers: songSingers(), aids: singingAids() },
      { ...probe, width: measure.measureText(probe.text).width },
      () => 0,
      0,
    ),
  ]);
  const ready = performance.now();
  if (!pool) {
    await invoke("video_fast_abort", { path: part }).catch(() => undefined);
    return null;
  }
  const skip = sound.first / sound.sampleRate;
  const total = Math.ceil((sound.frames / sound.sampleRate) * FPS);
  pool.retime((i) => (skip + i / FPS) * tempo - offset, total);
  const unlisten = await listen<number>("export://fast", (e) => onProgress(0.2 + 0.79 * e.payload));
  try {
    let recorded = 0;
    await pool.record(async (data, frames) => {
      if (cancelled()) throw new Error("cancelled");
      await invoke("video_fast_chunk", new Uint8Array(data), { headers: { "x-path": encodeURIComponent(part) } });
      recorded += frames;
      onProgress(0.03 + 0.17 * (recorded / total));
    });
    const drawn = performance.now();
    if (cancelled()) throw new Error("cancelled");
    const watch = setInterval(() => {
      if (cancelled()) void invoke("video_fast_abort", { path: part });
    }, 200);
    try {
      const out = await invoke<string>("video_fast_finish", { path: part, frames: total });
      void invoke("dev_log", {
        text: `export: ${total} frames in ${((performance.now() - started) / 1000).toFixed(1)} s, fast (workers ready ${((ready - started) / 1000).toFixed(1)} s, recorded ${((drawn - ready) / 1000).toFixed(1)} s, drawn and encoded ${((performance.now() - drawn) / 1000).toFixed(1)} s)`,
      }).catch(() => undefined);
      return out;
    } finally {
      clearInterval(watch);
    }
  } catch (e) {
    await invoke("video_fast_abort", { path: part }).catch(() => undefined);
    throw e;
  } finally {
    unlisten();
    pool.close();
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
  /** "picture": the user's own image, shown as it is (only darkened under the lyrics). */
  look: "blurred" | "picture" = "blurred",
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
    if (look === "picture") {
      // Fills the frame (cropped to fit), sharp; a soft shade where the lyrics go.
      const s = Math.max(W / img.width, H / img.height);
      g.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
      const shade = g.createLinearGradient(0, 0, 0, H);
      shade.addColorStop(0, "rgba(8, 6, 12, 0.15)");
      shade.addColorStop(0.45, "rgba(8, 6, 12, 0.3)");
      shade.addColorStop(1, "rgba(8, 6, 12, 0.6)");
      g.fillStyle = shade;
      g.fillRect(0, 0, W, H);
      return c;
    }
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
  } catch (e) {
    if (look === "picture") throw new Error(`Không mở được hình nền: ${e instanceof Error ? e.message : String(e)}`);
    // Artwork unavailable (offline or blocked): keep the gradient.
  }
  return c;
}

