//! Splits a separated vocal into the lead singer and the backing vocals
//! (the record's own harmonies): aufr33 & viperx's Mel-Band Roformer
//! karaoke model, exported to ONNX by `scripts/export_karaoke.sh` (the
//! network only: spectrogram in, the lead's complex mask out, averaged over
//! the mel bands). The STFT, the masking and the inverse STFT happen here,
//! as for the male/female model (`duet.rs`). The backing is the vocal minus
//! the lead. The model takes 8 s at a time; chunks overlap by a second and
//! are crossfaded, so their joins don't click.

use super::separate::Stft;
use realfft::num_complex::Complex32;
use std::path::Path;

/// The converted model's file name in the models dir. Not downloaded: made
/// once with the export script.
pub const MODEL_FILE: &str = "mel_roformer_karaoke.onnx";
/// The model's rate. Its chunk is fixed when exported (4 s, 401 STFT
/// frames, by default: 8 s takes over 6 GB) and read from the file.
pub const RATE: u32 = 44_100;
/// Overlap between consecutive chunks (0.75 s), crossfaded.
const OVERLAP: usize = 33_075;
const N_FFT: usize = 2048;
const HOP: usize = 441;
const BINS: usize = N_FFT / 2 + 1;

/// A vocal's lead singer and backing vocals, interleaved stereo at [`RATE`].
pub struct Parts {
    pub lead: Vec<f32>,
    pub backing: Vec<f32>,
}

#[cfg(has_ort)]
pub struct LeadSplitter {
    session: ort::session::Session,
    _env: ort::environment::Environment,
    stft: Stft,
    /// STFT frames per chunk (the model's input), and samples.
    frames: usize,
    chunk: usize,
}

#[cfg(has_ort)]
impl LeadSplitter {
    /// `threads`: cores for the model (it takes several GB and all it is given).
    pub fn load(model: &Path, threads: usize) -> Result<Self, String> {
        use ort::session::builder::GraphOptimizationLevel;
        let env = super::ort_env()?;
        let fail = |e: &dyn std::fmt::Display| format!("Không tải được mô hình tách bè: {e}");
        let session = ort::session::Session::builder(&env)
            .map_err(|e| fail(&e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| fail(&e))?
            .with_intra_threads(threads.max(1))
            .map_err(|e| fail(&e))?
            .with_memory_pattern(false)
            .map_err(|e| fail(&e))?
            .commit_from_file(model)
            .map_err(|e| fail(&e))?;
        // Input [1, 2050, frames, 2].
        let frames = match session.inputs().first().map(|i| i.dtype()) {
            Some(ort::value::ValueType::Tensor { shape, .. }) if shape.len() == 4 && shape[2] > 1 => shape[2] as usize,
            _ => return Err("Mô hình tách bè không đúng dạng".into()),
        };
        Ok(Self { session, _env: env, stft: Stft::new(N_FFT, HOP), frames, chunk: (frames - 1) * HOP })
    }

    /// Split interleaved stereo at [`RATE`]. `progress` gets the share done;
    /// returning false from it stops (an error).
    pub fn split(&mut self, stereo: &[f32], mut progress: impl FnMut(f32) -> bool) -> Result<Parts, String> {
        let frames = stereo.len() / 2;
        let mut lead = vec![0f32; frames * 2];
        let chunk = self.chunk;
        let step = chunk - OVERLAP;
        let mut start = 0;
        loop {
            if !progress(start as f32 / frames.max(1) as f32) {
                return Err("cancelled".into());
            }
            let n = chunk.min(frames - start);
            let out = self.chunk(&stereo[2 * start..2 * (start + n)])?;
            for i in 0..n {
                // Fade in over the overlap (except the first chunk), out over
                // the next one's (except the last): the two always sum to 1.
                let fade_in = if start > 0 && i < OVERLAP { i as f32 / OVERLAP as f32 } else { 1.0 };
                let fade_out = if start + n < frames && i >= n.saturating_sub(OVERLAP) { (n - i) as f32 / OVERLAP as f32 } else { 1.0 };
                let w = fade_in.min(fade_out);
                lead[2 * (start + i)] += out[2 * i] * w;
                lead[2 * (start + i) + 1] += out[2 * i + 1] * w;
            }
            if start + n >= frames {
                break;
            }
            start += step;
        }
        progress(1.0);
        let backing = stereo.iter().zip(&lead).map(|(v, l)| v - l).collect();
        Ok(Parts { lead, backing })
    }

    /// One chunk (≤ the model's, padded with silence): the lead, interleaved stereo, a whole chunk long.
    fn chunk(&mut self, stereo: &[f32]) -> Result<Vec<f32>, String> {
        use ort::value::Tensor;
        let (len, frames) = (self.chunk, self.frames);
        let n = stereo.len() / 2;
        // Input [1, (f s) = 2050, t = 801, c = 2]: bins interleaved with channels.
        let mut input = vec![0f32; 2 * BINS * frames * 2];
        let mut specs = [vec![Complex32::new(0.0, 0.0); BINS * frames], vec![Complex32::new(0.0, 0.0); BINS * frames]];
        for ch in 0..2 {
            let x: Vec<f32> = (0..len).map(|i| if i < n { stereo[2 * i + ch] } else { 0.0 }).collect();
            let spec = &mut specs[ch];
            self.stft.forward(&x, |t, s| {
                for f in 0..BINS {
                    spec[f * frames + t] = s[f];
                    let row = ((f * 2 + ch) * frames + t) * 2;
                    input[row] = s[f].re;
                    input[row + 1] = s[f].im;
                }
            });
        }
        let tensor = Tensor::from_array(([1usize, 2 * BINS, frames, 2], input)).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs![tensor]).map_err(|e| format!("Tách bè thất bại: {e}"))?;
        let (_, mask) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if mask.len() < 2 * BINS * frames * 2 {
            return Err("Mô hình tách bè trả về dữ liệu không đúng dạng".into());
        }
        let mut chans: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
        for (ch, out) in chans.iter_mut().enumerate() {
            let spec = &specs[ch];
            *out = self.stft.inverse(frames, len, |t, s| {
                for (f, v) in s.iter_mut().enumerate().take(BINS) {
                    let at = ((f * 2 + ch) * frames + t) * 2;
                    let m = Complex32::new(mask[at], mask[at + 1]);
                    // The model zeroes the DC bin after masking.
                    *v = if f == 0 { Complex32::new(0.0, 0.0) } else { spec[f * frames + t] * m };
                }
            });
        }
        Ok(chans[0].iter().zip(&chans[1]).flat_map(|(l, r)| [*l, *r]).collect())
    }
}

/// Stand-in for builds without ONNX Runtime.
#[cfg(not(has_ort))]
pub struct LeadSplitter;

#[cfg(not(has_ort))]
impl LeadSplitter {
    pub fn load(_model: &Path, _threads: usize) -> Result<Self, String> {
        Err("Bản dựng này không có ONNX Runtime".into())
    }
    pub fn split(&mut self, _stereo: &[f32], _progress: impl FnMut(f32) -> bool) -> Result<Parts, String> {
        Err("Bản dựng này không có ONNX Runtime".into())
    }
}
