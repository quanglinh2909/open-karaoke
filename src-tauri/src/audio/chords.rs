//! The chords of a song, from its instrumental: so the automatic harmony sings
//! notes of the chord being played (as an arranger writes a "bè"), not just a
//! third up the scale, which clashes wherever the chord isn't the scale's.
//!
//! A chroma (energy per pitch class) every ~0.1 s, each frame scored against
//! the 24 major and minor triads, then the chord sequence that best follows
//! those scores while changing as rarely as it can (Viterbi). Chords of the
//! song's key get a small bonus. Quiet stretches have no chord.

use super::separate::Stft;
use serde::{Deserialize, Serialize};

const SR: u32 = 22_050;
const N_FFT: usize = 8192;
const HOP: usize = 2048;
/// Score lost for each chord change (a frame's score is at most 1).
const SWITCH: f32 = 0.6;
/// Bonus for the chords of the song's key.
const IN_KEY: f32 = 0.04;
/// Score of "no chord" (beats weak matches and silence).
const NONE: f32 = 0.45;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Chord {
    /// Seconds from the start of the recording.
    pub start: f32,
    pub end: f32,
    /// Pitch class of the root, 0 = C.
    pub root: u8,
    pub minor: bool,
}

impl Chord {
    /// Whether the MIDI note `m` is one of the triad's notes.
    pub fn has(&self, m: i32) -> bool {
        let pc = (m - self.root as i32).rem_euclid(12);
        pc == 0 || pc == 7 || pc == if self.minor { 3 } else { 4 }
    }
}

/// The chord sounding at `t` (seconds), if any.
pub fn chord_at(chords: &[Chord], t: f32) -> Option<&Chord> {
    let i = chords.partition_point(|c| c.end <= t);
    chords.get(i).filter(|c| c.start <= t)
}

/// Stereo or mono to mono at `SR` (a simple low-passed decimation).
fn mono_at_sr(audio: &[f32], channels: usize, sr: u32) -> Vec<f32> {
    let mono: Vec<f32> = audio.chunks_exact(channels).map(|c| c.iter().sum::<f32>() / channels as f32).collect();
    let step = sr as f64 / SR as f64;
    if step <= 1.01 {
        return mono;
    }
    // Average over each output sample's span: enough below 2 kHz.
    let n = (mono.len() as f64 / step) as usize;
    (0..n)
        .map(|i| {
            let (a, b) = ((i as f64 * step) as usize, (((i + 1) as f64 * step) as usize).min(mono.len()));
            mono[a..b.max(a + 1).min(mono.len())].iter().sum::<f32>() / (b.max(a + 1) - a) as f32
        })
        .collect()
}

/// Chroma per frame, L2-normalised, and each frame's loudness.
fn chroma(mono: &[f32]) -> (Vec<[f32; 12]>, Vec<f32>) {
    let mut stft = Stft::new(N_FFT, HOP);
    let bin_hz = SR as f32 / N_FFT as f32;
    // Each bin from 65 Hz (C2) to 2.1 kHz: its pitch class, weighted down
    // in the treble (harmonics there blur the chord).
    let bins: Vec<(usize, usize, f32)> = (1..stft.bins())
        .filter_map(|k| {
            let f = k as f32 * bin_hz;
            if !(65.0..=2100.0).contains(&f) {
                return None;
            }
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            let w = if f > 1000.0 { 0.5 } else { 1.0 };
            Some((k, (midi.round() as i32).rem_euclid(12) as usize, w))
        })
        .collect();
    let mut frames = Vec::new();
    let mut level = Vec::new();
    stft.forward(mono, |_, s| {
        let mut c = [0.0f32; 12];
        let mut e = 0.0;
        for &(k, pc, w) in &bins {
            let m = s[k].norm();
            c[pc] += w * m;
            e += m * m;
        }
        frames.push(c);
        level.push(e.sqrt());
    });
    // Smooth over about half a second: chords last longer than notes.
    let n = frames.len();
    let mut smooth = vec![[0.0f32; 12]; n];
    for (i, out) in smooth.iter_mut().enumerate() {
        let (a, b) = (i.saturating_sub(2), (i + 3).min(n));
        for f in &frames[a..b] {
            for p in 0..12 {
                out[p] += f[p];
            }
        }
        // Compress so one loud note doesn't outweigh the rest of the chord.
        out.iter_mut().for_each(|v| *v = v.sqrt());
        let len = out.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-9);
        out.iter_mut().for_each(|v| *v /= len);
    }
    (smooth, level)
}

