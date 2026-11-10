//! Lyrics-to-audio forced alignment with Meta's MMS-300M aligner (a
//! wav2vec2 CTC model) on ONNX Runtime.
//!
//! The lyrics are known; only their timing is not. The model listens to the
//! separated vocal and scores, every 20 ms, how likely each romanized letter
//! is being sung. A Viterbi pass then finds the single most likely path
//! through the lyric letters in order, which gives every word its start and
//! end. This fixes lyrics timed to a different upload, tempo or edit, not
//! just a constant offset.
//!
//! Model weights are CC-BY-NC-4.0 (non-commercial use only).

#[cfg(has_ort)]
use ort::session::builder::GraphOptimizationLevel;
#[cfg(has_ort)]
use ort::session::Session;
#[cfg(has_ort)]
use ort::value::Tensor;
use serde::Serialize;
use std::path::Path;

/// The model listens at 16 kHz mono.
pub const SAMPLE_RATE: u32 = 16_000;
/// Samples per emission frame (20 ms).
const STRIDE: usize = 320;
/// Audio per model call, plus context on both sides that is run but not
/// kept, so letters at a seam are judged with their surroundings.
const WINDOW: usize = 20 * SAMPLE_RATE as usize;
const CONTEXT: usize = SAMPLE_RATE as usize;
/// Viterbi back-pointers are one byte per (frame, state); cap the memory.
const MAX_CELLS: usize = 400_000_000;
const BLANK: usize = 0;
/// Longest a word's first letter may take (frames): 0.6 s.
const MAX_ONSET: usize = 30;
/// Longest a word's last letter may be held (frames): 4 s.
const MAX_HOLD: usize = 200;
/// How far (seconds) a line may be placed outside where Whisper heard it.
const WINDOW_SLACK: f64 = 3.0;
/// Longest a whole word may last (frames): 6 s.
const MAX_WORD: usize = 300;
/// How much worse than the best letter a "star" (singing that is not in
/// the lyrics: ad-libs, humming, a part the LRC lacks) scores per frame.
pub const STAR_PENALTY: f32 = 1.5;

