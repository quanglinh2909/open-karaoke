//! Lists ASIO drivers, opens the first (or the one named) and prints the
//! status and measured latency:
//! `cargo run --example asio_check -- ["ASIO Link Pro"]`
use open_karaoke_lib::audio::engine::{list_devices, DeviceChoice, Engine};
use std::time::Duration;

fn main() {
    let devices = list_devices();
    println!("ASIO drivers: {:?}", devices.asio);
    let Some(driver) = std::env::args().nth(1).or_else(|| devices.asio.first().cloned()) else {
        println!("no ASIO driver installed");
        return;
    };
    let engine = Engine::new();
    let r = engine.open(DeviceChoice { asio: Some(driver.clone()), ..Default::default() });
    println!("--- {driver}: {r:?}");
    std::thread::sleep(Duration::from_millis(2000));
    println!("    latency {:?}", engine.latency());
    let error = engine.shared.stream_error.lock().unwrap().take();
    if let Some(e) = error {
        println!("    stream error: {e}");
    }
}
