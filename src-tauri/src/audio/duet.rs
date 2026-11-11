//! Splits a vocal into its male and female singers: aufr33's BS-Roformer
//! male/female model, exported to ONNX by `scripts/export_male_female.py`
//! (the network only: spectrogram in, two complex masks out). The STFT, the
//! masking and the inverse STFT happen here, as in the model's own forward
//! pass (checked to match it within 3e-7). Slow (about 15 s per 8 s on four
//! cores), so the app runs it only on the few seconds where a duet overlaps.

use super::separate::Stft;
use realfft::num_complex::Complex32;
use std::path::Path;

/// The converted model's file name in the models dir. Not downloaded: made
/// once with the export script.
pub const MODEL_FILE: &str = "bs_roformer_male_female.onnx";
/// The model's rate and fixed chunk: 8 s, 801 STFT frames.
pub const RATE: u32 = 44_100;
const CHUNK: usize = 352_800;
const N_FFT: usize = 2048;
const HOP: usize = 441;
const BINS: usize = N_FFT / 2 + 1;
const FRAMES: usize = CHUNK / HOP + 1;

/// The two singers of a stereo vocal at [`RATE`], interleaved stereo each.
pub struct Voices {
    pub male: Vec<f32>,
    pub female: Vec<f32>,
}

#[cfg(has_ort)]
pub struct VoiceSplitter {
    session: ort::session::Session,
    _env: ort::environment::Environment,
    stft: Stft,
}

#[cfg(has_ort)]
impl VoiceSplitter {
    pub fn load(model: &Path) -> Result<Self, String> {
        use ort::session::builder::GraphOptimizationLevel;
        let env = super::ort_env()?;
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let fail = |e: &dyn std::fmt::Display| format!("Không tải được mô hình tách giọng nam/nữ: {e}");
        let session = ort::session::Session::builder(&env)
            .map_err(|e| fail(&e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| fail(&e))?
            .with_intra_threads(threads)
            .map_err(|e| fail(&e))?
            .with_memory_pattern(false)
            .map_err(|e| fail(&e))?
            .commit_from_file(model)
            .map_err(|e| fail(&e))?;
        Ok(Self { session, _env: env, stft: Stft::new(N_FFT, HOP) })
    }

    /// Split interleaved stereo at [`RATE`] (any length; 8 s chunks).
    pub fn split(&mut self, stereo: &[f32]) -> Result<Voices, String> {
        let frames = stereo.len() / 2;
        let mut male = Vec::with_capacity(stereo.len());
        let mut female = Vec::with_capacity(stereo.len());
        let mut start = 0;
        while start < frames {
            let n = CHUNK.min(frames - start);
            let (m, f) = self.chunk(&stereo[2 * start..2 * (start + n)])?;
            male.extend_from_slice(&m[..2 * n]);
            female.extend_from_slice(&f[..2 * n]);
            start += n;
        }
        Ok(Voices { male, female })
    }

    /// One chunk (≤ 8 s, padded with silence): both voices, interleaved stereo, 8 s long.
    fn chunk(&mut self, stereo: &[f32]) -> Result<(Vec<f32>, Vec<f32>), String> {
        use ort::value::Tensor;
        let n = stereo.len() / 2;
        // Input [1, (f s) = 2050, t = 801, c = 2]: bins interleaved with channels.
        let mut input = vec![0f32; 2 * BINS * FRAMES * 2];
        let mut specs = [vec![Complex32::new(0.0, 0.0); BINS * FRAMES], vec![Complex32::new(0.0, 0.0); BINS * FRAMES]];
        for ch in 0..2 {
            let x: Vec<f32> = (0..CHUNK).map(|i| if i < n { stereo[2 * i + ch] } else { 0.0 }).collect();
            let spec = &mut specs[ch];
            self.stft.forward(&x, |t, s| {
                for f in 0..BINS {
                    spec[f * FRAMES + t] = s[f];
                    let row = ((f * 2 + ch) * FRAMES + t) * 2;
                    input[row] = s[f].re;
                    input[row + 1] = s[f].im;
                }
            });
        }
        let tensor = Tensor::from_array(([1usize, 2 * BINS, FRAMES, 2], input)).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs![tensor]).map_err(|e| format!("Tách giọng nam/nữ thất bại: {e}"))?;
        let (_, mask) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if mask.len() < 2 * 2 * BINS * FRAMES * 2 {
            return Err("Mô hình tách giọng nam/nữ trả về dữ liệu không đúng dạng".into());
        }
        let stem_len = 2 * BINS * FRAMES * 2;
        let mut stems: Vec<Vec<f32>> = Vec::with_capacity(2);
        for stem in 0..2 {
            let mut chans: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
            for (ch, out) in chans.iter_mut().enumerate() {
                let spec = &specs[ch];
                *out = self.stft.inverse(FRAMES, CHUNK, |t, s| {
                    for (f, v) in s.iter_mut().enumerate().take(BINS) {
                        let at = stem * stem_len + ((f * 2 + ch) * FRAMES + t) * 2;
                        let m = Complex32::new(mask[at], mask[at + 1]);
                        // The model zeroes the DC bin after masking.
                        *v = if f == 0 { Complex32::new(0.0, 0.0) } else { spec[f * FRAMES + t] * m };
                    }
                });
            }
            stems.push(chans[0].iter().zip(&chans[1]).flat_map(|(l, r)| [*l, *r]).collect());
        }
        let female = stems.pop().unwrap();
        let male = stems.pop().unwrap();
        Ok((male, female))
    }
}

/// Stand-in for builds without ONNX Runtime.
#[cfg(not(has_ort))]
pub struct VoiceSplitter;

#[cfg(not(has_ort))]
impl VoiceSplitter {
    pub fn load(_model: &Path) -> Result<Self, String> {
        Err("Bản dựng này không có ONNX Runtime".into())
    }
    pub fn split(&mut self, _stereo: &[f32]) -> Result<Voices, String> {
        Err("Bản dựng này không có ONNX Runtime".into())
    }
}