pub struct ModelInfo {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

/// onnx-community's int8 export of MahmoudAshraf/mms-300m-1130-forced-aligner,
/// pinned to a revision so the checksum holds.
pub const MODEL: ModelInfo = ModelInfo {
    file: "mms-300m-fa-int8.onnx",
    url: "https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX/resolve/2100fb247d8e43962eef24491597fbeb8b469531/onnx/model_int8.onnx",
    sha256: "2eb5c3d2f6db2ef476aa7a7e1e5800145973e9064eb5292b1b9b8ada1207712a",
};

/// Vocabulary index of a romanized character (the model's vocab.json).
fn token(c: char) -> Option<usize> {
    Some(match c {
        'a' => 4,
        'i' => 5,
        'e' => 6,
        'n' => 7,
        'o' => 8,
        'u' => 9,
        't' => 10,
        's' => 11,
        'r' => 12,
        'm' => 13,
        'k' => 14,
        'l' => 15,
        'd' => 16,
        'g' => 17,
        'h' => 18,
        'y' => 19,
        'b' => 20,
        'p' => 21,
        'w' => 22,
        'c' => 23,
        'v' => 24,
        'j' => 25,
        'z' => 26,
        'f' => 27,
        '\'' => 28,
        'q' => 29,
        'x' => 30,
        _ => return None,
    })
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WordTime {
    /// Seconds.
    pub start: f64,
    pub end: f64,
    /// Mean log-probability of the word's letters; near 0 = clearly heard.
    pub score: f32,
}

/// Per-frame log-probabilities, `vocab` values per frame.
pub struct Emissions {
    pub data: Vec<f32>,
    pub vocab: usize,
}

impl Emissions {
    pub fn frames(&self) -> usize {
        self.data.len() / self.vocab.max(1)
    }

    /// Little-endian `u32` vocab size, then the `f32` values (a cache file).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + self.data.len() * 4);
        out.extend_from_slice(&(self.vocab as u32).to_le_bytes());
        self.data.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        let vocab = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        let body = &bytes[4..];
        if vocab == 0 || body.len() % 4 != 0 || (body.len() / 4) % vocab != 0 {
            return None;
        }
        let data = body.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        Some(Self { data, vocab })
    }

    fn at(&self, t: usize, k: usize) -> f32 {
        self.data[t * self.vocab + k]
    }
}

/// Align lyric `lines` of words (already romanized: lowercase a–z and
/// apostrophes) to the emissions. Words with no usable letters come back as
/// None, and so does everything if the audio is too short for the lyrics.
pub fn align_lines(em: &Emissions, lines: &[Vec<String>]) -> Result<Vec<Vec<Option<WordTime>>>, String> {
    align_lines_with(em, lines, STAR_PENALTY)
}

/// [`align_lines`] with a chosen star penalty (for tuning).
pub fn align_lines_with(em: &Emissions, lines: &[Vec<String>], star_penalty: f32) -> Result<Vec<Vec<Option<WordTime>>>, String> {
    align_lines_within(em, lines, &[], star_penalty)
}

/// [`align_lines`] keeping each line's letters within `WINDOW_SLACK` of
/// where speech recognition heard it (`windows[i]`, seconds; None or
/// missing = anywhere). Without this the aligner may hang a short line
/// ("Xa xôi") on an echo or backing vocal deep in the next interlude.
/// Falls back to unconstrained alignment if the windows can't all be met.
pub fn align_lines_within(
    em: &Emissions,
    lines: &[Vec<String>],
    windows: &[Option<(f64, f64)>],
    star_penalty: f32,
) -> Result<Vec<Vec<Option<WordTime>>>, String> {
    let frame = STRIDE as f64 / SAMPLE_RATE as f64;
    let frames_of = |w: Option<(f64, f64)>| match w {
        Some((a, b)) if b >= a => (((a - WINDOW_SLACK) / frame).max(0.0) as usize, ((b + WINDOW_SLACK) / frame).ceil() as usize),
        _ => (0, usize::MAX),
    };
    // A star before, between and after the lines; None marks one.
    let mut seq: Vec<Option<usize>> = vec![None];
    let mut allowed: Vec<(usize, usize)> = vec![(0, usize::MAX)];
    let mut ranges = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        let span = frames_of(windows.get(i).copied().flatten());
        let words: Vec<_> = line
            .iter()
            .map(|w| {
                let start = seq.len();
                seq.extend(w.chars().filter_map(token).map(Some));
                allowed.resize(seq.len(), span);
                start..seq.len()
            })
            .collect();
        ranges.push(words);
        if seq.last() != Some(&None) {
            seq.push(None);
            allowed.push((0, usize::MAX));
        }
    }
    let unplaced = || lines.iter().map(|l| vec![None; l.len()]).collect();
    if seq.iter().all(Option::is_none) {
        return Ok(unplaced());
    }
    let star: Vec<f32> = (0..em.frames())
        .map(|t| (0..em.vocab).map(|k| em.at(t, k)).fold(f32::NEG_INFINITY, f32::max) - star_penalty)
        .collect();
    let constrained = allowed.iter().any(|a| *a != (0, usize::MAX));
    let spans = match viterbi(em, &star, &seq, &allowed)? {
        Some(spans) => spans,
        None if constrained => match viterbi(em, &star, &seq, &[])? {
            Some(spans) => spans,
            None => return Ok(unplaced()),
        },
        None => return Ok(unplaced()),
    };
    Ok(ranges
        .into_iter()
        .map(|words| {
            words
                .into_iter()
                .map(|r| {
                    if r.is_empty() {
                        return None;
                    }
                    let (first, last) = (spans[r.start]?, spans[r.end - 1]?);
                    // A letter can soak up neighbouring non-singing (a break
                    // before a line, the outro after it). Onsets are short;
                    // only a held final vowel may last long.
                    let start = first.first.max(first.last.saturating_sub(MAX_ONSET));
                    let end = last.last.min(last.first + MAX_HOLD).min(start + MAX_WORD);
                    let (mut sum, mut n) = (0.0, 0);
                    for i in r.clone() {
                        let (sp, k) = (spans[i]?, seq[i]?);
                        for t in sp.first..=sp.last {
                            sum += em.at(t, k);
                            n += 1;
                        }
                    }
                    Some(WordTime {
                        start: start as f64 * frame,
                        end: (end + 1) as f64 * frame,
                        score: sum / n.max(1) as f32,
                    })
                })
                .collect()
        })
        .collect())
}

