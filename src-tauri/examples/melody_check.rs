//! Finds the melody of a separated vocal and prints its notes:
//! `cargo run --example melody_check -- swift-f0.onnx vocals.wav [from_s to_s]`
use open_karaoke_lib::audio::analysis::mono;
use open_karaoke_lib::audio::decode::decode_file;
use open_karaoke_lib::audio::melody::{notes, Tracker, NOTE_HOLD_MS, SAMPLE_RATE};
use std::path::Path;
use std::time::Instant;

const NAMES: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (model, wav) = (Path::new(&args[0]), Path::new(&args[1]));
    let from: f32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let to: f32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(f32::MAX);
    let audio = mono(&decode_file(wav, SAMPLE_RATE).expect("decode"));
    let t0 = Instant::now();
    let contour = Tracker::load(model).expect("load").contour(&audio).expect("contour");
    let t1 = t0.elapsed().as_secs_f64();
    let ns = notes(&contour, NOTE_HOLD_MS);
    println!(
        "{:.0} s of audio: pitch in {:.2} s, {} notes in {:.2} s",
        audio.len() as f64 / SAMPLE_RATE as f64,
        t1,
        ns.len(),
        t0.elapsed().as_secs_f64() - t1
    );
    for n in ns.iter().filter(|n| n.start >= from && n.start <= to) {
        let m = n.midi.round() as i32;
        println!("{:7.2}-{:7.2}  {:>3}{}  ({:+.0} cents)", n.start, n.end, NAMES[m.rem_euclid(12) as usize], m / 12 - 1, (n.midi - m as f32) * 100.0);
    }
}
