//! Fast export of a lyric video over a still picture (the song's artwork or
//! the user's own picture).
//!
//! The page records each frame's canvas calls (`canvasRecorder.ts`, no
//! pixels), which are replayed here on every core (`canvas`). The video is
//! cut into segments encoded at the same time, and each encodes only the
//! stripe of rows its lyrics move in: the rest of every picture is the still
//! picture, written as skipped macroblocks (`h264`). On a 12-thread desktop a
//! five-minute song takes seconds instead of minutes.

pub mod canvas;
pub mod h264;
pub mod text;

use canvas::{Chunk, Renderer};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use text::Fonts;

/// What to encode: the still picture (yuv420p, `width`×`height`) and the
/// recorded frames.
pub struct Job {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub still: Vec<u8>,
    pub chunks: Vec<Chunk>,
    pub frames: usize,
}

/// x264's quality (constant rate factor) for the stripes.
const CRF: &str = "17";
/// A keyframe at least this often (seconds), so players can seek.
const KEYFRAME_SECS: u32 = 4;

fn up16(v: u32) -> u32 {
    v.div_ceil(16) * 16
}

/// The still picture padded to whole macroblocks (edges repeated).
fn padded(still: &[u8], w: usize, h: usize, pw: usize, ph: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(pw * ph * 3 / 2);
    let plane = |src: &[u8], w: usize, h: usize, pw: usize, ph: usize, out: &mut Vec<u8>| {
        for y in 0..ph {
            let row = &src[y.min(h - 1) * w..y.min(h - 1) * w + w];
            out.extend_from_slice(row);
            out.extend(std::iter::repeat_n(row[w - 1], pw - w));
        }
    };
    let (cw, ch) = (w / 2, h / 2);
    plane(&still[..w * h], w, h, pw, ph, &mut out);
    plane(&still[w * h..w * h + cw * ch], cw, ch, pw / 2, ph / 2, &mut out);
    plane(&still[w * h + cw * ch..], cw, ch, pw / 2, ph / 2, &mut out);
    out
}

/// Rows `r0..r1` (even) of a padded yuv420p picture as a picture of their own.
fn rows_of(pic: &[u8], pw: usize, ph: usize, r0: usize, r1: usize) -> Vec<u8> {
    let (cw, ch) = (pw / 2, ph / 2);
    let mut out = Vec::with_capacity(pw * (r1 - r0) * 3 / 2);
    out.extend_from_slice(&pic[r0 * pw..r1 * pw]);
    let u = &pic[pw * ph..pw * ph + cw * ch];
    let v = &pic[pw * ph + cw * ch..];
    out.extend_from_slice(&u[r0 / 2 * cw..r1 / 2 * cw]);
    out.extend_from_slice(&v[r0 / 2 * cw..r1 / 2 * cw]);
    out
}