#[derive(Clone, Copy)]
struct Span {
    first: usize,
    last: usize,
}

/// The most likely CTC path through `seq`; each letter's first and last
/// frame (None for stars). States alternate blank, label, blank, …; a state
/// may repeat, step to the next, or skip a blank between two different
/// labels. Stars are optional: the path may step over one entirely. A star
/// scores `star[t]` (the best letter's score less a penalty), so it only
/// wins where the lyrics fit the audio much worse than "something is sung".
/// `allowed[i]`: the frames letter `i` may occupy (empty slice = any).
fn viterbi(em: &Emissions, star: &[f32], seq: &[Option<usize>], allowed: &[(usize, usize)]) -> Result<Option<Vec<Option<Span>>>, String> {
    let t_len = em.frames();
    let s_len = 2 * seq.len() + 1;
    let letters = seq.iter().flatten().count();
    let repeats = seq.windows(2).filter(|w| w[0].is_some() && w[0] == w[1]).count();
    if t_len < letters + repeats {
        return Ok(None);
    }
    if t_len.saturating_mul(s_len) > MAX_CELLS {
        return Err("Lời bài quá dài để canh".into());
    }
    let is_star = |s: usize| s % 2 == 1 && seq[s / 2].is_none();
    let score = |t: usize, s: usize| match (s % 2, seq.get(s / 2)) {
        (0, _) => em.at(t, BLANK),
        (_, Some(Some(k))) => match allowed.get(s / 2) {
            Some(&(a, b)) if t < a || t > b => f32::NEG_INFINITY,
            _ => em.at(t, *k),
        },
        _ => star[t],
    };

    let mut back = vec![0u8; t_len * s_len];
    let mut prev = vec![f32::NEG_INFINITY; s_len];
    let mut cur = vec![f32::NEG_INFINITY; s_len];
    for s in 0..if is_star(1) { 4 } else { 2 }.min(s_len) {
        prev[s] = score(0, s);
    }
    for t in 1..t_len {
        let row = &mut back[t * s_len..(t + 1) * s_len];
        for s in 0..s_len {
            let mut best = prev[s];
            let mut step = 0u8;
            let mut consider = |from: usize, st: u8| {
                if prev[from] > best {
                    best = prev[from];
                    step = st;
                }
            };
            if s >= 1 {
                consider(s - 1, 1);
            }
            if s % 2 == 1 {
                if s >= 2 && seq[s / 2] != seq[s / 2 - 1] {
                    consider(s - 2, 2);
                }
                // Step over the star before this letter.
                if !is_star(s) && s >= 4 && is_star(s - 2) && seq[s / 2] != seq[s / 2 - 2] {
                    consider(s - 4, 4);
                }
            } else if s >= 2 && is_star(s - 1) {
                consider(s - 2, 2);
            }
            cur[s] = best + score(t, s);
            row[s] = step;
        }
        std::mem::swap(&mut prev, &mut cur);
    }

    let ends: &[usize] = if is_star(s_len - 2) { &[s_len - 1, s_len - 2, s_len - 3, s_len - 4] } else { &[s_len - 1, s_len - 2] };
    let mut s = *ends.iter().max_by(|a, b| prev[**a].total_cmp(&prev[**b])).unwrap();
    if !prev[s].is_finite() {
        return Ok(None);
    }
    let mut spans: Vec<Option<Span>> = vec![None; seq.len()];
    for t in (0..t_len).rev() {
        if s % 2 == 1 && !is_star(s) {
            let span = spans[s / 2].get_or_insert(Span { first: t, last: t });
            span.first = t;
        }
        if t > 0 {
            s -= back[t * s_len + s] as usize;
        }
    }
    if seq.iter().zip(&spans).any(|(l, sp)| l.is_some() && sp.is_none()) {
        return Ok(None);
    }
    Ok(Some(spans))
}