/// Chords of `audio` (`channels` interleaved, `sr` Hz), optionally in the
/// key `tonic` (0 = C) major or minor.
pub fn detect(audio: &[f32], channels: usize, sr: u32, key: Option<(u8, bool)>) -> Vec<Chord> {
    let mono = mono_at_sr(audio, channels.max(1), sr);
    if mono.len() < N_FFT {
        return Vec::new();
    }
    let (frames, level) = chroma(&mono);
    let n = frames.len();
    // States 0..24: root * 2 + minor; 24: no chord.
    let tri = |s: usize| -> [f32; 12] {
        let (root, minor) = (s / 2, s % 2 == 1);
        let mut t = [0.0f32; 12];
        for iv in [0, if minor { 3 } else { 4 }, 7] {
            t[(root + iv) % 12] = 1.0 / 3f32.sqrt();
        }
        t
    };
    let templates: Vec<[f32; 12]> = (0..24).map(tri).collect();
    // The key's six chords (a minor key: those of its relative major).
    let diatonic: Vec<bool> = (0..24)
        .map(|s| match key {
            Some((tonic, minor)) => {
                let major_tonic = if minor { (tonic + 3) % 12 } else { tonic } as usize;
                let rel = (s / 2 + 12 - major_tonic) % 12;
                let is_minor = s % 2 == 1;
                matches!((rel, is_minor), (0, false) | (5, false) | (7, false) | (2, true) | (4, true) | (9, true))
            }
            None => false,
        })
        .collect();
    let mut sorted = level.clone();
    sorted.sort_by(f32::total_cmp);
    let quiet = sorted[sorted.len() / 2] * 0.15;
    let score = |t: usize, s: usize| -> f32 {
        if s == 24 {
            return if level[t] < quiet { 1.0 } else { NONE };
        }
        let fit: f32 = frames[t].iter().zip(&templates[s]).map(|(a, b)| a * b).sum();
        fit + if diatonic[s] { IN_KEY } else { 0.0 }
    };
    // Viterbi: staying costs nothing, changing costs `SWITCH`.
    const S: usize = 25;
    let mut acc: Vec<f32> = (0..S).map(|s| score(0, s)).collect();
    let mut back = vec![[0u8; S]; n];
    for t in 1..n {
        let (best_s, best) = acc.iter().enumerate().fold((0, f32::MIN), |m, (s, v)| if *v > m.1 { (s, *v) } else { m });
        let mut next = [0.0f32; S];
        for s in 0..S {
            let (from, v) = if acc[s] >= best - SWITCH { (s, acc[s]) } else { (best_s, best - SWITCH) };
            back[t][s] = from as u8;
            next[s] = v + score(t, s);
        }
        acc.copy_from_slice(&next);
    }
    let mut s = acc.iter().enumerate().fold((0, f32::MIN), |m, (s, v)| if *v > m.1 { (s, *v) } else { m }).0;
    let mut path = vec![0usize; n];
    for t in (0..n).rev() {
        path[t] = s;
        s = back[t][s] as usize;
    }
    let secs = |f: usize| (f * HOP) as f32 / SR as f32;
    let mut out: Vec<Chord> = Vec::new();
    let mut t = 0;
    while t < n {
        let mut u = t;
        while u + 1 < n && path[u + 1] == path[t] {
            u += 1;
        }
        if path[t] < 24 {
            out.push(Chord { start: secs(t), end: secs(u + 1), root: (path[t] / 2) as u8, minor: path[t] % 2 == 1 });
        }
        t = u + 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A piano-like tone of the triad `notes` (MIDI), `secs` long.
    fn triad(notes: &[i32], secs: f32, sr: u32) -> Vec<f32> {
        let n = (secs * sr as f32) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / sr as f32;
                notes
                    .iter()
                    .map(|m| {
                        let f = 440.0 * 2f32.powf((*m as f32 - 69.0) / 12.0);
                        (1..=4).map(|h| (std::f32::consts::TAU * f * h as f32 * t).sin() / (h * h) as f32).sum::<f32>()
                    })
                    .sum::<f32>()
                    * 0.1
            })
            .collect()
    }

    /// C – Am – F – G, two seconds each: found in that order, near the changes.
    #[test]
    fn finds_a_pop_progression() {
        let sr = 44_100;
        let prog = [(&[48, 60, 64, 67][..], 0u8, false), (&[45, 57, 60, 64][..], 9, true), (&[41, 57, 60, 65][..], 5, false), (&[43, 55, 59, 62][..], 7, false)];
        let audio: Vec<f32> = prog.iter().flat_map(|(n, _, _)| triad(n, 2.0, sr)).collect();
        let chords = detect(&audio, 1, sr, Some((0, false)));
        assert_eq!(chords.len(), 4, "{chords:?}");
        for (i, (c, (_, root, minor))) in chords.iter().zip(prog.iter()).enumerate() {
            assert_eq!((c.root, c.minor), (*root, *minor), "chord {i}: {chords:?}");
            if i > 0 {
                assert!((c.start - 2.0 * i as f32).abs() < 0.4, "chord {i} starts at {}", c.start);
            }
        }
        assert_eq!(chord_at(&chords, 5.0).map(|c| c.root), Some(5));
        assert!(Chord { start: 0.0, end: 1.0, root: 9, minor: true }.has(72), "C is in A minor");
    }
}

#[cfg(test)]
mod real {
    /// On a real instrumental (run by hand):
    /// `CHORDS_WAV=…/<id>.instrumental.wav cargo test --lib chords_on_real_audio -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn chords_on_real_audio() {
        let path = std::env::var("CHORDS_WAV").expect("set CHORDS_WAV");
        let stereo = crate::audio::decode::decode_file(std::path::Path::new(&path), 44_100).expect("wav");
        let t0 = std::time::Instant::now();
        let key = crate::audio::analysis::detect_key(&crate::audio::analysis::mono(&stereo), 44_100);
        let chords = super::detect(&stereo, 2, 44_100, Some((key.tonic, key.minor)));
        const NAMES: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
        println!("{} chords in {:.2}s (key {}{})", chords.len(), t0.elapsed().as_secs_f32(), NAMES[key.tonic as usize], if key.minor { "m" } else { "" });
        for c in chords.iter().take(60) {
            println!("{:6.1}–{:6.1}  {}{}", c.start, c.end, NAMES[c.root as usize], if c.minor { "m" } else { "" });
        }
    }
}
