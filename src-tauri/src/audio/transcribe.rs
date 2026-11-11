//! Speech recognition of the separated vocal with Whisper (whisper.cpp), so
//! the lyrics can follow what this singer actually sings: covers and
//! re-recordings change words, and published lyrics often list parts a
//! given recording leaves out.
//!
//! Whisper's word times are rough; they only place the words. Exact timing
//! comes afterwards from forced alignment (`align.rs`).

use serde::{Deserialize, Serialize};
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct ModelInfo {
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

/// Whisper large-v2 fine-tuned on ~550 h of Vietnamese songs (Apache-2.0,
/// kelvinbksoh/whisper-large-v2-vietnamese-lyrics-transcription, arXiv
/// 2510.22295: WER 24.6 on sung Vietnamese vs 38.3 for PhoWhisper-large).
/// There is no published ggml build: `scripts/convert_whisper_hf.py` makes
/// this file, and Vietnamese songs use it when it is in the models dir.
pub const MODEL_VI_LYRICS: &str = "ggml-vi-lyrics-large-v2-q5_0.bin";

/// Whisper large-v3-turbo, 5-bit quantized (MIT), pinned to a revision.
/// Used for songs in other languages, and for Vietnamese without `MODEL_VI_LYRICS`.
pub const MODEL: ModelInfo = ModelInfo {
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
};

/// Whisper listens at 16 kHz mono.
pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeardWord {
    pub text: String,
    /// Seconds (rough).
    pub start: f64,
    pub end: f64,
    /// Whisper's confidence in the word (lowest of its tokens), 0–1.
    pub p: f32,
}

/// One phrase as Whisper segmented it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HeardLine {
    pub start: f64,
    pub end: f64,
    pub words: Vec<HeardWord>,
}

/// Phrases Whisper invents over music or silence (it was trained on a lot
/// of subtitled videos); a segment containing one is dropped.
const HALLUCINATIONS: &[&str] = &[
    "subscribe",
    "đăng ký kênh",
    "đăng kí kênh",
    "theo dõi",
    "cảm ơn các bạn",
    "hẹn gặp lại",
    "ghiền mì gõ",
    "không bỏ lỡ",
    "la la school",
    "vietsub",
    "lyrics",
    "phụ đề",
    "♪",
];