#[cfg(has_ort)]
pub struct Aligner {
    session: Session,
    /// Must outlive the session.
    _env: ort::environment::Environment,
    needs_mask: bool,
}

#[cfg(has_ort)]
impl Aligner {
    pub fn load(model: &Path) -> Result<Self, String> {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let env = ort::init()
            .with_name("open-karaoke-align")
            .build()
            .map_err(|e| format!("Không khởi động được ONNX Runtime: {e}"))?;
        let fail = |e: &dyn std::fmt::Display| format!("Không tải được mô hình canh lời: {e}");
        let session = Session::builder(&env)
            .map_err(|e| fail(&e))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| fail(&e))?
            .with_intra_threads(threads)
            .map_err(|e| fail(&e))?
            .with_memory_pattern(false)
            .map_err(|e| fail(&e))?
            .commit_from_file(model)
            .map_err(|e| fail(&e))?;
        let needs_mask = session.inputs().iter().any(|i| i.name() == "attention_mask");
        Ok(Self { session, _env: env, needs_mask })
    }

    /// Log-probabilities for 16 kHz mono audio, one frame per 20 ms.
    /// Returns `Err("cancelled")` once `cancelled()` turns true.
    pub fn emissions(&mut self, audio: &[f32], mut progress: impl FnMut(f32), cancelled: impl Fn() -> bool) -> Result<Emissions, String> {
        let total = audio.len().div_ceil(STRIDE);
        let mut data = Vec::new();
        let mut vocab = 0;
        let mut core = 0;
        while core < audio.len() {
            if cancelled() {
                return Err("cancelled".into());
            }
            let core_end = (core + WINDOW).min(audio.len());
            let from = core.saturating_sub(CONTEXT);
            let to = (core_end + CONTEXT).min(audio.len());
            let (frames, v) = self.infer(&audio[from..to])?;
            vocab = v;
            // Keep the frames whose time falls inside this window's core.
            let skip = (core - from) / STRIDE;
            let keep = core_end.div_ceil(STRIDE) - core / STRIDE;
            let n = frames.len() / v;
            for f in skip..(skip + keep).min(n) {
                data.extend_from_slice(&frames[f * v..(f + 1) * v]);
            }
            core = core_end;
            progress((data.len() / v.max(1)) as f32 / total as f32);
        }
        Ok(Emissions { data, vocab })
    }

    fn infer(&mut self, chunk: &[f32]) -> Result<(Vec<f32>, usize), String> {
        // Wav2Vec2FeatureExtractor: zero mean, unit variance per input.
        let n = chunk.len().max(1) as f32;
        let mean = chunk.iter().sum::<f32>() / n;
        let var = chunk.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / n;
        let scale = 1.0 / (var + 1e-7).sqrt();
        let input: Vec<f32> = chunk.iter().map(|x| (x - mean) * scale).collect();
        let len = input.len();
        let wave = Tensor::from_array(([1usize, len], input)).map_err(|e| e.to_string())?;
        let fail = |e: ort::Error| format!("Canh lời thất bại: {e}");
        let outputs = if self.needs_mask {
            let mask = Tensor::from_array(([1usize, len], vec![1i64; len])).map_err(|e| e.to_string())?;
            self.session.run(ort::inputs!["input_values" => wave, "attention_mask" => mask]).map_err(fail)?
        } else {
            self.session.run(ort::inputs![wave]).map_err(fail)?
        };
        let (shape, logits) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let v = *shape.last().ok_or("Mô hình canh lời không trả về kết quả")? as usize;
        if v <= 30 {
            return Err("Mô hình canh lời trả về dữ liệu không đúng dạng".into());
        }
        // log-softmax per frame
        let mut out = logits.to_vec();
        for frame in out.chunks_exact_mut(v) {
            let max = frame.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
            let lse = max + frame.iter().map(|x| (x - max).exp()).sum::<f32>().ln();
            for x in frame.iter_mut() {
                *x -= lse;
            }
        }
        Ok((out, v))
    }
}

/// Stand-in for builds without ONNX Runtime (Intel Macs).
#[cfg(not(has_ort))]
pub struct Aligner;

#[cfg(not(has_ort))]
impl Aligner {
    pub fn load(_model: &Path) -> Result<Self, String> {
        Err(super::separate::UNAVAILABLE.into())
    }

