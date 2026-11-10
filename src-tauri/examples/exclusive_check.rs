//! Opens the default devices in shared mode, then exclusive mode, then shared
//! again, printing the status and latency of each, as the Settings toggle does:
//! `cargo run --example exclusive_check`
use open_karaoke_lib::audio::engine::{DeviceChoice, Engine};
use std::time::Duration;

fn main() {
    let engine = Engine::new();
    for (step, exclusive) in [("shared", false), ("exclusive", true), ("shared again", false), ("exclusive again", true)] {
        let r = engine.open(DeviceChoice { input: None, output: None, buffer: Some(256), exclusive, asio: None });
        println!("--- {step}: {r:?}");
        std::thread::sleep(Duration::from_millis(1500));
        println!("    latency {:?}", engine.latency());
        if let Some(e) = engine.shared.stream_error.lock().unwrap().take() {
            println!("    stream error: {e}");
        }
    }
}
