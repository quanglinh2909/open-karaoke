//! Forced-aligns lyrics to a separated vocal and prints each line's LRC time
//! next to the aligned one:
//! `cargo run --release --example align_check -- model.onnx vocals.wav lyrics.tsv [star_penalty...]`
//! where each lyrics.tsv row is `lrc_seconds<TAB>romanized words<TAB>original text`.
//! Emissions are cached next to the wav (`.emissions`) so penalties can be
//! compared without re-running the model.
use open_karaoke_lib::audio::align::{align_lines_with, Aligner, Emissions, SAMPLE_RATE, STAR_PENALTY};
use open_karaoke_lib::audio::analysis::mono;
use open_karaoke_lib::audio::decode::{decode_file, StreamResampler};
use std::path::Path;
use std::time::Instant;

fn emissions(model: &str, wav: &str) -> Emissions {
    let cache = format!("{wav}.emissions");
    if let Some(em) = std::fs::read(&cache).ok().and_then(|b| Emissions::from_bytes(&b)) {
        return em;
    }
    let stereo = decode_file(Path::new(wav), 44_100).expect("decode");
    let mut rs = StreamResampler::new(44_100, SAMPLE_RATE).unwrap();
    let (mut a, mut b) = (Vec::new(), Vec::new());
    rs.push(&stereo, &mut a).unwrap();
    rs.flush(&mut b).unwrap();
    a.extend_from_slice(&b);
    let audio = mono(&a);
    let t0 = Instant::now();
    let mut aligner = Aligner::load(Path::new(model)).expect("load");
    let em = aligner.emissions(&audio, |_| {}, || false).expect("emissions");
    println!("emissions for {:.1} s of audio in {:.1} s", audio.len() as f64 / SAMPLE_RATE as f64, t0.elapsed().as_secs_f64());
    std::fs::write(&cache, em.to_bytes()).ok();
    em
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (model, wav, tsv) = match &args[..] {
        [m, w, t, ..] => (m, w, t),
        _ => {
            eprintln!("usage: align_check model.onnx vocals.wav lyrics.tsv [star_penalty...]");
            std::process::exit(2);
        }
    };
    // JSON mode: lyrics.json is [[romanized words of a line]…]; prints the
    // aligner's result as JSON (for the TypeScript pipeline tests).
    if tsv.ends_with(".json") {
        let lines: Vec<Vec<String>> = serde_json::from_str(&std::fs::read_to_string(tsv).expect("lyrics")).expect("json");
        let em = emissions(model, wav);
        let times = align_lines_with(&em, &lines, STAR_PENALTY).expect("align");
        println!("{}", serde_json::to_string(&times).unwrap());
        return;
    }
    let penalties: Vec<f32> = if args.len() > 3 { args[3..].iter().filter_map(|p| p.parse().ok()).collect() } else { vec![STAR_PENALTY] };

    let text = std::fs::read_to_string(tsv).expect("lyrics");
    let rows: Vec<(f64, Vec<String>, String)> = text
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\t');
            let t = p.next()?.parse().ok()?;
            let words = p.next()?.split(' ').map(|w| w.replace('_', "")).collect();
            Some((t, words, p.next().unwrap_or("").to_string()))
        })
        .collect();
    let lines: Vec<Vec<String>> = rows.iter().map(|r| r.1.clone()).collect();
    let em = emissions(model, wav);

    for penalty in penalties {
        println!("\n=== star penalty {penalty}");
        let times = align_lines_with(&em, &lines, penalty).expect("align");
        let mut scores = Vec::new();
        for ((lrc, ws, original), line) in rows.iter().zip(&times) {
            let placed: Vec<_> = line.iter().flatten().collect();
            let score = placed.iter().map(|t| t.score).sum::<f32>() / placed.len().max(1) as f32;
            scores.push(score);
            match (placed.first(), placed.last()) {
                (Some(f), Some(l)) => {
                    println!("lrc {lrc:7.2}  ai {:7.2}-{:7.2}  diff {:+6.2}  score {score:5.2}  {original}", f.start, l.end, f.start - lrc);
                    if l.end - f.start > 8.0 || std::env::var("ALL_WORDS").is_ok() {
                        for (word, t) in ws.iter().zip(line).filter_map(|(w, t)| Some((w, (*t)?))) {
                            println!("      {word:>8} {:7.2}-{:7.2} {:5.2}", t.start, t.end, t.score);
                        }
                    }
                }
                _ => println!("lrc {lrc:7.2}  ai    —     {original}"),
            }
        }
        println!("mean line score {:.2}", scores.iter().sum::<f32>() / scores.len().max(1) as f32);
    }
}
