//! Splits a separated vocal into lead and backing with the karaoke model:
//! `cargo run --release --example karaoke_check -- model.onnx vocals.wav out_dir [from_s to_s] [threads]`
//! Writes out_dir/lead.wav and out_dir/backing.wav.
use open_karaoke_lib::audio::{decode, karaoke};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let (model, vocals, out) = (&a[0], &a[1], std::path::Path::new(&a[2]));
    let from: f32 = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let to: f32 = a.get(4).and_then(|s| s.parse().ok()).unwrap_or(f32::MAX);
    let threads: usize = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(6);
    let sr = karaoke::RATE;
    let all = decode::decode_file(std::path::Path::new(vocals), sr).expect("vocals");
    let (s, e) = (((from * sr as f32) as usize * 2).min(all.len()), ((to.min(1e6) * sr as f32) as usize * 2).min(all.len()));
    let part = &all[s..e];
    let t0 = Instant::now();
    let mut split = karaoke::LeadSplitter::load(std::path::Path::new(model), threads).expect("model");
    eprintln!("loaded in {:.1}s", t0.elapsed().as_secs_f32());
    let t1 = Instant::now();
    let parts = split.split(part, |p| {
        eprint!("\r{:.0}%", p * 100.0);
        true
    }).expect("split");
    let secs = part.len() as f32 / 2.0 / sr as f32;
    eprintln!("\r{secs:.0} s of vocal split in {:.1}s", t1.elapsed().as_secs_f32());
    std::fs::create_dir_all(out).unwrap();
    decode::write_wav(&out.join("lead.wav"), &parts.lead, sr).unwrap();
    decode::write_wav(&out.join("backing.wav"), &parts.backing, sr).unwrap();
    let rms = |v: &[f32]| (v.iter().map(|x| x * x).sum::<f32>() / v.len().max(1) as f32).sqrt();
    eprintln!("RMS vocal {:.4}, lead {:.4}, backing {:.4}", rms(part), rms(&parts.lead), rms(&parts.backing));
}