/// Transcribe 16 kHz mono Vietnamese singing. `prompt` (the published
/// lyrics, if any) primes Whisper with the song's vocabulary; it still
/// writes what it hears. `progress(done, next)` is called as each chunk
/// starts (the share of the song done, and where this chunk ends) and once
/// at the end; Whisper itself says nothing in between, so callers estimate.
/// `cancelled` is checked between chunks (it may also block there, to
/// pause); once it returns true this ends with `Err("cancelled")`.
pub fn transcribe(
    model: &Path,
    audio: &[f32],
    prompt: Option<&str>,
    language: Option<&str>,
    mut progress: impl FnMut(f32, f32),
    cancelled: impl Fn() -> bool,
) -> Result<Vec<HeardLine>, String> {
    let fail = |e: whisper_rs::WhisperError| format!("Nhận dạng giọng hát thất bại: {e}");
    let ctx = WhisperContext::new_with_params(model, WhisperContextParameters::default())
        .map_err(|e| format!("Không tải được mô hình nhận dạng giọng hát: {e}"))?;
    let mut state = ctx.create_state().map_err(fail)?;
    let eot = ctx.token_eot();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as i32;

    // Whisper invents text over silence and long instrumental gaps, so it
    // only hears the sung phrases, one chunk at a time.
    let chunks = sung_chunks(audio);
    let total: usize = chunks.iter().map(|c| c.len()).sum::<usize>().max(1);
    let mut done = 0;
    let mut lines: Vec<HeardLine> = Vec::new();
    // One Whisper pass over `range`: the phrases heard, and whether it
    // invented something there (a subtitle credit over the singing).
    let mut hear = |range: std::ops::Range<usize>, prompt: Option<&str>| -> Result<(Vec<HeardLine>, bool), String> {
        let offset = range.start as f64 / SAMPLE_RATE as f64;
        // Greedy: with the lyrics as prompt it hears as well as beam search, several times faster.
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 2 });
        params.set_n_threads(threads);
        // None: Whisper detects the language of each chunk.
        params.set_language(Some(language.unwrap_or("auto")));
        params.set_token_timestamps(true);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        if let Some(p) = prompt.filter(|p| !p.is_empty()) {
            params.set_initial_prompt(p);
        }
        // (whisper-rs 0.16's `set_abort_callback_safe` casts its user data to
        // the wrong type and crashes, so cancelling is only checked between
        // chunks.)
        state.full(params, &audio[range.clone()]).map_err(fail)?;
        let (mut got, mut invented) = (Vec::new(), false);
        for i in 0..state.full_n_segments() {
            let Some(seg) = state.get_segment(i) else { continue };
            match heard_line(&seg, eot, offset) {
                Heard::Line(line) => got.push(line),
                Heard::Invented => invented = true,
                Heard::Nothing => {}
            }
        }
        if std::env::var_os("OK_DEBUG_WHISPER").is_some() {
            eprintln!("[whisper] {:.2}-{:.2}: {} lines{}", offset, range.end as f64 / SAMPLE_RATE as f64, got.len(), if invented { ", invented" } else { "" });
        }
        Ok((got, invented))
    };
    let sec = SAMPLE_RATE as usize;
    for chunk in chunks {
        if cancelled() {
            return Err("cancelled".into());
        }
        progress(done as f32 / total as f32, (done + chunk.len()) as f32 / total as f32);
        let (mut got, invented) = hear(chunk.clone(), prompt)?;
        // Singing came back empty or as an invention: Whisper is touchy
        // about where a window starts and what it was primed with, so hear
        // it again differently, then in halves; keep what lands in the chunk.
        if invented || (got.is_empty() && chunk.len() >= 2 * sec) {
            // What was heard just before (often the same verse, sung earlier).
            let recent: Vec<String> = lines.iter().rev().take(12).rev().map(|l| l.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")).collect();
            let context = match prompt {
                Some(p) => format!("{p}. {}", recent.join(". ")),
                None => recent.join(". "),
            };
            let wider = chunk.start.saturating_sub(2 * sec)..(chunk.end + 2 * sec).min(audio.len());
            let mid = chunk.start + chunk.len() / 2;
            let mut retried = None;
            for (range, p) in [(chunk.clone(), Some(context.as_str())), (wider, prompt)] {
                if cancelled() {
                    return Err("cancelled".into());
                }
                let (g, bad) = hear(range, p)?;
                if !bad && !g.is_empty() {
                    retried = Some(g);
                    break;
                }
            }
            let retried = match retried {
                Some(g) => g,
                None => {
                    let mut halves = Vec::new();
                    for half in [chunk.start..mid, mid..chunk.end] {
                        if cancelled() {
                            return Err("cancelled".into());
                        }
                        let (g, bad) = hear(half, Some(context.as_str()))?;
                        if !bad {
                            halves.extend(g);
                        }
                    }
                    halves
                }
            };
            let (from, to) = (chunk.start as f64 / sec as f64 - 0.5, chunk.end as f64 / sec as f64);
            let inside: Vec<HeardLine> = retried.into_iter().filter(|l| l.start >= from && l.start < to).collect();
            if !inside.is_empty() {
                got = inside;
            }
        }
        lines.extend(got);
        done += chunk.len();
    }
    progress(1.0, 1.0);
    Ok(lines)
}

/// What a Whisper segment turned out to be.
enum Heard {
    Line(HeardLine),
    /// A phrase Whisper invents over music (see `HALLUCINATIONS`).
    Invented,
    /// Nothing usable: no speech, or no words.
    Nothing,
}