/// Lay the renderer's premultiplied RGBA (rows `dirty`) on `base` (a yuv420p
/// stripe of the same size, the still picture there), into `out`. BT.601
/// limited range, in fixed point: premultiplied colour converts linearly, so
/// out = 16·α + M·rgb + (1 − α)·base, chroma from the 2×2 block's sums.
fn composite(base: &[u8], rgba: &[u8], w: usize, h: usize, rect: [i32; 4], out: &mut [u8]) {
    let [x0, a, x1, b] = rect.map(|v| v.max(0) as usize);
    let (cw, ch) = (w / 2, h / 2);
    // The picture back under the rectangle, then the lyrics on it.
    for y in a..b {
        out[y * w + x0..y * w + x1].copy_from_slice(&base[y * w + x0..y * w + x1]);
    }
    for plane in [w * h, w * h + cw * ch] {
        for cy in a / 2..b / 2 {
            let i = plane + cy * cw;
            out[i + x0 / 2..i + x1 / 2].copy_from_slice(&base[i + x0 / 2..i + x1 / 2]);
        }
    }
    let (yp, rest) = out.split_at_mut(w * h);
    let (up, vp) = rest.split_at_mut(cw * ch);
    // Coefficients ×2¹⁶ (rgb and α are 0–255).
    const YR: i32 = 16829; // 0.2568
    const YG: i32 = 33039; // 0.5041
    const YB: i32 = 6416; // 0.0979
    const UR: i32 = -9713; // -0.1482
    const UG: i32 = -19071; // -0.2910
    const UB: i32 = 28784; // 0.4392
    const VG: i32 = -24103; // -0.3678
    const VB: i32 = -4679; // -0.0714
    for cy in a / 2..b / 2 {
        let r0 = &rgba[cy * 2 * w * 4..(cy * 2 + 1) * w * 4];
        let r1 = &rgba[(cy * 2 + 1) * w * 4..(cy * 2 + 2) * w * 4];
        for cx in x0 / 2..x1 / 2 {
            let i0 = cx * 8;
            // Both pixels of both rows transparent: the picture stays.
            if r0[i0 + 3] | r0[i0 + 7] | r1[i0 + 3] | r1[i0 + 7] == 0 {
                continue;
            }
            let (mut su, mut sv, mut sa) = (0i32, 0i32, 0i32);
            for (dy, row) in [r0, r1].into_iter().enumerate() {
                for dx in 0..2 {
                    let p = &row[i0 + dx * 4..i0 + dx * 4 + 4];
                    let al = p[3] as i32;
                    if al == 0 {
                        continue;
                    }
                    let (r, g, bl) = (p[0] as i32, p[1] as i32, p[2] as i32);
                    let yi = (cy * 2 + dy) * w + cx * 2 + dx;
                    let bg = yp[yi] as i32;
                    let v = 16 * 257 * al + YR * r + YG * g + YB * bl + bg * (65536 - 257 * al);
                    yp[yi] = ((v + 32768) >> 16).clamp(0, 255) as u8;
                    su += 128 * 257 * al + UR * r + UG * g + UB * bl;
                    sv += 128 * 257 * al + UB * r + VG * g + VB * bl;
                    sa += al;
                }
            }
            let k = 65536 - 257 * sa / 4;
            let i = cy * cw + cx;
            up[i] = ((su / 4 + up[i] as i32 * k + 32768) >> 16).clamp(0, 255) as u8;
            vp[i] = ((sv / 4 + vp[i] as i32 * k + 32768) >> 16).clamp(0, 255) as u8;
        }
    }
}

