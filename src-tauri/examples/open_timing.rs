//! Times each step of opening a song whose stems are already separated:
//! `cargo run --example open_timing -- song.instrumental.wav song.vocals.wav`
use open_karaoke_lib::audio::analysis;
use open_karaoke_lib::audio::decode::decode_file;
use std::path::Path;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (inst, vox) = (Path::new(&args[0]), Path::new(&args[1]));
    let t = Instant::now();
    let a = decode_file(inst, 48_000).expect("decode");
    println!("decode instrumental: {:.2} s", t.elapsed().as_secs_f64());
    let t = Instant::now();
    let b = decode_file(vox, 48_000).expect("decode");
    println!("decode vocals:       {:.2} s", t.elapsed().as_secs_f64());
    let t = Instant::now();
    let full: Vec<f32> = a.iter().zip(&b).map(|(x, y)| x + y).collect();
    let m = analysis::mono(&full);
    println!("mix + mono:          {:.2} s", t.elapsed().as_secs_f64());
    let t = Instant::now();
    let key = analysis::detect_key(&m, 48_000);
    println!("detect key:          {:.2} s  ({key:?})", t.elapsed().as_secs_f64());
}