/// One Whisper segment as words, unless it is likely invented or empty.
fn heard_line(seg: &whisper_rs::WhisperSegment, eot: i32, offset: f64) -> Heard {
    if seg.no_speech_probability() > 0.6 {
        return Heard::Nothing;
    }
    let text = seg.to_str_lossy().map(|s| s.to_lowercase()).unwrap_or_default();
    if HALLUCINATIONS.iter().any(|h| text.contains(h)) {
        return Heard::Invented;
    }
    // Tokens are byte pieces of BPE; a leading space starts a word, and
    // Vietnamese letters can be split across tokens, so join bytes.
    let mut words: Vec<HeardWord> = Vec::new();
    let mut bytes: Vec<u8> = Vec::new();
    let mut cur: Option<HeardWord> = None;
    let flush = |cur: &mut Option<HeardWord>, bytes: &mut Vec<u8>, words: &mut Vec<HeardWord>| {
        if let Some(mut w) = cur.take() {
            w.text = clean_word(&String::from_utf8_lossy(bytes));
            if !w.text.is_empty() {
                words.push(w);
            }
        }
        bytes.clear();
    };
    for k in 0..seg.n_tokens() {
        let Some(tok) = seg.get_token(k) else { continue };
        if tok.token_id() >= eot {
            continue;
        }
        let data = tok.token_data();
        let piece = tok.to_bytes().unwrap_or_default();
        let (t0, t1) = (offset + data.t0 as f64 / 100.0, offset + data.t1 as f64 / 100.0);
        if piece.first() == Some(&b' ') || cur.is_none() {
            flush(&mut cur, &mut bytes, &mut words);
            cur = Some(HeardWord { text: String::new(), start: t0, end: t1, p: data.p });
        }
        if let Some(w) = cur.as_mut() {
            w.end = t1;
            w.p = w.p.min(data.p);
        }
        bytes.extend_from_slice(piece);
    }
    flush(&mut cur, &mut bytes, &mut words);
    drop_piled(&mut words);
    if words.is_empty() {
        return Heard::Nothing;
    }
    Heard::Line(HeardLine {
        start: offset + seg.start_timestamp() as f64 / 100.0,
        end: offset + seg.end_timestamp() as f64 / 100.0,
        words,
    })
}

/// Longest chunk handed to Whisper (its window is 30 s).
const MAX_CHUNK: f64 = 25.0;
/// Phrases closer than this (in 20 ms frames: 3 s) go into the same chunk.
const MAX_JOIN: usize = 150;

/// Sample ranges where someone sings: 20 ms frames well above the vocal's
/// noise floor, joined across breaths and short pauses, padded, and split
/// at the quietest frame when longer than `MAX_CHUNK`. Long silences, where
/// Whisper would invent text, are left out.
fn sung_chunks(audio: &[f32]) -> Vec<std::ops::Range<usize>> {
    const FRAME: usize = SAMPLE_RATE as usize / 50;
    let rms: Vec<f32> = audio.chunks(FRAME).map(|c| (c.iter().map(|x| x * x).sum::<f32>() / c.len() as f32).sqrt()).collect();
    if rms.is_empty() {
        return Vec::new();
    }
    let mut sorted = rms.clone();
    sorted.sort_by(f32::total_cmp);
    let threshold = sorted[sorted.len() * 95 / 100] * 0.1;
    let voiced: Vec<bool> = rms.iter().map(|&r| r > threshold).collect();

    // Regions of voiced frames, bridging gaps shorter than 0.6 s.
    let mut regions: Vec<(usize, usize)> = Vec::new();
    for (i, &v) in voiced.iter().enumerate() {
        if !v {
            continue;
        }
        match regions.last_mut() {
            Some((_, end)) if i - *end <= 30 => *end = i + 1,
            _ => regions.push((i, i + 1)),
        }
    }
    let max = (MAX_CHUNK * 50.0) as usize;
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (mut s, e) in regions {
        // Ignore clicks and breaths.
        if e - s < 10 {
            continue;
        }
        // Each Whisper call costs a full 30 s window, so phrases share a
        // chunk unless a long break (an instrumental) separates them.
        if let Some(last) = out.last_mut() {
            if s - last.1 < MAX_JOIN && e - last.0 <= max {
                last.1 = e;
                continue;
            }
        }
        while e - s > max {
            // Split at the quietest frame in the last third of the window.
            let from = s + max * 2 / 3;
            let cut = (from..s + max).min_by(|a, b| rms[*a].total_cmp(&rms[*b])).unwrap_or(s + max);
            out.push((s, cut));
            s = cut;
        }
        out.push((s, e));
    }
    out.into_iter()
        .map(|(s, e)| (s.saturating_sub(15) * FRAME)..((e + 15) * FRAME).min(audio.len()))
        .collect()
}

