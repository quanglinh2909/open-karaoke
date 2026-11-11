//! Keep only the sung (pitched) voice from a stretch of the separated vocal.
//!
//! Where a duet overlaps (one singer still holding a note while the other
//! starts rapping) the separated vocal holds both. The held note is pitched;
//! rap is mostly unpitched, or pitched elsewhere. So over a short stretch the
//! harmonics of the sung pitch (from the melody notes, refined by pitch
//! detection) are kept and everything between them dropped: a comb-shaped
//! spectral mask, short-time Fourier transform in and out.

use super::melody::{note_at, Note};
use super::pitch::PitchDetector;
use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;

const N: usize = 2048;
const HOP: usize = 512;
/// Harmonics above this are left out (little of the voice, much of the rap's hiss).
const TOP_HZ: f32 = 8000.0;
/// A detected pitch counts only this close (semitones) to the melody note.
const NEAR: f32 = 1.5;

/// Gain of FFT bin `bin` for a voice at `f0`: near 1 on its harmonics, 0 between.
fn comb(bin: usize, f0: f32, bin_hz: f32) -> f32 {
    let f = bin as f32 * bin_hz;
    if f < f0 * 0.7 || f > TOP_HZ {
        return 0.0;
    }
    let k = (f / f0).round().max(1.0);
    let width = (0.025 * k * f0).max(1.5 * bin_hz);
    let d = (f - k * f0) / width;
    (-d * d).exp()
}

/// The stereo vocal `vocal` (interleaved, `sr` Hz) from `from` to `to`
/// seconds with only the sung voice kept: interleaved stereo of exactly that
/// stretch. Silent where no note is sung.
pub fn sung_only(vocal: &[f32], sr: u32, from: f64, to: f64, notes: &[Note]) -> Vec<f32> {
    let fs = sr as f64;
    let frames = vocal.len() / 2;
    let (a, b) = (((from * fs).max(0.0) as usize).min(frames), ((to * fs).max(0.0) as usize).min(frames));
    if b <= a {
        return Vec::new();
    }
    // Work on a window padded by a frame each side, so the edges are whole.
    let (pa, pb) = (a.saturating_sub(N), (b + N).min(frames));
    let len = pb - pa;
    let chan = |c: usize| -> Vec<f32> { (pa..pb).map(|f| vocal[2 * f + c]).collect() };
    let (left, right) = (chan(0), chan(1));

    // Pitch along the window: the detector's reading when it agrees with the
    // melody note there, the note's own pitch otherwise; 0 where none is sung.
    let mut det = PitchDetector::new(sr as f32);
    let mut reading = vec![0.0f32; len];
    let mut last = 0.0f32;
    for i in 0..len {
        if let Some(e) = det.push(0.5 * (left[i] + right[i])) {
            last = if e.clarity >= 0.5 { e.freq } else { 0.0 };
        }
        reading[i] = last;
    }
    let f0_at = |i: usize| -> f32 {
        let t = (pa + i) as f32 / sr as f32;
        let Some(n) = note_at(notes, t, 0.03) else { return 0.0 };
        let note_hz = 440.0 * 2f32.powf((n.midi - 69.0) / 12.0);
        let r = reading[i.min(len - 1)];
        if r > 0.0 && (12.0 * (r / note_hz).log2()).abs() < NEAR {
            r
        } else {
            note_hz
        }
    };

    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(N);
    let inv = planner.plan_fft_inverse(N);
    let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / N as f32).cos()).collect();
    let bin_hz = sr as f32 / N as f32;
    let mut out_l = vec![0.0f32; len + N];
    let mut out_r = vec![0.0f32; len + N];
    let mut norm = vec![0.0f32; len + N];
    let mut buf = vec![0.0f32; N];
    let mut spec = vec![Complex32::new(0.0, 0.0); N / 2 + 1];
    let mut start = 0usize;
    while start < len {
        let f0 = f0_at(start + N / 2);
        for (input, out) in [(&left, &mut out_l), (&right, &mut out_r)] {
            for j in 0..N {
                buf[j] = input.get(start + j).copied().unwrap_or(0.0) * window[j];
            }
            fwd.process(&mut buf, &mut spec).expect("fft");
            for (bin, c) in spec.iter_mut().enumerate() {
                *c *= if f0 > 0.0 { comb(bin, f0, bin_hz) } else { 0.0 };
            }
            inv.process(&mut spec, &mut buf).expect("ifft");
            for j in 0..N {
                out[start + j] += buf[j] * window[j] / N as f32;
            }
        }
        for j in 0..N {
            norm[start + j] += window[j] * window[j];
        }
        start += HOP;
    }
    (a..b)
        .flat_map(|f| {
            let i = f - pa;
            let n = norm[i].max(1e-3);
            [out_l[i] / n, out_r[i] / n]
        })
        .collect()
}

// ------------------------------------------------------------- duet split --

/// Interleaved stereo resampled from `from` to `to` Hz, exactly `frames` long.
fn resample(stereo: &[f32], from: u32, to: u32, frames: usize) -> Result<Vec<f32>, String> {
    let mut rs = super::decode::StreamResampler::new(from, to)?;
    let (mut out, mut tail) = (Vec::new(), Vec::new());
    rs.push(stereo, &mut out)?;
    rs.flush(&mut tail)?;
    out.extend_from_slice(&tail);
    out.resize(frames * 2, 0.0);
    Ok(out)
}

/// Energy of interleaved stereo `x` over frames `a..b`.
fn energy(x: &[f32], a: usize, b: usize) -> f32 {
    x.get(2 * a..2 * b).map(|s| s.iter().map(|v| v * v).sum()).unwrap_or(0.0)
}

