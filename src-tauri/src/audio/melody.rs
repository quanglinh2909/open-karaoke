//! The original singer's melody, as notes, from the separated vocal.
//!
//! SwiftF0 (MIT, about 14k parameters, ~180× real time on one CPU core)
//! tracks the pitch every 16 ms; `notes` then turns that contour into notes
//! with a port of `swift_f0.music.segment_notes`. The notes drive the note
//! bars on the pitch graph and score the singer against the melody rather
//! than just the key.

#[cfg(has_ort)]
use ort::session::builder::GraphOptimizationLevel;
#[cfg(has_ort)]
use ort::session::Session;
#[cfg(has_ort)]
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub struct ModelInfo {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

/// lars76/swift-f0's model, pinned to a commit.
pub const MODEL: ModelInfo = ModelInfo {
    file: "swift-f0.onnx",
    url: "https://raw.githubusercontent.com/lars76/swift-f0/d1ba77fe5331310b778ebe126b6cb3656d41d24f/swift_f0/model.onnx",
    sha256: "6385e8c2ebc3872e82c9ff5946228de44cd3be77a750ea53698b7dbfe94b0a22",
};

/// The model listens at 16 kHz mono.
pub const SAMPLE_RATE: u32 = 16_000;
/// Samples per pitch frame (16 ms).
const HOP: usize = 256;
pub const FRAME: f32 = HOP as f32 / SAMPLE_RATE as f32;
/// Pitch search range: a singing voice, C2–C♯6 (the model allows 47 Hz–2.1 kHz).
const FMIN: f32 = 65.0;
const FMAX: f32 = 1100.0;
/// Frames per model call, and the context it needs around them to give
/// the same result as one long call (from swift_f0.core).
const WINDOW_FRAMES: usize = 1875;
const LEFT_FRAMES: usize = 11;
const LOOKAHEAD_FRAMES: usize = 10;
/// Hops whose audio peaks below this are digital silence, where the model
/// answers with random pitches: their confidence is set to 0.
const SILENCE_PEAK: f32 = 1e-3;
/// Cost of starting a note, in ms of steady pitch: a new pitch a semitone
/// away becomes its own note once it lasts longer than this.
pub const NOTE_HOLD_MS: f32 = 80.0;

/// Pitch per 16 ms frame: Hz (0 = none), voicing confidence 0–1, level dB.
pub struct Contour {
    pub pitch: Vec<f32>,
    pub confidence: Vec<f32>,
    pub loudness: Vec<f32>,
}

/// One sung note: seconds in the recording, and its pitch as fractional MIDI.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Note {
    pub start: f32,
    pub end: f32,
    pub midi: f32,
}

#[cfg(has_ort)]
pub struct Tracker {
    session: Session,
    /// Must outlive the session.
    _env: ort::environment::Environment,
}

#[cfg(has_ort)]
impl Tracker {
    pub fn load(model: &Path) -> Result<Self, String> {
        let env = ort::init()
            .with_name("open-karaoke-melody")
            .build()
            .map_err(|e| format!("Không khởi động được ONNX Runtime: {e}"))?;
        let fail = |e: &dyn std::fmt::Display| format!("Không tải được mô hình dò giai điệu: {e}");
        // More than a few threads don't help a model this small.
        let session = Session::builder(&env)
            .map_err(|e| fail(&e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| fail(&e))?
            .with_intra_threads(4)
            .map_err(|e| fail(&e))?
            .commit_from_file(model)
            .map_err(|e| fail(&e))?;
        Ok(Self { session, _env: env })
    }

    /// The pitch contour of 16 kHz mono audio.
    pub fn contour(&mut self, audio: &[f32]) -> Result<Contour, String> {
        let n = (audio.len() / HOP).max(1);
        let mut pitch = Vec::with_capacity(n);
        let mut confidence = Vec::with_capacity(n);
        let mut start = 0;
        while start < n {
            let end = (start + WINDOW_FRAMES).min(n);
            let left = start.saturating_sub(LEFT_FRAMES);
            let to = if end < n { ((end + LOOKAHEAD_FRAMES) * HOP).min(audio.len()) } else { audio.len() };
            let (p, c) = self.run(&audio[left * HOP..to])?;
            for i in (start - left)..(end - left) {
                pitch.push(p.get(i).copied().unwrap_or(0.0));
                confidence.push(c.get(i).copied().unwrap_or(0.0));
            }
            start = end;
        }
        let (confidence, loudness) = gate_and_level(audio, confidence);
        Ok(Contour { pitch, confidence, loudness })
    }

    fn run(&mut self, chunk: &[f32]) -> Result<(Vec<f32>, Vec<f32>), String> {
        let fail = |e: ort::Error| format!("Dò giai điệu thất bại: {e}");
        let audio = Tensor::from_array(([1usize, chunk.len()], chunk.to_vec())).map_err(|e| e.to_string())?;
        let fmin = Tensor::from_array(([0usize; 0], vec![FMIN])).map_err(|e| e.to_string())?;
        let fmax = Tensor::from_array(([0usize; 0], vec![FMAX])).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs!["audio" => audio, "fmin" => fmin, "fmax" => fmax]).map_err(fail)?;
        // The export's outputs may be float or double.
        let read = |name: &str| -> Result<Vec<f32>, String> {
            let v = &outputs[name];
            match v.try_extract_tensor::<f32>() {
                Ok((_, data)) => Ok(data.to_vec()),
                Err(_) => v.try_extract_tensor::<f64>().map(|(_, d)| d.iter().map(|&x| x as f32).collect()).map_err(|e| e.to_string()),
            }
        };
        Ok((read("pitch")?, read("confidence")?))
    }
}

