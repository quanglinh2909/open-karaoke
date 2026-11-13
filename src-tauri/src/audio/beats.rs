//! The beat of a song, from its instrumental: so the countdown before a line
//! can count the song's own beats ("3 – 2 – 1" on the drums) rather than
//! seconds. Ellis's dynamic-programming beat tracker (2007, as in librosa):
//! an onset envelope from the spectral flux, the tempo from its
//! autocorrelation (weighted toward 120 BPM), then the beat times that best
//! follow both the onsets and that tempo.

use super::separate::Stft;
use serde::{Deserialize, Serialize};

const N_FFT: usize = 2048;
const HOP: usize = 512;
/// How strongly beats keep to the tempo (librosa's `tightness`).
const TIGHTNESS: f32 = 100.0;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Beats {
    /// Beats per minute.
    pub bpm: f32,
    /// Beat times, seconds from the start of the recording.
    pub times: Vec<f64>,
    /// Loudness of the music, RMS every `ENERGY_STEP` seconds (for finding
    /// the climaxes). Empty in files saved before it was added.
    #[serde(default)]
    pub energy: Vec<f32>,
}

/// Seconds per `Beats::energy` value.
pub const ENERGY_STEP: f64 = 0.5;

/// RMS of `mono` every `ENERGY_STEP` seconds.
pub fn energy(mono: &[f32], sr: u32) -> Vec<f32> {
    let n = (sr as f64 * ENERGY_STEP) as usize;
    mono.chunks(n.max(1)).map(|c| (c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32).sqrt()).collect()
}

/// Onset strength per STFT frame: positive changes in log magnitude, summed
/// over the bins up to about 8 kHz, with the slow trend taken out.
fn onsets(mono: &[f32], sr: u32) -> Vec<f32> {
    let mut stft = Stft::new(N_FFT, HOP);
    let top = ((8000.0 / sr as f32) * N_FFT as f32) as usize;
    let top = top.clamp(8, stft.bins());
    let mut prev: Vec<f32> = vec![0.0; top];
    let mut flux = Vec::with_capacity(stft.frames(mono.len()));
    let mut first = true;
    stft.forward(mono, |_, s| {
        let mut sum = 0.0;
        for k in 0..top {
            let m = (1.0 + 100.0 * s[k].norm()).ln();
            if !first {
                sum += (m - prev[k]).max(0.0);
            }
            prev[k] = m;
        }
        first = false;
        flux.push(sum);
    });
    // Take out the local mean (about a second), keep what rises above it.
    let w = (sr as usize / HOP).max(1);
    let mut acc = 0.0f64;
    let mut out = vec![0.0f32; flux.len()];
    let mut pre = vec![0.0f64; flux.len() + 1];
    for (i, f) in flux.iter().enumerate() {
        acc += *f as f64;
        pre[i + 1] = acc;
    }
    for i in 0..flux.len() {
        let (a, b) = (i.saturating_sub(w / 2), (i + w / 2 + 1).min(flux.len()));
        let mean = (pre[b] - pre[a]) / (b - a) as f64;
        out[i] = (flux[i] as f64 - mean).max(0.0) as f32;
    }
    let sd = (out.iter().map(|v| v * v).sum::<f32>() / out.len().max(1) as f32).sqrt().max(1e-6);
    out.iter_mut().for_each(|v| *v /= sd);
    out
}

/// The beat period in frames: the autocorrelation peak, weighted by a
/// log-normal prior around 120 BPM (one octave wide), within 50–200 BPM.
fn period(env: &[f32], fps: f32) -> f32 {
    let lag = |bpm: f32| (60.0 * fps / bpm).round() as usize;
    let (lo, hi) = (lag(200.0).max(1), lag(50.0).min(env.len().saturating_sub(1)));
    let mut best = (0.0f32, lag(120.0) as f32);
    for l in lo..=hi.max(lo) {
        let ac: f32 = env.iter().zip(&env[l..]).map(|(a, b)| a * b).sum::<f32>() / (env.len() - l) as f32;
        let bpm = 60.0 * fps / l as f32;
        let w = (-0.5 * (bpm / 120.0).log2().powi(2)).exp();
        if ac * w > best.0 {
            best = (ac * w, l as f32);
        }
    }
    // Refine between frames: a parabola through the peak and its neighbours.
    let l = best.1 as usize;
    if l > lo && l < hi {
        let ac = |l: usize| env.iter().zip(&env[l..]).map(|(a, b)| a * b).sum::<f32>() / (env.len() - l) as f32;
        let (a, b, c) = (ac(l - 1), ac(l), ac(l + 1));
        let d = a - 2.0 * b + c;
        if d < 0.0 {
            return l as f32 + 0.5 * (a - c) / d;
        }
    }
    best.1
}