    pub fn emissions(&mut self, _audio: &[f32], _progress: impl FnMut(f32), _cancelled: impl Fn() -> bool) -> Result<Emissions, String> {
        Err(super::separate::UNAVAILABLE.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic emissions where each frame strongly predicts one label.
    fn emissions(labels: &[usize]) -> Emissions {
        let vocab = 31;
        let mut data = vec![-10.0; labels.len() * vocab];
        for (t, &l) in labels.iter().enumerate() {
            data[t * vocab + l] = -0.01;
        }
        Emissions { data, vocab }
    }

    fn lines(l: &[&[&str]]) -> Vec<Vec<String>> {
        l.iter().map(|ws| ws.iter().map(|w| w.to_string()).collect()).collect()
    }

    #[test]
    fn emissions_round_trip_through_bytes() {
        let em = emissions(&[0, 4, 5]);
        let back = Emissions::from_bytes(&em.to_bytes()).unwrap();
        assert_eq!((back.vocab, back.data), (em.vocab, em.data));
        assert!(Emissions::from_bytes(&[1, 0, 0]).is_none());
    }

    #[test]
    fn finds_words_where_they_are_sung() {
        // "ab" at frames 2..4, "ba" at frames 7..9, blanks elsewhere.
        let a = token('a').unwrap();
        let b = token('b').unwrap();
        let em = emissions(&[0, 0, a, b, 0, 0, 0, b, a, 0]);
        let out = align_lines(&em, &lines(&[&["ab"], &["ba"]])).unwrap();
        let (w0, w1) = (out[0][0].unwrap(), out[1][0].unwrap());
        assert!((w0.start - 0.04).abs() < 1e-9 && (w0.end - 0.08).abs() < 1e-9);
        assert!((w1.start - 0.14).abs() < 1e-9 && (w1.end - 0.18).abs() < 1e-9);
    }

    #[test]
    fn heard_windows_keep_a_line_near_where_it_was_heard() {
        // "a" sung clearly at 0.2 s, and an echo at 8 s.
        let a = token('a').unwrap();
        let mut labels = vec![0; 600];
        labels[10] = a;
        labels[400] = a;
        let em = emissions(&labels);
        let l = lines(&[&["a"]]);
        let near = |w: &[Option<(f64, f64)>]| align_lines_within(&em, &l, w, STAR_PENALTY).unwrap()[0][0].unwrap().start;
        assert!(near(&[Some((7.9, 8.1))]) > 7.0);
        assert!(near(&[Some((0.1, 0.3))]) < 1.0);
        // A window past the end can't be met: aligned as if there were none.
        assert!(near(&[Some((100.0, 101.0))]).is_finite());
    }

    #[test]
    fn repeated_letters_need_a_blank_between() {
        let a = token('a').unwrap();
        let out = align_lines(&emissions(&[a, 0, a]), &lines(&[&["aa"]])).unwrap();
        assert!(out[0][0].is_some());
        let too_short = emissions(&[a, a]);
        assert!(align_lines(&too_short, &lines(&[&["aa"]])).unwrap()[0][0].is_none());
    }

    #[test]
    fn words_without_letters_are_skipped() {
        let a = token('a').unwrap();
        let out = align_lines(&emissions(&[a]), &lines(&[&["123", "a"], &["42"]])).unwrap();
        assert!(out[0][0].is_none() && out[0][1].is_some() && out[1][0].is_none());
    }

    #[test]
    fn singing_that_is_not_in_the_lyrics_is_skipped() {
        // An ad-lib "xyz" is sung before the line "ab"; without the star the
        // aligner would have to start "ab" on it.
        let (a, b) = (token('a').unwrap(), token('b').unwrap());
        let (x, y, z) = (token('x').unwrap(), token('y').unwrap(), token('z').unwrap());
        let em = emissions(&[x, x, y, y, z, z, 0, 0, a, b, 0]);
        let w = align_lines(&em, &lines(&[&["ab"]])).unwrap()[0][0].unwrap();
        assert!((w.start - 0.16).abs() < 1e-9, "start {}", w.start);
    }
}