/// Stand-in for builds without ONNX Runtime (Intel Macs).
#[cfg(not(has_ort))]
pub struct Tracker;

#[cfg(not(has_ort))]
impl Tracker {
    pub fn load(_model: &Path) -> Result<Self, String> {
        Err(super::separate::UNAVAILABLE.into())
    }
    pub fn contour(&mut self, _audio: &[f32]) -> Result<Contour, String> {
        Err(super::separate::UNAVAILABLE.into())
    }
}

/// Zero the confidence of silent hops, and each frame's level in dB (the
/// 32 ms around it), as swift_f0 does.
fn gate_and_level(audio: &[f32], mut confidence: Vec<f32>) -> (Vec<f32>, Vec<f32>) {
    let n = confidence.len();
    let mut power = vec![0f64; n];
    for (i, c) in confidence.iter_mut().enumerate() {
        let hop = &audio[(i * HOP).min(audio.len())..((i + 1) * HOP).min(audio.len())];
        if hop.iter().fold(0f32, |m, x| m.max(x.abs())) < SILENCE_PEAK {
            *c = 0.0;
        }
        power[i] = hop.iter().map(|&x| (x as f64) * (x as f64)).sum();
    }
    let loudness = (0..n)
        .map(|i| {
            let prev = if i > 0 { power[i - 1] } else { 0.0 };
            (20.0 * ((prev + power[i]) / 512.0).sqrt().max(1e-7).log10()) as f32
        })
        .collect();
    (confidence, loudness)
}

