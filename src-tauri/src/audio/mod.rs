pub mod align;
pub mod analysis;
pub mod backing;
pub mod beats;
pub mod chain;
pub mod chords;
pub mod decode;
pub mod duet;
pub mod engine;
pub mod exclusive;
pub mod fx;
pub mod isolate;
pub mod karaoke;
pub mod melody;
pub mod params;
pub mod pitch;
pub mod psola;
pub mod scale;
pub mod separate;
pub mod stretch;
pub mod transcribe;

/// The process's one ONNX Runtime environment, shared by every model (the
/// separator, the aligner, the melody tracker). `ort` refuses to build a
/// second one for the life of the process, even after the first is dropped,
/// so each model creating its own failed for whichever loaded second.
#[cfg(has_ort)]
pub fn ort_env() -> Result<ort::environment::Environment, String> {
    static ENV: std::sync::Mutex<Option<ort::environment::Environment>> = std::sync::Mutex::new(None);
    let mut env = ENV.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = env.as_ref() {
        return Ok(e.clone());
    }
    let e = ort::init()
        .with_name("open-karaoke")
        .build()
        .map_err(|e| format!("Không khởi động được ONNX Runtime: {e}"))?;
    *env = Some(e.clone());
    Ok(e)
}

#[cfg(all(test, has_ort))]
mod tests {
    #[test]
    fn every_model_shares_one_ort_environment() {
        // The second and third models used to fail: "only one environment is allowed per process".
        for _ in 0..3 {
            super::ort_env().expect("environment");
        }
    }
}
