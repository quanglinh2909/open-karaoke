//! Transcribes a separated vocal with Whisper and prints each phrase:
//! `cargo run --release --example transcribe_check -- ggml-model.bin vocals.wav [prompt.txt|-] [lang|auto]`
//! The result is also written to `vocals.wav.heard.json` for merge tests.
use open_karaoke_lib::audio::analysis::mono;
use open_karaoke_lib::audio::decode::{decode_file, StreamResampler};
use open_karaoke_lib::audio::transcribe::{transcribe, SAMPLE_RATE};
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (model, wav) = match &args[..] {
        [m, w, ..] => (m, w),
        _ => {
            eprintln!("usage: transcribe_check ggml-model.bin vocals.wav [prompt.txt]");
            std::process::exit(2);
        }
    };
    let prompt = args.get(2).filter(|p| *p != "-").map(|p| std::fs::read_to_string(p).expect("prompt"));
    let lang = args.get(3).map(String::as_str).unwrap_or("vi");
    let lang = (lang != "auto").then_some(lang);
    let stereo = decode_file(Path::new(wav), 44_100).expect("decode");
    let mut rs = StreamResampler::new(44_100, SAMPLE_RATE).unwrap();
    let (mut a, mut b) = (Vec::new(), Vec::new());
    rs.push(&stereo, &mut a).unwrap();
    rs.flush(&mut b).unwrap();
    a.extend_from_slice(&b);
    let audio = mono(&a);

    let t0 = Instant::now();
    let lines = transcribe(Path::new(model), &audio, prompt.as_deref(), lang, |done, _| eprint!("\r{:3.0}%", done * 100.0), || false).expect("transcribe");
    eprintln!();
    println!("{:.1} s of audio in {:.1} s\n", audio.len() as f64 / SAMPLE_RATE as f64, t0.elapsed().as_secs_f64());
    for l in &lines {
        let text: Vec<String> = l.words.iter().map(|w| if w.p < 0.5 { format!("{}?", w.text) } else { w.text.clone() }).collect();
        println!("{:7.2}-{:7.2}  {}", l.start, l.end, text.join(" "));
    }
    std::fs::write(format!("{wav}.heard.json"), serde_json::to_string(&lines).unwrap()).ok();
}
