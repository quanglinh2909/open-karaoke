import { createFile, DataStream, Endianness, MP4BoxBuffer, type Movie, type Sample, type VisualSampleEntry } from "mp4box";

/** Yield to the event loop at once, so decoder output callbacks can run. */
const tick = () =>
  new Promise<void>((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => resolve();
    c.port2.postMessage(0);
  });

/**
 * A local MP4's picture, decoded frame by frame in order with WebCodecs
 * (mp4box demuxes it): the original video under the lyrics of an exported
 * karaoke video. Ask for increasing times; frames already passed are freed.
 */
export class VideoFrames {
  private frames: VideoFrame[] = [];
  private next = 0;
  private flushed = false;
  private failure: unknown = null;

  private constructor(
    private decoder: VideoDecoder,
    private samples: Sample[],
    private timescale: number,
  ) {}

  /** Open the MP4 at `url` (an asset URL of a local file). */
  static async open(url: string): Promise<VideoFrames> {
    const buffer = await (await fetch(url)).arrayBuffer();
    // Keep the media data: by default mp4box drops it once parsed, and the
    // samples are asked for as soon as the header is read.
    const file = createFile(true);
    let movie: Movie | null = null;
    const samples: Sample[] = [];
    file.onReady = (info) => {
      movie = info;
      const t = info.videoTracks[0];
      if (t) {
        file.setExtractionOptions(t.id, undefined, { nbSamples: t.nb_samples });
        file.start();
      }
    };
    file.onSamples = (_id, _user, s) => samples.push(...s);
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
    file.flush();
    const track = (movie as Movie | null)?.videoTracks[0];
    if (!track?.video || !samples.length) throw new Error("Không đọc được hình trong file video");

    // The codec's setup data (avcC and the like), without its box header.
    let description: Uint8Array | undefined;
    for (const entry of file.getTrackById(track.id).mdia.minf.stbl.stsd.entries) {
      const e = entry as VisualSampleEntry;
      const box = e.avcC ?? e.hvcC ?? e.vpcC ?? e.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        box.write(stream as any);
        description = new Uint8Array(stream.buffer, 8);
        break;
      }
    }
    // Frames out as soon as decoded, not held back for smoothness.
    const config: VideoDecoderConfig = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description, optimizeForLatency: true };
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`Máy này không giải mã được video ${track.codec}`);

    const holder: { self?: VideoFrames } = {};
    const decoder = new VideoDecoder({
      output: (f) => holder.self!.frames.push(f),
      error: (e) => (holder.self!.failure = e),
    });
    decoder.configure(config);
    holder.self = new VideoFrames(decoder, samples, track.timescale);
    return holder.self;
  }

  /** Start decoding at the keyframe before `t` seconds (skips what isn't needed). */
  seek(t: number) {
    let k = 0;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].cts / this.timescale > t) break;
      if (this.samples[i].is_sync) k = i;
    }
    this.next = k;
  }

  /** The frame showing at `t` seconds, or the first one before the video starts. */
  async at(t: number): Promise<VideoFrame | null> {
    const us = t * 1e6;
    // Decode until a frame past `t` is out, or the stream ends.
    while (!this.frames.length || this.frames[this.frames.length - 1].timestamp <= us) {
      if (this.failure) throw this.failure;
      if (this.next < this.samples.length) {
        const s = this.samples[this.next++];
        this.decoder.decode(
          new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: (s.cts * 1e6) / this.timescale,
            duration: (s.duration * 1e6) / this.timescale,
            data: s.data!,
          }),
        );
        // Let the decoder catch up instead of piling chunks onto it.
        if (this.decoder.decodeQueueSize > 4) await new Promise((r) => this.decoder.addEventListener("dequeue", r, { once: true }));
        else await tick();
      } else if (!this.flushed) {
        this.flushed = true;
        await this.decoder.flush();
      } else {
        break;
      }
    }
    // Keep the latest frame at or before `t`; free the ones passed.
    while (this.frames.length > 1 && this.frames[1].timestamp <= us) this.frames.shift()!.close();
    return this.frames[0] ?? null;
  }

  close() {
    for (const f of this.frames) f.close();
    this.frames = [];
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}