/// Split a pitch contour into notes, exactly as swift_f0's segment_notes:
/// the notes and gaps with the smallest total cost
///   sum over notes of [hold + sum over its frames of (off-pitch + unvoiced + quiet)],
/// found by dynamic programming. Each note has one pitch, one of the
/// measured pitches rounded to a cent. Gaps cost nothing.
pub fn notes(c: &Contour, hold_ms: f32) -> Vec<Note> {
    let n = c.pitch.len();
    let valid: Vec<bool> = c.pitch.iter().map(|&p| p.is_finite() && p > 0.0).collect();
    if !valid.iter().any(|&v| v) {
        return Vec::new();
    }
    let m: Vec<f64> = (0..n).map(|t| if valid[t] { 69.0 + 12.0 * (c.pitch[t] as f64 / 440.0).log2() } else { 0.0 }).collect();
    let w: Vec<f64> = (0..n).map(|t| if valid[t] { c.confidence[t] as f64 } else { 0.0 }).collect();
    // Frames well below the loudest within 64 ms either side are probably
    // breaths or bleed, not the note.
    let level = |i: isize| -> f64 {
        let n = n as isize;
        let j = if i < 0 { -i - 1 } else if i >= n { 2 * n - i - 1 } else { i };
        c.loudness[j.clamp(0, n - 1) as usize] as f64
    };
    let q: Vec<f64> = (0..n)
        .map(|t| {
            let cc = w[t].clamp(0.01, 0.99);
            let ti = t as isize;
            let left = (0..5).map(|j| level(ti - 4 + j)).fold(f64::MIN, f64::max);
            let right = (0..5).map(|j| level(ti + j)).fold(f64::MIN, f64::max);
            -(cc / (1.0 - cc)).ln() + (left.min(right) - level(ti) - 10.0 * 2f64.log10()).max(0.0)
        })
        .collect();
    let mut mu: Vec<f64> = (0..n).filter(|&t| valid[t]).map(|t| (m[t] * 100.0 + 0.5).floor() / 100.0).collect();
    mu.sort_by(|a, b| a.partial_cmp(b).unwrap());
    mu.dedup();

    let beta = hold_ms as f64 / 1000.0 / FRAME as f64;
    let mut vn = vec![f64::INFINITY; mu.len()];
    let mut note_start = vec![0usize; mu.len()];
    let mut back = vec![0usize; n + 1];
    let mut kind = vec![usize::MAX; n + 1];
    let mut best = 0.0f64;
    for t in 0..n {
        let start = best + beta;
        let (wt, mt, qt) = (w[t], m[t], q[t]);
        let mut j_best = 0;
        let mut v_best = f64::INFINITY;
        for j in 0..mu.len() {
            if start < vn[j] {
                note_start[j] = t;
                vn[j] = start;
            }
            vn[j] += wt * (mu[j] - mt).abs().min(2.0) + qt;
            if vn[j] < v_best {
                v_best = vn[j];
                j_best = j;
            }
        }
        if v_best < best {
            best = v_best;
            back[t + 1] = note_start[j_best];
            kind[t + 1] = j_best;
        } else {
            back[t + 1] = t;
        }
    }
    let mut out = Vec::new();
    let mut b = n;
    while b > 0 {
        let a = back[b];
        if kind[b] != usize::MAX {
            out.push(Note { start: a as f32 * FRAME, end: b as f32 * FRAME, midi: mu[kind[b]] as f32 });
        }
        b = a;
    }
    out.reverse();
    out
}

/// The note sounding at `t` seconds, or one within `slack` of it.
pub fn note_at(notes: &[Note], t: f32, slack: f32) -> Option<&Note> {
    let i = notes.partition_point(|n| n.end < t - slack);
    notes.get(i).filter(|n| n.start <= t + slack)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hz(midi: f32) -> f32 {
        440.0 * 2f32.powf((midi - 69.0) / 12.0)
    }

    /// `frames` of steady pitch per (midi, frames), 0 midi = silence.
    fn contour(parts: &[(f32, usize)]) -> Contour {
        let (mut pitch, mut confidence, mut loudness) = (Vec::new(), Vec::new(), Vec::new());
        for &(midi, frames) in parts {
            for _ in 0..frames {
                pitch.push(if midi > 0.0 { hz(midi) } else { 0.0 });
                confidence.push(if midi > 0.0 { 0.95 } else { 0.02 });
                loudness.push(if midi > 0.0 { -20.0 } else { -70.0 });
            }
        }
        Contour { pitch, confidence, loudness }
    }

    #[test]
    fn steady_pitches_become_notes() {
        // C4 for 0.5 s, a breath, then E4 for 0.8 s.
        let c = contour(&[(0.0, 10), (60.0, 31), (0.0, 12), (64.0, 50), (0.0, 10)]);
        let ns = notes(&c, NOTE_HOLD_MS);
        assert_eq!(ns.len(), 2, "{ns:?}");
        assert!((ns[0].midi - 60.0).abs() < 0.05 && (ns[1].midi - 64.0).abs() < 0.05);
        assert!((ns[0].start - 10.0 * FRAME).abs() < 2.0 * FRAME);
        assert!((ns[1].end - ns[1].start - 50.0 * FRAME).abs() < 3.0 * FRAME);
    }

    #[test]
    fn a_blip_does_not_split_a_note() {
        // A 2-frame wobble a semitone up inside a held note stays one note.
        let c = contour(&[(62.0, 30), (63.0, 2), (62.0, 30)]);
        assert_eq!(notes(&c, NOTE_HOLD_MS).len(), 1);
    }

    #[test]
    fn finds_the_note_at_a_time() {
        let ns = [Note { start: 1.0, end: 2.0, midi: 60.0 }, Note { start: 3.0, end: 4.0, midi: 62.0 }];
        assert_eq!(note_at(&ns, 1.5, 0.0).map(|n| n.midi), Some(60.0));
        assert_eq!(note_at(&ns, 2.5, 0.0), None);
        assert_eq!(note_at(&ns, 2.9, 0.15).map(|n| n.midi), Some(62.0));
    }
}