/// Words Whisper writes without hearing them, typically the prompt's
/// lyrics continued past the end of the chunk, all get the same timestamp.
/// A run of three or more such words is dropped.
fn drop_piled(words: &mut Vec<HeardWord>) {
    let mut keep = vec![true; words.len()];
    let mut i = 0;
    while i < words.len() {
        let mut j = i + 1;
        while j < words.len() && (words[j].start - words[i].start).abs() < 0.02 {
            j += 1;
        }
        if j - i >= 3 {
            keep[i..j].iter_mut().for_each(|k| *k = false);
        }
        i = j;
    }
    let mut k = keep.iter();
    words.retain(|_| *k.next().unwrap());
}

/// Strip spaces and punctuation around a word ("nhau," → "nhau").
fn clean_word(s: &str) -> String {
    s.trim().trim_matches(|c: char| !c.is_alphanumeric() && c != '\'').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_sung_phrases_and_skips_silence() {
        let sr = SAMPLE_RATE as usize;
        let mut audio = vec![0.0f32; sr * 10];
        // Sung 1–3 s and 6.5–8.5 s, with a break too long to join.
        for i in (sr..3 * sr).chain(13 * sr / 2..17 * sr / 2) {
            audio[i] = (i as f32 * 0.05).sin() * 0.5;
        }
        let chunks = sung_chunks(&audio);
        assert_eq!(chunks.len(), 2, "{chunks:?}");
        assert!(chunks[0].start <= sr && chunks[0].end >= 3 * sr && chunks[0].end < 4 * sr);
        assert!(chunks[1].start <= 13 * sr / 2 && chunks[1].end >= 17 * sr / 2);
    }

    #[test]
    fn joins_phrases_separated_by_short_pauses() {
        let sr = SAMPLE_RATE as usize;
        let mut audio = vec![0.0f32; sr * 10];
        for i in (sr..3 * sr).chain(4 * sr..6 * sr) {
            audio[i] = (i as f32 * 0.05).sin() * 0.5;
        }
        assert_eq!(sung_chunks(&audio).len(), 1);
    }

    #[test]
    fn splits_long_phrases() {
        let sr = SAMPLE_RATE as usize;
        let audio: Vec<f32> = (0..sr * 60).map(|i| (i as f32 * 0.05).sin() * if (i / (sr / 2)) % 7 == 0 { 0.2 } else { 0.5 }).collect();
        let chunks = sung_chunks(&audio);
        assert!(chunks.len() >= 3);
        assert!(chunks.iter().all(|c| (c.end - c.start) as f64 / sr as f64 <= MAX_CHUNK + 1.0));
    }

    #[test]
    fn drops_words_piled_on_one_timestamp() {
        let w = |text: &str, start: f64| HeardWord { text: text.into(), start, end: start, p: 0.9 };
        let mut words = vec![w("buông", 226.5), w("tay", 227.1), w("Gặp", 227.7), w("được", 227.7), w("nhau", 227.7), w("khó", 227.7)];
        drop_piled(&mut words);
        assert_eq!(words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), ["buông", "tay"]);
    }

    #[test]
    fn cleans_punctuation() {
        assert_eq!(clean_word(" nhau,"), "nhau");
        assert_eq!(clean_word("\"Gặp"), "Gặp");
        assert_eq!(clean_word("..."), "");
    }
}