/// The stereo vocal from `from` to `to` seconds (a duet's overlap) with only
/// one singer kept: `voice` 1 the female, 2 the male, otherwise the one
/// singing alone in `reference` (seconds, the part this overlap belongs to). The male/female model splits the voices; the
/// singer is told apart by who sings `reference`. Interleaved stereo of
/// exactly `from..to`, at `sr`.
pub fn split_duet(
    splitter: &mut super::duet::VoiceSplitter,
    vocal: &[f32],
    sr: u32,
    from: f64,
    to: f64,
    reference: (f64, f64),
    voice: u8,
) -> Result<Vec<f32>, String> {
    use super::duet::RATE;
    let fs = sr as f64;
    let frames = vocal.len() / 2;
    let at = |t: f64| ((t * fs).max(0.0) as usize).min(frames);
    let (a, b) = (at(from), at(to));
    if b <= a {
        return Ok(Vec::new());
    }
    // One window covering the overlap and its reference, plus a little lead-in.
    let (wa, wb) = (at(from.min(reference.0) - 0.25), at(to.max(reference.1) + 0.25));
    let window = &vocal[2 * wa..2 * wb];
    let n_model = ((wb - wa) as f64 * RATE as f64 / fs).round() as usize;
    let voices = splitter.split(&resample(window, sr, RATE, n_model)?)?;
    let male = resample(&voices.male, RATE, sr, wb - wa)?;
    let female = resample(&voices.female, RATE, sr, wb - wa)?;
    let (ra, rb) = (at(reference.0).saturating_sub(wa), at(reference.1).saturating_sub(wa));
    // 1 = the female voice, 2 = the male; otherwise whoever sings the reference.
    let female_wins = match voice {
        1 => true,
        2 => false,
        _ => energy(&female, ra, rb) >= energy(&male, ra, rb),
    };
    let keep = if female_wins { female } else { male };
    Ok(keep[2 * (a - wa)..2 * (b - wa)].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sung A4 plus noise standing in for rap: the tone stays, the noise mostly goes.
    #[test]
    fn keeps_the_sung_note_and_drops_noise() {
        let sr = 44_100u32;
        let n = sr as usize;
        let mut seed = 7u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        };
        let (tone, hiss): (Vec<f32>, Vec<f32>) = (0..n)
            .map(|i| {
                let t = i as f32 / sr as f32;
                let s = (1..=4).map(|h| (std::f32::consts::TAU * 440.0 * h as f32 * t).sin() / h as f32).sum::<f32>() * 0.2;
                (s, noise() * 0.2)
            })
            .unzip();
        let mix: Vec<f32> = tone.iter().zip(&hiss).flat_map(|(s, h)| [s + h, s + h]).collect();
        let notes = [Note { start: 0.0, end: 1.0, midi: 69.0 }];
        let out = sung_only(&mix, sr, 0.3, 0.7, &notes);
        let expect = (0.7 * sr as f64) as usize - (0.3 * sr as f64) as usize;
        assert_eq!(out.len(), expect * 2);
        let a = (0.3 * sr as f64) as usize;
        let (mut err, mut sig, mut before) = (0.0f32, 0.0f32, 0.0f32);
        for (k, pair) in out.chunks(2).enumerate() {
            let s = tone[a + k];
            err += (pair[0] - s).powi(2);
            sig += s * s;
            before += hiss[a + k].powi(2);
        }
        // Much closer to the clean tone than the noisy input was.
        assert!(err < before * 0.25, "residual {err} vs noise {before} (signal {sig})");
    }

    /// The male/female model on a real overlap (run by hand):
    /// `DUET_MODEL=…/bs_roformer_male_female.onnx DUET_WAV=…vocals.wav DUET_AT=100.6,101.4 DUET_REF=98.6,100.6 cargo test --lib duet_on_real_audio -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn duet_on_real_audio() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let pair = |k: &str| -> (f64, f64) {
            let v: Vec<f64> = var(k).split(',').map(|x| x.parse().unwrap()).collect();
            (v[0], v[1])
        };
        let sr = 44_100;
        let vocal = crate::audio::decode::decode_file(std::path::Path::new(&var("DUET_WAV")), sr).expect("wav");
        let (at, reference) = (pair("DUET_AT"), pair("DUET_REF"));
        let mut sp = crate::audio::duet::VoiceSplitter::load(std::path::Path::new(&var("DUET_MODEL"))).expect("model");
        let t0 = std::time::Instant::now();
        let kept = split_duet(&mut sp, &vocal, sr, at.0, at.1, reference, 0).expect("split");
        let (a, b) = ((at.0 * sr as f64) as usize, (at.1 * sr as f64) as usize);
        let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt();
        println!(
            "kept {:.2}s of overlap in {:.1}s; kept rms {:.4} of original {:.4}",
            at.1 - at.0,
            t0.elapsed().as_secs_f32(),
            rms(&kept),
            rms(&vocal[2 * a..2 * b])
        );
        if let Ok(out) = std::env::var("DUET_OUT") {
            crate::audio::decode::write_wav(std::path::Path::new(&out), &kept, sr).expect("write");
        }
        assert_eq!(kept.len(), 2 * (b - a));
    }

    #[test]
    fn no_note_no_voice() {
        let mix = vec![0.3f32; 44_100 * 2];
        let out = sung_only(&mix, 44_100, 0.2, 0.5, &[]);
        assert!(out.iter().all(|x| x.abs() < 1e-6));
    }
}