/// x264 on raw yuv420p `w`×`h` from stdin, an Annex B stream on stdout.
fn x264(w: usize, h: usize, fps: u32, threads: usize, keyint: u32) -> std::io::Result<std::process::Child> {
    Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s"])
        .arg(format!("{w}x{h}"))
        .args(["-r", &fps.to_string(), "-i", "-", "-c:v", "libx264", "-preset", "ultrafast", "-crf", CRF, "-threads", &threads.to_string()])
        .args(["-x264-params", &format!("{}:keyint={keyint}:min-keyint={keyint}", h264::X264_PARAMS)])
        .args(["-bsf:v", "dump_extra,filter_units=remove_types=6", "-f", "h264", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

/// Encode `frames` raw pictures (from `next`) with x264, collecting the stream.
fn encode_with(w: usize, h: usize, fps: u32, threads: usize, keyint: u32, mut next: impl FnMut(&mut dyn Write) -> Result<bool, String>) -> Result<Vec<u8>, String> {
    let mut child = x264(w, h, fps, threads, keyint).map_err(|e| format!("Không chạy được ffmpeg: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg không có đầu ra")?;
    let reader = std::thread::spawn(move || {
        let mut v = Vec::new();
        stdout.read_to_end(&mut v).map(|_| v)
    });
    {
        let stdin = child.stdin.take().ok_or("ffmpeg không có đầu vào")?;
        let mut sink = std::io::BufWriter::with_capacity(1 << 22, stdin);
        while next(&mut sink)? {}
        sink.flush().map_err(|e| format!("ffmpeg dừng giữa chừng: {e}"))?;
    }
    let out = reader.join().map_err(|_| "ffmpeg lỗi")?.map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("x264 không mã hóa được".into());
    }
    Ok(out)
}

struct Segment {
    frames: std::ops::Range<usize>,
    /// Macroblock rows of its band.
    rows: (u32, u32),
}

/// The whole video as an H.264 Annex B stream. `progress` gets the share done.
pub fn encode(job: &Job, progress: &(dyn Fn(f32) + Sync), cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    let (w, h) = (job.width as usize, job.height as usize);
    let (pw, ph) = (up16(job.width) as usize, up16(job.height) as usize);
    if job.still.len() != w * h * 3 / 2 {
        return Err("Ảnh nền không khớp khung hình".into());
    }
    let still = padded(&job.still, w, h, pw, ph);
    // Every frame's commands, by frame index.
    let mut index: Vec<Option<(usize, std::ops::Range<usize>)>> = vec![None; job.frames];
    for (ci, c) in job.chunks.iter().enumerate() {
        for (i, r) in &c.frames {
            if let Some(slot) = index.get_mut(*i as usize) {
                *slot = Some((ci, r.clone()));
            }
        }
    }
    if index.iter().any(|f| f.is_none()) {
        return Err("Thiếu khung hình đã ghi".into());
    }
    let fonts = Arc::new(Fonts::new());
    let clock = std::time::Instant::now();
    // Segments, more than cores so that a slow one (a tall band) doesn't hold
    // the rest up. Each measures the rows its frames draw on (without
    // drawing), takes that band, then draws and encodes it.
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let count = (2 * cores).clamp(2, 24).min(job.frames.max(1));
    let per = job.frames.div_ceil(count);
    let height_mbs = (ph / 16) as u32;
    let segments: Vec<std::ops::Range<usize>> = (0..count).map(|s| s * per..((s + 1) * per).min(job.frames)).filter(|r| !r.is_empty()).collect();
    let threads = (cores / segments.len()).max(1);
    let render_ns = AtomicUsize::new(0);
    let keyint = KEYFRAME_SECS * job.fps;
    let done = AtomicUsize::new(0);
    let total = job.frames as f32;
    let band_of = |renderer: &mut Renderer, frames: &std::ops::Range<usize>| -> Result<(u32, u32), String> {
        let (mut top, mut bottom) = (f32::MAX, f32::MIN);
        for i in frames.clone() {
            let (ci, range) = index[i].as_ref().unwrap();
            if let Some(b) = renderer.run(&job.chunks[*ci], range.clone(), true)? {
                top = top.min(b.0);
                bottom = bottom.max(b.1);
            }
        }
        if top > bottom {
            (top, bottom) = (0.0, 16.0);
        }
        let g = h264::GUARD as f32;
        let r0 = (((top - g).max(0.0) as u32) / 16).min(height_mbs - 1);
        let r1 = (((bottom + g).ceil() as u32).div_ceil(16)).clamp(r0 + 1, height_mbs);
        Ok((r0, r1))
    };
    type Encoded = Result<((u32, u32), Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>), String>;
    let encoded: Vec<Encoded> = std::thread::scope(|scope| {
        let handles: Vec<_> = segments
            .iter()
            .map(|frames| {
                let (still, index, fonts, done, render_ns, band_of) = (&still, &index, fonts.clone(), &done, &render_ns, &band_of);
                scope.spawn(move || -> Encoded {
                    let mut renderer = Renderer::new(fonts, pw, ph, 0);
                    let rows = band_of(&mut renderer, frames)?;
                    let seg = Segment { frames: frames.clone(), rows };
                    let (r0, r1) = ((seg.rows.0 * 16) as usize, (seg.rows.1 * 16) as usize);
                    let bh = r1 - r0;
                    let base = rows_of(still, pw, ph, r0, r1);
                    renderer.set_band(bh, r0 as i32);
                    // The frame sent to x264, kept from one frame to the next.
                    let mut frame = base.clone();
                    let mut i = seg.frames.start;
                    let band = encode_with(pw, bh, job.fps, threads, keyint, |out| {
                        if i >= seg.frames.end || cancel.load(Ordering::Relaxed) {
                            return Ok(false);
                        }
                        let (ci, range) = index[i].as_ref().unwrap();
                        let t = std::time::Instant::now();
                        renderer.run(&job.chunks[*ci], range.clone(), false)?;
                        let tc = std::time::Instant::now();
                        if let Some(rect) = renderer.changed {
                            composite(&base, &renderer.frame, pw, bh, rect, &mut frame);
                        }
                        canvas::PROF[3].fetch_add(tc.elapsed().as_nanos() as u64, Ordering::Relaxed);
                        render_ns.fetch_add(t.elapsed().as_nanos() as usize, Ordering::Relaxed);
                        out.write_all(&frame).map_err(|e| format!("ffmpeg dừng giữa chừng: {e}"))?;
                        i += 1;
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        if n % 64 == 0 {
                            progress(0.05 + 0.9 * n as f32 / total);
                        }
                        Ok(true)
                    })?;
                    // The still picture above and below the band, one intra frame each.
                    let still_part = |a: usize, b: usize| -> Result<Option<Vec<u8>>, String> {
                        if b <= a {
                            return Ok(None);
                        }
                        let pic = rows_of(still, pw, ph, a, b);
                        let mut sent = false;
                        encode_with(pw, b - a, job.fps, 1, keyint, |out| {
                            if sent {
                                return Ok(false);
                            }
                            sent = true;
                            out.write_all(&pic).map_err(|e| e.to_string())?;
                            Ok(true)
                        })
                        .map(Some)
                    };
                    Ok((seg.rows, band, still_part(0, r0)?, still_part(r1, ph)?))
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("Luồng mã hóa bị lỗi".into()))).collect()
    });
    if std::env::var_os("FAST_DEBUG").is_some() {
        eprintln!("bands {:?}", encoded.iter().flatten().map(|e| (e.0 .0 * 16, e.0 .1 * 16)).collect::<Vec<_>>());
        let p = |k: usize| canvas::PROF[k].load(Ordering::Relaxed) as f32 / 1e9;
        eprintln!(
            "encoded at {:.2}s; drawing took {:.2} core-seconds (coverage {:.1}, blur {:.1}, blend {:.1}, composite {:.1})",
            clock.elapsed().as_secs_f32(),
            render_ns.load(Ordering::Relaxed) as f32 / 1e9,
            p(0),
            p(1),
            p(2),
            p(3)
        );
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    let mut out = Vec::new();
    let mut pars: Option<h264::Params> = None;
    for (frames, e) in segments.iter().zip(encoded) {
        let (rows, band, top, bottom) = e?;
        let seg = Segment { frames: frames.clone(), rows };
        let p = h264::params(&band)?;
        match &pars {
            None => {
                p.headers(height_mbs, job.width, job.height, &mut out);
                pars = Some(p.clone());
            }
            Some(first) if !first.compatible(&p) => return Err("H.264: các đoạn mã hóa không cùng thiết lập".into()),
            _ => {}
        }
        let n = h264::stitch(&p, &h264::Stripes { band: &band, top: top.as_deref(), bottom: bottom.as_deref(), rows: seg.rows }, height_mbs, &mut out)?;
        if n != seg.frames.len() {
            return Err(format!("x264 trả về {n} khung thay vì {}", seg.frames.len()));
        }
    }
    progress(0.97);
    Ok(out)
}

/// Mux `video` (an Annex B file at `fps`) with the AAC audio `audio` into
/// the MP4 `out`. (From a pipe ffmpeg takes ten times as long: it probes
/// unseekable input slowly.)
pub fn mux(video: &std::path::Path, audio: &std::path::Path, fps: u32, out: &std::path::Path) -> Result<(), String> {
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-framerate", &fps.to_string(), "-f", "h264", "-i"])
        .arg(video)
        .arg("-i")
        .arg(audio)
        .args(["-map", "0:v", "-map", "1:a", "-c", "copy", "-shortest", "-movflags", "+faststart", "-f", "mp4"])
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("Không chạy được ffmpeg: {e}"))?;
    if !status.success() {
        return Err("ffmpeg không ghép được hình và tiếng".into());
    }
    Ok(())
}

/// The audio as AAC (run alongside the video).
pub fn encode_audio(wav: &std::path::Path, out: &std::path::Path) -> std::io::Result<std::process::Child> {
    Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(wav)
        .args(["-c:a", "aac", "-b:a", "256k", "-f", "mp4"])
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::canvas::op;
    use super::*;

    /// A recorded chunk: strings, then commands built by `f`.
    fn chunk(strings: &[&str], f: impl FnOnce(&mut Vec<u8>)) -> Chunk {
        let mut b = Vec::new();
        b.extend_from_slice(&(strings.len() as u32).to_le_bytes());
        for s in strings {
            b.extend_from_slice(&(s.len() as u32).to_le_bytes());
            b.extend_from_slice(s.as_bytes());
        }
        f(&mut b);
        Chunk::parse(b).unwrap()
    }
    fn put(b: &mut Vec<u8>, code: u8, args: &[f32]) {
        b.push(code);
        for a in args {
            b.extend_from_slice(&a.to_le_bytes());
        }
    }

    /// Frames with a wiping line of text and a moving glowing dot over a
    /// still picture: the stitched stream decodes to the right size and
    /// frame count, and the lyrics show where they were drawn.
    #[test]
    #[ignore = "runs ffmpeg"]
    fn stitched_export_decodes() {
        let (w, h, n) = (1280u32, 720u32, 90usize);
        let mut still = vec![0u8; (w * h * 3 / 2) as usize];
        for y in 0..h as usize {
            for x in 0..w as usize {
                still[y * w as usize + x] = still_y(x, y);
            }
        }
        still[(w * h) as usize..].fill(128);
        let c = chunk(&["Đây sẽ là lý do em"], |b| {
            for i in 0..n {
                b.push(op::FRAME);
                b.extend_from_slice(&(i as u32).to_le_bytes());
                put(b, op::FONT, &[700.0, 64.0]);
                put(b, op::TEXT_ALIGN, &[]);
                b.push(1);
                put(b, op::FILL_LINEAR, &[340.0, 0.0, 940.0, 0.0]);
                b.extend_from_slice(&3u32.to_le_bytes());
                let p = i as f32 / n as f32;
                for (o, c) in [(0.0, [1.0, 1.0, 1.0, 1.0]), (p, [1.0, 0.8, 0.9, 1.0]), ((p + 0.05).min(1.0), [1.0, 1.0, 1.0, 0.4])] {
                    for v in [o, c[0], c[1], c[2], c[3]] {
                        b.extend_from_slice(&f32::to_le_bytes(v));
                    }
                }
                put(b, op::SHADOW_COLOR, &[1.0, 0.24, 0.5, 0.5]);
                put(b, op::SHADOW_BLUR, &[12.0]);
                b.push(op::FILL_TEXT);
                b.extend_from_slice(&0u32.to_le_bytes());
                for v in [640.0f32, 500.0] {
                    b.extend_from_slice(&v.to_le_bytes());
                }
                put(b, op::BEGIN_PATH, &[]);
                put(b, op::ARC, &[200.0 + 10.0 * i as f32, 440.0, 12.0, 0.0, 6.3, 0.0]);
                put(b, op::FILL_COLOR, &[1.0, 0.3, 0.5, 1.0]);
                put(b, op::FILL, &[]);
            }
        });
        let job = Job { width: w, height: h, fps: 30, still, chunks: vec![c], frames: n };
        let t0 = std::time::Instant::now();
        let stream = encode(&job, &|_| {}, &AtomicBool::new(false)).unwrap();
        eprintln!("{n} frames in {:.2}s, {} bytes", t0.elapsed().as_secs_f32(), stream.len());
        let dir = std::env::temp_dir();
        let path = dir.join("okb-fast-test.h264");
        std::fs::write(&path, &stream).unwrap();
        let out = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(&path)
            .args(["-f", "rawvideo", "-pix_fmt", "yuv420p", "-"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let fs = (w * h * 3 / 2) as usize;
        assert_eq!(out.stdout.len(), fs * n, "frames");
        // The last frame's luma: white text around (640, 480), the still picture far from it.
        let last = &out.stdout[fs * (n - 1)..];
        let bright = (470..500).flat_map(|y| (500..780).map(move |x| (x, y))).filter(|&(x, y)| last[y * w as usize + x] > 200).count();
        assert!(bright > 300, "text missing: {bright} bright pixels");
        let far = (10..60).map(|y| (last[y * w as usize + 100] as i32 - still_y(100, y) as i32).abs()).max().unwrap();
        assert!(far < 6, "still picture changed by {far}");
    }

    /// A smooth picture (x264 keeps it within a few levels).
    fn still_y(x: usize, y: usize) -> u8 {
        (40 + x * 100 / 1280 + y * 60 / 720) as u8
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// A real song recorded by the page's drawer (run by hand):
    /// `FAST_REC=dir FAST_BG=still.yuv cargo test --release --lib fast_export_bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn fast_export_bench() {
        let dir = std::env::var("FAST_REC").expect("FAST_REC");
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "bin")).collect();
        files.sort();
        let t0 = std::time::Instant::now();
        let chunks: Vec<Chunk> = files.iter().map(|f| Chunk::parse(std::fs::read(f).unwrap()).unwrap()).collect();
        let frames = chunks.iter().map(|c| c.frames.len()).sum();
        let still = std::fs::read(std::env::var("FAST_BG").expect("FAST_BG")).unwrap();
        let job = Job { width: 1920, height: 1080, fps: 30, still, chunks, frames };
        eprintln!("parsed {frames} frames in {:.2}s", t0.elapsed().as_secs_f32());
        let t1 = std::time::Instant::now();
        let stream = encode(&job, &|_| {}, &AtomicBool::new(false)).unwrap();
        eprintln!("drawn and encoded in {:.2}s, {:.1} MB", t1.elapsed().as_secs_f32(), stream.len() as f32 / 1e6);
        std::fs::write(format!("{dir}/out.h264"), &stream).unwrap();
    }
}

#[cfg(test)]
mod end_to_end {
    use super::*;

    /// The whole of `video_fast_begin` → chunks → `video_fast_finish` minus
    /// the page: audio encoded alongside, frames drawn and encoded, stitched,
    /// written, muxed. `FAST_REC`, `FAST_BG` as for the bench, `FAST_WAV`
    /// the song's sound, `FAST_OUT` the MP4.
    #[test]
    #[ignore]
    fn fast_export_end_to_end() {
        let t0 = std::time::Instant::now();
        let dir = std::env::var("FAST_REC").expect("FAST_REC");
        let out = std::path::PathBuf::from(std::env::var("FAST_OUT").expect("FAST_OUT"));
        let m4a = out.with_extension("m4a");
        let mut audio = encode_audio(std::path::Path::new(&std::env::var("FAST_WAV").expect("FAST_WAV")), &m4a).unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "bin")).collect();
        files.sort();
        let chunks: Vec<Chunk> = files.iter().map(|f| Chunk::parse(std::fs::read(f).unwrap()).unwrap()).collect();
        let frames = chunks.iter().map(|c| c.frames.len()).sum();
        let still = std::fs::read(std::env::var("FAST_BG").expect("FAST_BG")).unwrap();
        let job = Job { width: 1920, height: 1080, fps: 30, still, chunks, frames };
        let stream = encode(&job, &|_| {}, &AtomicBool::new(false)).unwrap();
        let h264 = out.with_extension("h264");
        std::fs::write(&h264, &stream).unwrap();
        assert!(audio.wait().unwrap().success());
        mux(&h264, &m4a, 30, &out).unwrap();
        eprintln!("END TO END: {frames} frames, {:.2} s", t0.elapsed().as_secs_f32());
    }
}