/// The beats of a mono signal at `sr` Hz.
pub fn track(mono: &[f32], sr: u32) -> Beats {
    let fps = sr as f32 / HOP as f32;
    let env = onsets(mono, sr);
    if env.len() < 16 {
        return Beats { bpm: 0.0, times: Vec::new(), energy: Vec::new() };
    }
    let tau = period(&env, fps);
    // Local score: the onsets smoothed by a narrow Gaussian (a 32nd of a beat).
    let sigma = (tau / 32.0).max(0.5);
    let radius = (3.0 * sigma).ceil() as isize;
    let kernel: Vec<f32> = (-radius..=radius).map(|i| (-0.5 * (i as f32 / sigma).powi(2)).exp()).collect();
    let local: Vec<f32> = (0..env.len() as isize)
        .map(|i| (-radius..=radius).map(|d| env.get((i + d) as usize).copied().unwrap_or(0.0) * kernel[(d + radius) as usize]).sum())
        .collect();
    // Best path ending at each frame: its onset plus the best earlier beat
    // half a period to two periods back, penalised for straying from the tempo.
    let n = local.len();
    let mut score = vec![0.0f32; n];
    let mut back = vec![-1isize; n];
    let (near, far) = ((tau / 2.0).round() as usize, (2.0 * tau).round() as usize);
    for t in 0..n {
        let mut best = (f32::MIN, -1isize);
        if t >= near {
            for p in t.saturating_sub(far)..=t - near {
                let gap = (t - p) as f32 / tau;
                let s = score[p] - TIGHTNESS * gap.ln().powi(2);
                if s > best.0 {
                    best = (s, p as isize);
                }
            }
        }
        score[t] = local[t] + best.0.max(0.0);
        back[t] = if best.0 > 0.0 { best.1 } else { -1 };
    }
    // The last beat: the last peak of the running score worth half the median peak.
    let peaks: Vec<usize> = (1..n.saturating_sub(1)).filter(|&i| score[i] > score[i - 1] && score[i] >= score[i + 1]).collect();
    let mut tops: Vec<f32> = peaks.iter().map(|&i| score[i]).collect();
    tops.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = tops.get(tops.len() / 2).copied().unwrap_or(0.0);
    let Some(&end) = peaks.iter().rev().find(|&&i| score[i] >= 0.5 * median) else {
        return Beats { bpm: 60.0 * fps / tau, times: Vec::new(), energy: Vec::new() };
    };
    let mut frames = Vec::new();
    let mut at = end as isize;
    while at >= 0 {
        frames.push(at as usize);
        at = back[at as usize];
    }
    frames.reverse();
    // Drop beats in the quiet before the music starts and after it ends.
    let rms = (local.iter().map(|v| v * v).sum::<f32>() / n as f32).sqrt();
    let loud = |f: &usize| {
        let (a, b) = (f.saturating_sub(near), (*f + near).min(n));
        local[a..b].iter().cloned().fold(0.0, f32::max) >= 0.5 * rms
    };
    let first = frames.iter().position(loud).unwrap_or(0);
    let last = frames.iter().rposition(loud).map(|i| i + 1).unwrap_or(frames.len());
    let times = frames[first..last.max(first)].iter().map(|&f| f as f64 * HOP as f64 / sr as f64).collect();
    Beats { bpm: 60.0 * fps / tau, times, energy: energy(mono, sr) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Clicks at 100 BPM under noise: about 100 BPM, beats on the clicks.
    #[test]
    fn finds_the_beat_of_a_click_track() {
        let sr = 22_050u32;
        let secs = 30.0;
        let n = (sr as f32 * secs) as usize;
        let mut seed = 3u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        };
        let period = 0.6; // 100 BPM
        let offset = 0.25;
        let mono: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / sr as f32;
                let since = (t - offset).rem_euclid(period);
                let click = if t >= offset && since < 0.03 { (1.0 - since / 0.03) * (std::f32::consts::TAU * 1000.0 * t).sin() } else { 0.0 };
                0.8 * click + 0.05 * noise()
            })
            .collect();
        let b = track(&mono, sr);
        assert!((b.bpm - 100.0).abs() < 3.0, "bpm {}", b.bpm);
        assert!(b.times.len() > 40, "{} beats", b.times.len());
        // Every beat within 50 ms of a click.
        for &t in &b.times {
            let d = ((t - offset as f64).rem_euclid(period as f64)).min(period as f64 - (t - offset as f64).rem_euclid(period as f64));
            assert!(d < 0.05, "beat at {t:.3} is {d:.3}s from a click");
        }
    }
}

#[cfg(test)]
mod real {
    /// On a real instrumental (run by hand):
    /// `BEATS_WAV=…/<id>.instrumental.wav cargo test --lib beats_on_real_audio -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn beats_on_real_audio() {
        let path = std::env::var("BEATS_WAV").expect("set BEATS_WAV");
        let stereo = crate::audio::decode::decode_file(std::path::Path::new(&path), 22_050).expect("wav");
        let mono: Vec<f32> = stereo.chunks(2).map(|c| 0.5 * (c[0] + c[1])).collect();
        let t0 = std::time::Instant::now();
        let b = super::track(&mono, 22_050);
        let gaps: Vec<f64> = b.times.windows(2).map(|w| w[1] - w[0]).collect();
        let mean = gaps.iter().sum::<f64>() / gaps.len().max(1) as f64;
        let sd = (gaps.iter().map(|g| (g - mean).powi(2)).sum::<f64>() / gaps.len().max(1) as f64).sqrt();
        println!(
            "{:.0} BPM, {} beats from {:.2}s to {:.2}s, gap {:.3}±{:.3}s, in {:.2}s",
            b.bpm,
            b.times.len(),
            b.times.first().unwrap_or(&0.0),
            b.times.last().unwrap_or(&0.0),
            mean,
            sd,
            t0.elapsed().as_secs_f32()
        );
    }
}
