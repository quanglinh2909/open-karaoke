//! Real-time audio I/O.
//!
//! The microphone is processed inside the input callback and handed to the
//! output callback through a lock-free ring; the output callback mixes it
//! with the backing track. Nothing on either audio thread locks or allocates
//! in the steady state. cpal streams are not `Send` on every platform, so a
//! dedicated host thread owns them and rebuilds them on device changes.

use super::chain::{PitchFrame, VocalChain};
use super::fx::Limiter;
use super::params::{AtomicF32, Flags, Params};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use crossbeam_channel::{bounded, Receiver, Sender};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::thread;

/// Interleaved stereo samples: complete, or still being produced by the
/// vocal separator while playback has already started.
#[derive(Clone)]
pub enum Buf {
    Full(Arc<Vec<f32>>),
    Growing(Arc<super::separate::Growing>),
}

impl Buf {
    /// Samples that can be played right now.
    #[inline]
    pub fn ready(&self) -> &[f32] {
        match self {
            Buf::Full(v) => v,
            Buf::Growing(g) => g.ready_slice(),
        }
    }

    pub fn total_samples(&self) -> usize {
        match self {
            Buf::Full(v) => v.len(),
            Buf::Growing(g) => g.capacity(),
        }
    }
}

/// A backing track ready for playback at the engine sample rate.
pub struct Track {
    pub audio: Buf,
    /// Optional vocal guide (the isolated original singer).
    pub guide: Option<Buf>,
    /// `track_frame = guide_frame + guide_offset`.
    pub guide_offset: i64,
}

impl Track {
    pub fn frames(&self) -> u64 {
        (self.audio.total_samples() / 2) as u64
    }

    /// Frames playable now (less than `frames()` while still separating).
    pub fn ready_frames(&self) -> u64 {
        (self.audio.ready().len() / 2) as u64
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StampedFrame {
    pub frame: PitchFrame,
    /// Song position (frames) when the frame was analysed.
    pub pos: u64,
}

enum Cmd {
    SetTrack(Option<Arc<Track>>, u64),
    Seek(u64),
    Recorder(Option<HeapProd<f32>>),
}

/// Voice Lab commands for the input thread.
enum LabCmd {
    /// Start capturing the raw mic into this (pre-allocated) buffer.
    Record(Vec<f32>),
    /// Stop capturing and send the buffer back.
    StopRecord,
    /// Feed a recorded take through the vocal chain instead of the mic.
    Play(Arc<Vec<f32>>, bool),
    StopPlay,
}

pub const LAB_IDLE: u32 = 0;
pub const LAB_RECORDING: u32 = 1;
pub const LAB_PLAYING: u32 = 2;
/// Longest Voice Lab take, seconds.
pub const LAB_MAX_SECONDS: usize = 30;

pub struct Shared {
    pub params: Params,
    pub flags: Flags,
    pub position: AtomicU64,
    pub length: AtomicU64,
    pub sample_rate: AtomicU32,
    pub mic_peak: AtomicF32,
    pub out_peak: AtomicF32,
    pub out_latency: AtomicF32,
    pub in_latency: AtomicF32,
    pub chain_latency: AtomicU32,
    /// Smoothed measurements for the latency report (seconds): mic capture
    /// to input callback, output callback to playback, and how long the
    /// processed voice waits between the two streams.
    pub avg_in: AtomicF32,
    pub avg_out: AtomicF32,
    pub avg_queue: AtomicF32,
    /// Frames per callback and the input's own rate.
    pub in_block: AtomicU32,
    pub out_block: AtomicU32,
    pub in_rate: AtomicU32,
    pub ended: AtomicBool,
    /// Playback caught up with the vocal separator and is waiting for audio.
    pub buffering: AtomicBool,
    pub input_ok: AtomicBool,
    pub stream_error: Mutex<Option<String>>,
    pub lab_state: AtomicU32,
    pub lab_pos: AtomicU64,
    pub lab_len: AtomicU64,
    /// A/B: hear the take unprocessed.
    pub lab_bypass: AtomicBool,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
    /// ASIO drivers installed (Windows), e.g. "ASIO Link Pro", "ASIO4ALL v2".
    pub asio: Vec<String>,
}

#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub sample_rate: u32,
    pub output: String,
    pub input: Option<String>,
    pub input_error: Option<String>,
    pub buffer: Option<u32>,
    pub latency_ms: f32,
    /// Running in WASAPI exclusive mode (low latency).
    pub exclusive: bool,
    /// The ASIO driver in use, if any.
    pub asio: Option<String>,
    /// Why exclusive mode was asked for but not used.
    pub exclusive_note: Option<String>,
}

#[derive(Clone, Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LatencyReport {
    pub input_ms: f32,
    pub queue_ms: f32,
    pub chain_ms: f32,
    pub output_ms: f32,
    pub total_ms: f32,
    pub in_block_ms: f32,
    pub out_block_ms: f32,
    pub mic: bool,
}

#[derive(Clone, Default)]
pub struct DeviceChoice {
    pub input: Option<String>,
    pub output: Option<String>,
    pub buffer: Option<u32>,
    /// Ask for WASAPI exclusive mode (Windows).
    pub exclusive: bool,
    /// Use this ASIO driver for both the mic and the output (Windows).
    pub asio: Option<String>,
}

/// Whatever keeps the open streams alive; dropping it closes them.
type Streams = Vec<Box<dyn std::any::Any>>;

struct OpenReq {
    choice: DeviceChoice,
    reply: Sender<Result<AudioStatus, String>>,
}

pub struct Engine {
    pub shared: Arc<Shared>,
    cmd_tx: Sender<Cmd>,
    cmd_rx: Receiver<Cmd>,
    host_tx: Sender<OpenReq>,
    garbage_tx: Sender<Arc<Track>>,
    lab_tx: Sender<LabCmd>,
    lab_rx: Receiver<LabCmd>,
    take_tx: Sender<Vec<f32>>,
    take_rx: Receiver<Vec<f32>>,
    buf_garbage_tx: Sender<Arc<Vec<f32>>>,
    take: Mutex<Option<Arc<Vec<f32>>>>,
    current: Mutex<Option<Arc<Track>>>,
    pub frames: Mutex<Option<HeapCons<StampedFrame>>>,
    recorder: Mutex<Option<(PathBuf, thread::JoinHandle<Result<(), String>>)>>,
    status: Mutex<AudioStatus>,
}

fn device_name(d: &cpal::Device) -> String {
    d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| "Thiết bị không rõ tên".into())
}

pub fn list_devices() -> DeviceList {
    let host = cpal::default_host();
    let names = |it: Result<_, _>| -> Vec<String> {
        match it {
            Ok(iter) => {
                let mut v: Vec<String> = Vec::new();
                for d in iter {
                    let n = device_name(&d);
                    if !v.contains(&n) {
                        v.push(n);
                    }
                }
                v
            }
            Err(_) => Vec::new(),
        }
    };
    DeviceList {
        inputs: names(host.input_devices().map(|i| i.collect::<Vec<_>>().into_iter())),
        outputs: names(host.output_devices().map(|i| i.collect::<Vec<_>>().into_iter())),
        default_input: host.default_input_device().map(|d| device_name(&d)),
        default_output: host.default_output_device().map(|d| device_name(&d)),
        asio: asio_drivers(),
    }
}

/// Installed ASIO drivers. Each is one device that both records and plays.
#[cfg(windows)]
fn asio_drivers() -> Vec<String> {
    let Ok(host) = cpal::host_from_id(cpal::HostId::Asio) else { return Vec::new() };
    let mut names: Vec<String> = host.devices().map(|it| it.map(|d| device_name(&d)).collect()).unwrap_or_default();
    names.dedup();
    names
}

#[cfg(not(windows))]
fn asio_drivers() -> Vec<String> {
    Vec::new()
}

/// The audio host to open: ASIO when a driver is chosen, else the system's.
fn pick_host(choice: &DeviceChoice) -> Result<cpal::Host, String> {
    #[cfg(windows)]
    if choice.asio.is_some() {
        return cpal::host_from_id(cpal::HostId::Asio).map_err(|e| format!("ASIO: {e}"));
    }
    if choice.asio.is_some() {
        return Err("ASIO chỉ có trên Windows".into());
    }
    Ok(cpal::default_host())
}

impl Engine {
    pub fn new() -> Arc<Self> {
        let shared = Arc::new(Shared {
            params: Params::default(),
            flags: Flags::default(),
            position: AtomicU64::new(0),
            length: AtomicU64::new(0),
            sample_rate: AtomicU32::new(48_000),
            mic_peak: AtomicF32::new(0.0),
            out_peak: AtomicF32::new(0.0),
            out_latency: AtomicF32::new(0.0),
            in_latency: AtomicF32::new(0.0),
            chain_latency: AtomicU32::new(0),
            avg_in: AtomicF32::new(0.0),
            avg_out: AtomicF32::new(0.0),
            avg_queue: AtomicF32::new(0.0),
            in_block: AtomicU32::new(0),
            out_block: AtomicU32::new(0),
            in_rate: AtomicU32::new(48_000),
            ended: AtomicBool::new(false),
            buffering: AtomicBool::new(false),
            input_ok: AtomicBool::new(false),
            stream_error: Mutex::new(None),
            lab_state: AtomicU32::new(LAB_IDLE),
            lab_pos: AtomicU64::new(0),
            lab_len: AtomicU64::new(0),
            lab_bypass: AtomicBool::new(false),
        });
        let (cmd_tx, cmd_rx) = bounded(64);
        let (garbage_tx, garbage_rx) = bounded::<Arc<Track>>(64);
        // Tracks are dropped here, never on the audio thread.
        thread::Builder::new()
            .name("audio-gc".into())
            .spawn(move || while garbage_rx.recv().is_ok() {})
            .ok();
        let (buf_garbage_tx, buf_garbage_rx) = bounded::<Arc<Vec<f32>>>(16);
        thread::Builder::new()
            .name("audio-gc-takes".into())
            .spawn(move || while buf_garbage_rx.recv().is_ok() {})
            .ok();
        let (lab_tx, lab_rx) = bounded(16);
        let (take_tx, take_rx) = bounded(2);

        let (host_tx, host_rx) = bounded::<OpenReq>(4);
        let engine = Arc::new(Self {
            shared,
            cmd_tx,
            cmd_rx,
            host_tx,
            garbage_tx,
            lab_tx,
            lab_rx,
            take_tx,
            take_rx,
            buf_garbage_tx,
            take: Mutex::new(None),
            current: Mutex::new(None),
            frames: Mutex::new(None),
            recorder: Mutex::new(None),
            status: Mutex::new(AudioStatus::default()),
        });

        let weak = Arc::downgrade(&engine);
        thread::Builder::new()
            .name("audio-host".into())
            .spawn(move || {
                let mut streams: Option<Streams> = None;
                while let Ok(req) = host_rx.recv() {
                    let Some(engine) = weak.upgrade() else { break };
                    streams = None;
                    // A device just released (e.g. leaving exclusive mode)
                    // can stay busy for a moment: retry before giving up.
                    let mut built = engine.build_streams(&req.choice);
                    for _ in 0..4 {
                        if built.is_ok() {
                            break;
                        }
                        thread::sleep(std::time::Duration::from_millis(300));
                        built = engine.build_streams(&req.choice);
                    }
                    let result = built.map(|(s, status)| {
                        streams = Some(s);
                        status
                    });
                    let _ = req.reply.send(result);
                }
                drop(streams);
            })
            .expect("spawn audio host thread");
        engine
    }

    pub fn status(&self) -> AudioStatus {
        self.status.lock().unwrap().clone()
    }

    /// (Re)open audio devices. Keeps the current track and position.
    pub fn open(&self, choice: DeviceChoice) -> Result<AudioStatus, String> {
        let (tx, rx) = bounded(1);
        self.host_tx.send(OpenReq { choice, reply: tx }).map_err(|e| e.to_string())?;
        let status = rx.recv().map_err(|e| e.to_string())??;
        *self.status.lock().unwrap() = status.clone();
        let pos = self.shared.position.load(Relaxed);
        let current = self.current.lock().unwrap().clone();
        let _ = self.cmd_tx.send(Cmd::SetTrack(current, pos));
        Ok(status)
    }

    pub fn sample_rate(&self) -> u32 {
        self.shared.sample_rate.load(Relaxed)
    }

    /// Where the delay between singing and hearing yourself comes from, as
    /// measured on the running streams (device-reported timestamps).
    pub fn latency(&self) -> LatencyReport {
        let s = &self.shared;
        let ms = |secs: f32| secs * 1000.0;
        let sr = s.sample_rate.load(Relaxed).max(1) as f32;
        let input = ms(s.avg_in.get());
        let output = ms(s.avg_out.get());
        let queue = ms(s.avg_queue.get());
        let chain = ms(s.chain_latency.load(Relaxed) as f32 / sr);
        LatencyReport {
            input_ms: input,
            queue_ms: queue,
            chain_ms: chain,
            output_ms: output,
            total_ms: input + queue + chain + output,
            in_block_ms: ms(s.in_block.load(Relaxed) as f32 / s.in_rate.load(Relaxed).max(1) as f32),
            out_block_ms: ms(s.out_block.load(Relaxed) as f32 / sr),
            mic: s.input_ok.load(Relaxed),
        }
    }

    pub fn set_track(&self, track: Option<Arc<Track>>, pos: u64) {
        self.shared.length.store(track.as_ref().map(|t| t.frames()).unwrap_or(0), Relaxed);
        self.shared.position.store(pos, Relaxed);
        self.shared.ended.store(false, Relaxed);
        *self.current.lock().unwrap() = track.clone();
        let _ = self.cmd_tx.send(Cmd::SetTrack(track, pos));
    }

    pub fn current_track(&self) -> Option<Arc<Track>> {
        self.current.lock().unwrap().clone()
    }

    pub fn play(&self) {
        if self.shared.ended.swap(false, Relaxed) {
            self.seek_frames(0);
        }
        self.shared.flags.playing.store(true, Relaxed);
    }

    pub fn pause(&self) {
        self.shared.flags.playing.store(false, Relaxed);
    }

    pub fn seek_frames(&self, frames: u64) {
        let frames = frames.min(self.shared.length.load(Relaxed));
        self.shared.position.store(frames, Relaxed);
        self.shared.ended.store(false, Relaxed);
        let _ = self.cmd_tx.send(Cmd::Seek(frames));
    }

    pub fn start_recording(&self, path: PathBuf) -> Result<(), String> {
        self.stop_recording()?;
        let sr = self.sample_rate();
        let rb = HeapRb::<f32>::new(sr as usize * 2 * 4);
        let (prod, mut cons) = rb.split();
        let spec = hound::WavSpec { channels: 2, sample_rate: sr, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut writer = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
        let shared = self.shared.clone();
        let handle = thread::Builder::new()
            .name("recorder".into())
            .spawn(move || -> Result<(), String> {
                let mut buf = vec![0.0f32; 8192];
                loop {
                    let n = cons.pop_slice(&mut buf);
                    for &s in &buf[..n] {
                        let v = (s.clamp(-1.0, 1.0) * 8_388_607.0) as i32;
                        writer.write_sample(v).map_err(|e| e.to_string())?;
                    }
                    if n == 0 {
                        if !shared.flags.recording.load(Relaxed) && cons.is_empty() {
                            break;
                        }
                        thread::sleep(std::time::Duration::from_millis(20));
                    }
                }
                writer.finalize().map_err(|e| e.to_string())
            })
            .map_err(|e| e.to_string())?;
        self.cmd_tx.send(Cmd::Recorder(Some(prod))).map_err(|e| e.to_string())?;
        self.shared.flags.recording.store(true, Relaxed);
        *self.recorder.lock().unwrap() = Some((path, handle));
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<Option<PathBuf>, String> {
        let Some((path, handle)) = self.recorder.lock().unwrap().take() else {
            return Ok(None);
        };
        self.shared.flags.recording.store(false, Relaxed);
        let _ = self.cmd_tx.send(Cmd::Recorder(None));
        handle.join().map_err(|_| "recorder panicked".to_string())??;
        Ok(Some(path))
    }

    pub fn is_recording(&self) -> bool {
        self.recorder.lock().unwrap().is_some()
    }

    // ------------------------------------------------------- voice lab --

    pub fn lab_record(&self) -> Result<(), String> {
        if !self.shared.input_ok.load(Relaxed) {
            return Err("Chưa kết nối micro. Hãy chọn micro trong Cài đặt âm thanh.".into());
        }
        self.lab_stop();
        let cap = self.sample_rate() as usize * LAB_MAX_SECONDS;
        self.shared.lab_pos.store(0, Relaxed);
        self.shared.lab_len.store(cap as u64, Relaxed);
        self.shared.lab_state.store(LAB_RECORDING, Relaxed);
        self.lab_tx.send(LabCmd::Record(Vec::with_capacity(cap))).map_err(|e| e.to_string())
    }

    /// Stop recording; returns the take length in seconds.
    pub fn lab_stop_record(&self) -> Result<f64, String> {
        // Drop any take left over from an earlier, interrupted recording.
        while self.take_rx.try_recv().is_ok() {}
        self.lab_tx.send(LabCmd::StopRecord).map_err(|e| e.to_string())?;
        let take = self
            .take_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "Micro không phản hồi".to_string())?;
        self.shared.lab_state.store(LAB_IDLE, Relaxed);
        let secs = take.len() as f64 / self.sample_rate() as f64;
        self.shared.lab_len.store(take.len() as u64, Relaxed);
        self.shared.lab_pos.store(0, Relaxed);
        *self.take.lock().unwrap() = (!take.is_empty()).then(|| Arc::new(take));
        Ok(secs)
    }

    pub fn lab_play(&self, looped: bool) -> Result<(), String> {
        let take = self.take.lock().unwrap().clone().ok_or("Hãy thu một đoạn trước")?;
        if !self.shared.input_ok.load(Relaxed) {
            return Err("Phát lại cần luồng micro; hãy kết nối micro.".into());
        }
        self.shared.lab_len.store(take.len() as u64, Relaxed);
        self.shared.lab_state.store(LAB_PLAYING, Relaxed);
        self.lab_tx.send(LabCmd::Play(take, looped)).map_err(|e| e.to_string())
    }

    pub fn lab_stop(&self) {
        match self.shared.lab_state.load(Relaxed) {
            LAB_RECORDING => {
                let _ = self.lab_stop_record();
            }
            LAB_PLAYING => {
                let _ = self.lab_tx.send(LabCmd::StopPlay);
                self.shared.lab_state.store(LAB_IDLE, Relaxed);
            }
            _ => {}
        }
    }

    pub fn lab_take(&self) -> Option<Arc<Vec<f32>>> {
        self.take.lock().unwrap().clone()
    }

    fn build_streams(&self, choice: &DeviceChoice) -> Result<(Streams, AudioStatus), String> {
        // Measurements belong to the streams being replaced.
        for avg in [&self.shared.avg_in, &self.shared.avg_out, &self.shared.avg_queue] {
            avg.set(0.0);
        }
        let host = pick_host(choice)?;
        let find = |name: &Option<String>, input: bool| -> Option<cpal::Device> {
            let name = name.as_ref()?;
            let mut it = if input { host.input_devices().ok()?.collect::<Vec<_>>() } else { host.output_devices().ok()?.collect::<Vec<_>>() }.into_iter();
            it.find(|d| &device_name(d) == name)
        };
        // An ASIO driver is one device for both directions.
        let (want_out, want_in) = match &choice.asio {
            Some(driver) => (Some(driver.clone()), Some(driver.clone())),
            None => (choice.output.clone(), choice.input.clone()),
        };
        let out_dev = match &choice.asio {
            Some(driver) => find(&want_out, false).ok_or(format!("Không mở được driver ASIO \"{driver}\" (có phần mềm khác đang dùng, như Cubase?)"))?,
            None => find(&want_out, false).or_else(|| host.default_output_device()).ok_or("Không tìm thấy thiết bị phát âm thanh")?,
        };
        let in_dev = match &choice.asio {
            Some(_) => find(&want_in, true),
            None => find(&want_in, true).or_else(|| host.default_input_device()),
        };
        let out_default = out_dev.default_output_config().map_err(|e| format!("Thiết bị phát: {e}"))?;

        let mut note = None;
        #[cfg(windows)]
        if choice.exclusive && choice.asio.is_none() {
            match self.build_exclusive(choice, &out_dev, in_dev.as_ref(), out_default.sample_rate()) {
                Ok(done) => return Ok(done),
                Err(e) => note = Some(format!("Không bật được chế độ độ trễ thấp: {e}. Đang dùng chế độ thường.")),
            }
        }

        let sr = out_default.sample_rate();
        let out_channels = out_default.channels() as usize;
        // ASIO: the buffer is the one set in the driver's own control panel.
        let buffer = if choice.asio.is_some() {
            None
        } else {
            choice.buffer.or(Some(256)).and_then(|b| match out_default.buffer_size() {
                cpal::SupportedBufferSize::Range { min, max } if b >= *min && b <= *max => Some(b),
                _ => None,
            })
        };
        let out_cfg = cpal::StreamConfig {
            channels: out_default.channels(),
            sample_rate: sr,
            buffer_size: buffer.map(cpal::BufferSize::Fixed).unwrap_or_default(),
        };
        self.shared.sample_rate.store(sr, Relaxed);

        let (vocal_prod, vocal_cons, frame_prod) = self.rings();
        let output = self.output_state(sr, out_channels, vocal_cons);
        let shared = self.shared.clone();
        let err = move |e: cpal::Error| {
            if is_transient(&e) {
                return;
            }
            *shared.stream_error.lock().unwrap() = Some(e.to_string());
        };
        let out_stream = match out_default.sample_format() {
            SampleFormat::F32 => build_output::<f32>(&out_dev, out_cfg, output, err),
            SampleFormat::I16 => build_output::<i16>(&out_dev, out_cfg, output, err),
            SampleFormat::I24 => build_output::<cpal::I24>(&out_dev, out_cfg, output, err),
            SampleFormat::I32 => build_output::<i32>(&out_dev, out_cfg, output, err),
            SampleFormat::U16 => build_output::<u16>(&out_dev, out_cfg, output, err),
            f => Err(format!("Thiết bị phát dùng định dạng mẫu không hỗ trợ: {f}")),
        }?;
        out_stream.play().map_err(|e| e.to_string())?;

        let mut status = AudioStatus {
            sample_rate: sr,
            output: device_name(&out_dev),
            buffer,
            exclusive_note: note,
            asio: choice.asio.clone(),
            ..Default::default()
        };

        let in_stream = match in_dev {
            None => {
                status.input_error = Some("Không tìm thấy micro".into());
                None
            }
            Some(dev) => {
                status.input = Some(device_name(&dev));
                match self.build_input(&dev, sr, buffer, vocal_prod, frame_prod) {
                    Ok(s) => Some(s),
                    Err(e) => {
                        status.input_error = Some(e);
                        None
                    }
                }
            }
        };
        self.shared.input_ok.store(in_stream.is_some(), Relaxed);
        status.latency_ms = self.shared.chain_latency.load(Relaxed) as f32 / sr as f32 * 1000.0
            + 2.0 * buffer.unwrap_or(512) as f32 / sr as f32 * 1000.0;
        let mut streams: Streams = vec![Box::new(out_stream)];
        streams.extend(in_stream.map(|s| Box::new(s) as Box<dyn std::any::Any>));
        Ok((streams, status))
    }

    /// The voice ring (input → output) and the pitch-frame ring (input → UI).
    fn rings(&self) -> (HeapProd<f32>, HeapCons<f32>, HeapProd<StampedFrame>) {
        // 0.5 s of stereo at up to 96 kHz.
        let (vocal_prod, vocal_cons) = HeapRb::<f32>::new(96_000).split();
        let (frame_prod, frame_cons) = HeapRb::<StampedFrame>::new(4096).split();
        *self.frames.lock().unwrap() = Some(frame_cons);
        (vocal_prod, vocal_cons, frame_prod)
    }

    fn output_state(&self, sr: u32, channels: usize, vocal: HeapCons<f32>) -> OutputState {
        OutputState {
            shared: self.shared.clone(),
            cmd_rx: self.cmd_rx.clone(),
            garbage: self.garbage_tx.clone(),
            track: None,
            pos: self.shared.position.load(Relaxed),
            vocal,
            recorder: None,
            mix: Vec::with_capacity(16_384),
            vocal_tmp: vec![0.0; 16_384],
            rec_tmp: Vec::with_capacity(16_384),
            limiter: Limiter::new(sr as f32),
            drone: Drone::new(sr),
            channels,
            sr,
            queue_low: usize::MAX,
            queue_window: 0,
            queue_margin: 64,
            resume: false,
            ran_dry: false,
            xfade: [0.0; XFADE * 2],
        }
    }

    /// The mic path at input rate `in_sr`, feeding an engine running at `sr`.
    fn input_state(&self, sr: u32, in_sr: u32, channels: usize, vocal: HeapProd<f32>, frames: HeapProd<StampedFrame>) -> InputState {
        self.shared.in_rate.store(in_sr, Relaxed);
        let chain = VocalChain::new(sr as f32);
        self.shared.chain_latency.store(chain.latency() as u32, Relaxed);
        InputState {
            shared: self.shared.clone(),
            chain,
            vocal,
            frames,
            channels,
            mono: Vec::with_capacity(16_384),
            resampled: Vec::with_capacity(16_384),
            stereo: Vec::with_capacity(32_768),
            resampler: (in_sr != sr).then(|| LinearResampler::new(in_sr as f64 / sr as f64)),
            lab_rx: self.lab_rx.clone(),
            take_tx: self.take_tx.clone(),
            garbage: self.buf_garbage_tx.clone(),
            take: None,
            play: None,
        }
    }

    /// Both devices in WASAPI exclusive mode. If only the mic refuses, it
    /// falls back to a shared-mode mic and keeps the exclusive output.
    #[cfg(windows)]
    fn build_exclusive(&self, choice: &DeviceChoice, out_dev: &cpal::Device, in_dev: Option<&cpal::Device>, mix_rate: u32) -> Result<(Streams, AudioStatus), String> {
        use super::exclusive;
        let endpoint = |d: &cpal::Device| d.id().map(|id| id.id().to_string()).map_err(|e| e.to_string());
        let frames = choice.buffer.unwrap_or(256).clamp(64, 1024);
        let mut rates = vec![mix_rate];
        for r in [48_000, 44_100, 96_000] {
            if !rates.contains(&r) {
                rates.push(r);
            }
        }
        let (vocal_prod, vocal_cons, frame_prod) = self.rings();
        let engine_shared = self.shared.clone();
        let (out_stream, out_info) = {
            // The output state needs the negotiated rate, so it is built on
            // the stream thread; hand it the pieces.
            let shared = self.shared.clone();
            let cmd_rx = self.cmd_rx.clone();
            let garbage = self.garbage_tx.clone();
            let pos = self.shared.position.load(Relaxed);
            let make = move |f: &exclusive::Format| -> exclusive::Render {
                let mut state = OutputState {
                    shared,
                    cmd_rx,
                    garbage,
                    track: None,
                    pos,
                    vocal: vocal_cons,
                    recorder: None,
                    mix: Vec::with_capacity(16_384),
                    vocal_tmp: vec![0.0; 16_384],
                    rec_tmp: Vec::with_capacity(16_384),
                    limiter: Limiter::new(f.rate as f32),
                    drone: Drone::new(f.rate),
                    channels: f.channels,
                    sr: f.rate,
                    queue_low: usize::MAX,
                    queue_window: 0,
                    queue_margin: 64,
                    resume: false,
                    ran_dry: false,
                    xfade: [0.0; XFADE * 2],
                };
                Box::new(move |data: &mut [f32], lat: f32| fill_output(&mut state, data, lat))
            };
            let err_shared = engine_shared.clone();
            exclusive::output(endpoint(out_dev)?, rates.clone(), frames, make, move |e| *err_shared.stream_error.lock().unwrap() = Some(e))?
        };
        let sr = out_info.format.rate;
        self.shared.sample_rate.store(sr, Relaxed);
        let mut status = AudioStatus {
            sample_rate: sr,
            output: device_name(out_dev),
            buffer: Some(out_info.frames),
            exclusive: true,
            ..Default::default()
        };
        let mut streams: Streams = vec![Box::new(out_stream)];

        match in_dev {
            None => status.input_error = Some("Không tìm thấy micro".into()),
            Some(dev) => {
                status.input = Some(device_name(dev));
                let mut in_rates = vec![sr];
                in_rates.extend(rates.iter().copied().filter(|&r| r != sr));
                // Built here and taken by the stream thread once the format is
                // known; if the mic can't go exclusive it is still in the slot.
                let slot = Arc::new(Mutex::new(Some(self.input_state(sr, sr, 1, vocal_prod, frame_prod))));
                let taken = slot.clone();
                let make = move |f: &exclusive::Format| -> exclusive::Capture {
                    let mut state = taken.lock().unwrap().take().expect("input state");
                    state.channels = f.channels;
                    state.resampler = (f.rate != sr).then(|| LinearResampler::new(f.rate as f64 / sr as f64));
                    state.shared.in_rate.store(f.rate, Relaxed);
                    Box::new(move |data: &[f32], lat: f32| take_input(&mut state, data, lat))
                };
                let err_shared = engine_shared.clone();
                match endpoint(dev).and_then(|id| exclusive::input(id, in_rates, frames, make, move |e| *err_shared.stream_error.lock().unwrap() = Some(e))) {
                    Ok((s, _)) => streams.push(Box::new(s)),
                    Err(e) => {
                        // Keep the low-latency output; the mic goes through Windows.
                        status.exclusive_note = Some(format!("Micro không vào được chế độ độ trễ thấp ({e}), đang chạy chế độ thường."));
                        match slot.lock().unwrap().take() {
                            Some(state) => match self.build_input(dev, sr, choice.buffer, state.vocal, state.frames) {
                                Ok(s) => streams.push(Box::new(s)),
                                Err(e) => status.input_error = Some(e),
                            },
                            None => status.input_error = Some(e),
                        }
                    }
                }
            }
        }
        self.shared.input_ok.store(streams.len() > 1, Relaxed);
        status.latency_ms = (self.shared.chain_latency.load(Relaxed) as f32 / sr as f32 + 2.0 * out_info.latency) * 1000.0;
        Ok((streams, status))
    }

    fn build_input(
        &self,
        dev: &cpal::Device,
        sr: u32,
        buffer: Option<u32>,
        vocal: HeapProd<f32>,
        frames: HeapProd<StampedFrame>,
    ) -> Result<cpal::Stream, String> {
        // Prefer a config at the output rate so no resampling is needed.
        let same_rate = dev.supported_input_configs().ok().and_then(|cfgs| {
            let mut v: Vec<_> = cfgs.filter(|c| c.min_sample_rate() <= sr && c.max_sample_rate() >= sr).collect();
            v.sort_by_key(|c| (c.sample_format() != SampleFormat::F32, c.channels()));
            v.into_iter().next().map(|c| c.with_sample_rate(sr))
        });
        let supported = match same_rate {
            Some(c) => c,
            None => dev.default_input_config().map_err(|e| format!("Micro: {e}"))?,
        };
        let in_sr = supported.sample_rate();
        let buffer = buffer.and_then(|b| match supported.buffer_size() {
            cpal::SupportedBufferSize::Range { min, max } if b >= *min && b <= *max => Some(b),
            _ => None,
        });
        let cfg = cpal::StreamConfig {
            channels: supported.channels(),
            sample_rate: in_sr,
            buffer_size: buffer.map(cpal::BufferSize::Fixed).unwrap_or_default(),
        };
        let state = self.input_state(sr, in_sr, supported.channels() as usize, vocal, frames);
        let shared = self.shared.clone();
        let err = move |e: cpal::Error| {
            if is_transient(&e) {
                return;
            }
            *shared.stream_error.lock().unwrap() = Some(format!("Micro: {e}"));
        };
        let stream = match supported.sample_format() {
            SampleFormat::F32 => build_input::<f32>(dev, cfg, state, err),
            SampleFormat::I16 => build_input::<i16>(dev, cfg, state, err),
            SampleFormat::I24 => build_input::<cpal::I24>(dev, cfg, state, err),
            SampleFormat::I32 => build_input::<i32>(dev, cfg, state, err),
            SampleFormat::U16 => build_input::<u16>(dev, cfg, state, err),
            f => Err(format!("Micro dùng định dạng mẫu không hỗ trợ: {f}")),
        }?;
        stream.play().map_err(|e| format!("Micro: {e}"))?;
        Ok(stream)
    }
}

// ------------------------------------------------------------- output --

struct OutputState {
    shared: Arc<Shared>,
    cmd_rx: Receiver<Cmd>,
    garbage: Sender<Arc<Track>>,
    track: Option<Arc<Track>>,
    pos: u64,
    vocal: HeapCons<f32>,
    recorder: Option<HeapProd<f32>>,
    mix: Vec<f32>,
    vocal_tmp: Vec<f32>,
    rec_tmp: Vec<f32>,
    limiter: Limiter,
    drone: Drone,
    channels: usize,
    sr: u32,
    /// Lowest voice-queue fill seen in the current window, and the window's length (frames).
    queue_low: usize,
    queue_window: usize,
    /// Frames kept beyond one block; grows if the queue ever runs dry.
    queue_margin: usize,
    /// The queue ran dry last block: fade the voice back in.
    resume: bool,
    /// It ran dry during the current window.
    ran_dry: bool,
    xfade: [f32; XFADE * 2],
}

/// Fade length (frames) when the voice queue is trimmed or runs dry.
const XFADE: usize = 32;

/// A soft sustained chord on the current key, to sing against in the Voice Lab.
struct Drone {
    phases: [f64; 8],
    incs: [f64; 8],
    gain: f32,
    key: (i32, usize),
    sr: f64,
}

impl Drone {
    fn new(sr: u32) -> Self {
        Self { phases: [0.0; 8], incs: [0.0; 8], gain: 0.0, key: (-1, 0), sr: sr as f64 }
    }

    fn retune(&mut self, tonic: i32, scale_idx: usize) {
        if self.key == (tonic, scale_idx) {
            return;
        }
        self.key = (tonic, scale_idx);
        let sc = super::scale::scale(scale_idx);
        let third = if sc.contains(&4) { 4 } else { 3 };
        let root = 48 + tonic.rem_euclid(12);
        // Root, fifth, octave and third; each voice doubled with a slight detune.
        let notes = [root, root + 7, root + 12, root + 12 + third];
        for (k, n) in notes.iter().enumerate() {
            let f = 440.0 * 2f64.powf((*n as f64 - 69.0) / 12.0);
            self.incs[k * 2] = f * 2f64.powf(-0.04 / 12.0) / self.sr;
            self.incs[k * 2 + 1] = f * 2f64.powf(0.04 / 12.0) / self.sr;
        }
    }

    #[inline]
    fn next(&mut self, level: f32) -> (f32, f32) {
        self.gain += (level * 0.09 - self.gain) * 0.0004;
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for k in 0..8 {
            self.phases[k] = (self.phases[k] + self.incs[k]).fract();
            let ph = self.phases[k] * std::f64::consts::TAU;
            let v = (ph.sin() + 0.25 * (2.0 * ph).sin()) as f32;
            if k % 2 == 0 {
                l += v;
            } else {
                r += v;
            }
        }
        (l * self.gain, r * self.gain)
    }
}

impl OutputState {
    fn handle_commands(&mut self) {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            match cmd {
                Cmd::SetTrack(t, pos) => {
                    if let Some(old) = std::mem::replace(&mut self.track, t) {
                        let _ = self.garbage.try_send(old);
                    }
                    self.pos = pos;
                }
                Cmd::Seek(pos) => self.pos = pos,
                Cmd::Recorder(r) => self.recorder = r,
            }
        }
    }

    #[inline]
    fn frame_at(buf: &[f32], frame: i64) -> (f32, f32) {
        if frame < 0 {
            return (0.0, 0.0);
        }
        let i = frame as usize * 2;
        if i + 1 < buf.len() {
            (buf[i], buf[i + 1])
        } else {
            (0.0, 0.0)
        }
    }

    /// Render `frames` frames of interleaved stereo into `self.mix`.
    fn render(&mut self, frames: usize, out_latency: f32) {
        self.handle_commands();
        let p = &self.shared.params;
        let playing = self.shared.flags.playing.load(Relaxed);
        // Voice Lab playback must be audible even with monitoring off.
        let lab_playing = self.shared.lab_state.load(Relaxed) == LAB_PLAYING;
        let (master, inst, guide, vocal, monitor) =
            (p.master.get(), p.instrumental.get(), p.guide.get(), p.vocal.get(), p.monitor.get() > 0.5 || lab_playing);
        let drone_level = p.drone.get().clamp(0.0, 1.0);
        let drone_on = drone_level > 0.0 || self.drone.gain > 1e-4;
        if drone_on {
            self.drone.retune(p.tune_key.get().round() as i32, p.tune_scale.get().round() as usize);
        }

        // The mic and the output run on separate clocks with different
        // packet sizes, so the queue between them saw-tooths by a mic packet.
        // Track its low point over ~0.5 s: whatever stays above one block
        // plus a margin is pure delay, so drop that (with a short crossfade).
        // Trimming into the saw-tooth itself starved blocks and clicked.
        let mut backlog = self.vocal.occupied_len() / 2;
        self.queue_low = self.queue_low.min(backlog);
        self.queue_window += frames;
        let mut fade_from = None;
        if self.queue_window >= self.sr as usize / 2 {
            // A quiet stretch without running dry: ease the margin back.
            if !self.ran_dry {
                self.queue_margin = self.queue_margin.saturating_sub(16).max(64);
            }
            self.ran_dry = false;
            let spare = self.queue_low.saturating_sub(frames + self.queue_margin);
            if spare >= 64 {
                // Keep what would have played next, to fade from it.
                let n = self.vocal.pop_slice(&mut self.xfade[..XFADE * 2]);
                self.vocal.skip(spare * 2);
                backlog -= spare + n / 2;
                fade_from = Some(n);
            }
            self.queue_low = usize::MAX;
            self.queue_window = 0;
        }
        smooth(&self.shared.avg_queue, backlog as f32 / self.sr as f32);
        if self.vocal_tmp.len() < frames * 2 {
            self.vocal_tmp.resize(frames * 2, 0.0);
        }
        let got = self.vocal.pop_slice(&mut self.vocal_tmp[..frames * 2]);
        let want = frames * 2;
        if let Some(n) = fade_from {
            for i in 0..n.min(got) / 2 {
                let t = i as f32 / XFADE as f32;
                for c in 0..2 {
                    let k = i * 2 + c;
                    self.vocal_tmp[k] = self.xfade[k] * (1.0 - t) + self.vocal_tmp[k] * t;
                }
            }
        }
        if self.resume {
            // Coming back after running dry: fade in instead of jumping.
            for i in 0..(got / 2).min(XFADE) {
                let t = i as f32 / XFADE as f32;
                self.vocal_tmp[i * 2] *= t;
                self.vocal_tmp[i * 2 + 1] *= t;
            }
            self.resume = false;
        }
        if got < want {
            // Ran dry (the mic was late): fade out what there is, and keep a
            // bigger margin from now on so it doesn't happen again.
            let frames_got = got / 2;
            let fade = frames_got.min(XFADE);
            for i in 0..fade {
                let t = (fade - i) as f32 / fade as f32;
                let k = (frames_got - fade + i) * 2;
                self.vocal_tmp[k] *= t;
                self.vocal_tmp[k + 1] *= t;
            }
            self.vocal_tmp[got..want].fill(0.0);
            self.resume = true;
            // Only a block that came up short mid-stream means the margin
            // is too small; an empty queue just means the mic isn't sending
            // yet (starting up) and says nothing about timing.
            if got > 0 {
                self.queue_margin = (self.queue_margin + 64).min(1024);
                self.ran_dry = true;
            }
        }

        let recording = self.recorder.is_some();
        // Line the recorded vocal up with what the singer heard.
        let comp = if recording {
            let manual = p.record_latency_ms.get();
            let secs = if manual >= 0.0 {
                manual / 1000.0
            } else {
                out_latency
                    + self.shared.in_latency.get()
                    + (self.shared.chain_latency.load(Relaxed) as usize + backlog) as f32 / self.sr as f32
            };
            (secs * self.sr as f32) as i64
        } else {
            0
        };

        self.mix.clear();
        self.rec_tmp.clear();
        let len = self.track.as_ref().map(|t| t.frames()).unwrap_or(0);
        // Snapshot what is playable for this whole block (one atomic read).
        let (audio, guide_buf, guide_offset): (&[f32], &[f32], i64) = match &self.track {
            Some(t) => (t.audio.ready(), t.guide.as_ref().map(|g| g.ready()).unwrap_or(&[]), t.guide_offset),
            None => (&[], &[], 0),
        };
        let ready = (audio.len() / 2) as u64;
        let mut buffering = false;
        let mut peak = 0.0f32;
        for i in 0..frames {
            let (mut bl, mut br) = (0.0, 0.0);
            let (mut rl, mut rr) = (0.0, 0.0);
            if self.track.is_some() && playing && self.pos < len {
                if self.pos >= ready {
                    // Hold position until the separator catches up.
                    buffering = true;
                } else {
                    let f = self.pos as i64;
                    let (il, ir) = Self::frame_at(audio, f);
                    bl = il * inst;
                    br = ir * inst;
                    if !guide_buf.is_empty() {
                        let (gl, gr) = Self::frame_at(guide_buf, f - guide_offset);
                        bl += gl * guide;
                        br += gr * guide;
                    }
                    if recording {
                        let (il, ir) = Self::frame_at(audio, f - comp);
                        rl = il * inst;
                        rr = ir * inst;
                    }
                    self.pos += 1;
                }
            }
            let vl = self.vocal_tmp[i * 2] * vocal;
            let vr = self.vocal_tmp[i * 2 + 1] * vocal;
            if drone_on {
                let d = self.drone.next(drone_level);
                bl += d.0;
                br += d.1;
            }
            let (l, r) = if monitor { (bl + vl, br + vr) } else { (bl, br) };
            let (l, r) = self.limiter.run(l * master, r * master);
            peak = peak.max(l.abs()).max(r.abs());
            self.mix.push(l);
            self.mix.push(r);
            if recording {
                self.rec_tmp.push(((rl + vl) * master).clamp(-1.0, 1.0));
                self.rec_tmp.push(((rr + vr) * master).clamp(-1.0, 1.0));
            }
        }
        if let Some(rec) = &mut self.recorder {
            if playing && !buffering {
                rec.push_slice(&self.rec_tmp);
            }
        }
        self.shared.buffering.store(buffering, Relaxed);
        if playing && self.track.is_some() && self.pos >= len {
            self.shared.flags.playing.store(false, Relaxed);
            self.shared.ended.store(true, Relaxed);
        }
        self.shared.position.store(self.pos, Relaxed);
        let prev = self.shared.out_peak.get();
        self.shared.out_peak.set(peak.max(prev * 0.9));
    }
}

fn build_output<T>(
    dev: &cpal::Device,
    cfg: cpal::StreamConfig,
    mut state: OutputState,
    err: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    dev.build_output_stream::<T, _, _>(
        cfg,
        move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
            let ts = info.timestamp();
            fill_output(&mut state, data, ts.playback.duration_since(ts.callback).as_secs_f32());
        },
        err,
        None,
    )
    .map_err(|e| format!("Thiết bị phát: {e}"))
}

// -------------------------------------------------------------- input --

struct LinearResampler {
    step: f64,
    pos: f64,
    last: f32,
}

impl LinearResampler {
    fn new(step: f64) -> Self {
        Self { step, pos: 0.0, last: 0.0 }
    }

    /// `x[0]` is the previous block's last sample, `x[k]` is `input[k-1]`.
    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        out.clear();
        let n = input.len() as f64;
        while self.pos < n {
            let i = self.pos.floor() as usize;
            let f = (self.pos - i as f64) as f32;
            let a = if i == 0 { self.last } else { input[i - 1] };
            let b = input[i];
            out.push(a + (b - a) * f);
            self.pos += self.step;
        }
        self.pos -= n;
        if let Some(&l) = input.last() {
            self.last = l;
        }
    }
}

struct InputState {
    shared: Arc<Shared>,
    chain: VocalChain,
    vocal: HeapProd<f32>,
    frames: HeapProd<StampedFrame>,
    channels: usize,
    mono: Vec<f32>,
    resampled: Vec<f32>,
    stereo: Vec<f32>,
    resampler: Option<LinearResampler>,
    lab_rx: Receiver<LabCmd>,
    take_tx: Sender<Vec<f32>>,
    garbage: Sender<Arc<Vec<f32>>>,
    take: Option<Vec<f32>>,
    play: Option<(Arc<Vec<f32>>, usize, bool)>,
}

impl InputState {
    fn lab_commands(&mut self) {
        while let Ok(cmd) = self.lab_rx.try_recv() {
            match cmd {
                LabCmd::Record(buf) => self.take = Some(buf),
                LabCmd::StopRecord => {
                    let buf = self.take.take().unwrap_or_default();
                    let _ = self.take_tx.try_send(buf);
                }
                LabCmd::Play(buf, looped) => {
                    if let Some((old, _, _)) = self.play.replace((buf, 0, looped)) {
                        let _ = self.garbage.try_send(old);
                    }
                }
                LabCmd::StopPlay => {
                    if let Some((old, _, _)) = self.play.take() {
                        let _ = self.garbage.try_send(old);
                    }
                }
            }
        }
    }

    fn consume(&mut self) {
        self.lab_commands();
        if let Some(rs) = &mut self.resampler {
            rs.process(&self.mono, &mut self.resampled);
            std::mem::swap(&mut self.mono, &mut self.resampled);
        }
        // Mic switched off: the whole chain hears silence, so nothing is
        // heard, recorded, pitch-tracked or scored.
        if self.shared.params.mic.get() < 0.5 {
            self.mono.fill(0.0);
        }
        let peak = self.mono.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        let prev = self.shared.mic_peak.get();
        self.shared.mic_peak.set(peak.max(prev * 0.9));

        // Voice Lab: capture the raw mic (within the pre-allocated capacity).
        if let Some(take) = &mut self.take {
            let room = take.capacity() - take.len();
            take.extend_from_slice(&self.mono[..self.mono.len().min(room)]);
            self.shared.lab_pos.store(take.len() as u64, Relaxed);
        }
        // Voice Lab: replace the mic with the recorded take.
        let mut finished = false;
        if let Some((buf, pos, looped)) = &mut self.play {
            for s in self.mono.iter_mut() {
                if *pos >= buf.len() {
                    if *looped && !buf.is_empty() {
                        *pos = 0;
                    } else {
                        *s = 0.0;
                        finished = true;
                        continue;
                    }
                }
                *s = buf[*pos];
                *pos += 1;
            }
            self.shared.lab_pos.store(*pos as u64, Relaxed);
        }
        if finished {
            if let Some((old, _, _)) = self.play.take() {
                let _ = self.garbage.try_send(old);
            }
            self.shared.lab_state.store(LAB_IDLE, Relaxed);
        }

        let pos = self.shared.position.load(Relaxed);
        let frames = &mut self.frames;
        self.chain.process(&self.mono, &mut self.stereo, &self.shared.params, |frame| {
            let _ = frames.try_push(StampedFrame { frame, pos });
        });
        // Natural voice skips the pitch shifter and its delay.
        self.shared.chain_latency.store(self.chain.latency() as u32, Relaxed);
        if self.play.is_some() && self.shared.lab_bypass.load(Relaxed) {
            for (o, &x) in self.stereo.chunks_exact_mut(2).zip(&self.mono) {
                o[0] = x * 0.707;
                o[1] = x * 0.707;
            }
        }
        self.vocal.push_slice(&self.stereo);
    }
}

/// One output block: mix it and write it in the device's sample type.
/// `lat` is how long until it is heard, in seconds.
fn fill_output<T: SizedSample + FromSample<f32>>(state: &mut OutputState, data: &mut [T], lat: f32) {
    let shared = &state.shared;
    shared.out_latency.set(lat);
    smooth(&shared.avg_out, lat);
    let ch = state.channels;
    let frames = data.len() / ch;
    shared.out_block.store(frames as u32, Relaxed);
    state.render(frames, lat);
    for (f, out) in data.chunks_mut(ch).enumerate() {
        let (l, r) = (state.mix[f * 2], state.mix[f * 2 + 1]);
        if ch == 1 {
            out[0] = T::from_sample((l + r) * 0.5);
        } else {
            out[0] = T::from_sample(l);
            out[1] = T::from_sample(r);
            for o in out.iter_mut().skip(2) {
                *o = T::from_sample(0.0f32);
            }
        }
    }
}

/// One mic block; `lat` is how long ago it was captured, in seconds.
fn take_input<T: SizedSample>(state: &mut InputState, data: &[T], lat: f32)
where
    f32: FromSample<T>,
{
    let shared = &state.shared;
    shared.in_latency.set(lat);
    smooth(&shared.avg_in, lat);
    let ch = state.channels.max(1);
    shared.in_block.store((data.len() / ch) as u32, Relaxed);
    state.mono.clear();
    // Sum rather than average: a mic on one channel of a stereo
    // interface would otherwise lose 6 dB.
    for frame in data.chunks(ch) {
        let s: f32 = frame.iter().map(|&x| x.to_sample::<f32>()).sum();
        state.mono.push(s.clamp(-1.0, 1.0));
    }
    state.consume();
}

/// Running average for a measurement taken once per audio callback (only
/// that callback writes it, so load-then-store is safe).
fn smooth(avg: &AtomicF32, x: f32) {
    let prev = avg.get();
    avg.set(if prev == 0.0 { x } else { prev + (x - prev) * 0.05 });
}

/// Errors after which the stream keeps running on its own. WASAPI flags a
/// data discontinuity (Xrun) on many laptop mics even when nothing is audible,
/// and DeviceChanged means cpal already rerouted; neither is worth a toast.
fn is_transient(e: &cpal::Error) -> bool {
    matches!(e.kind(), cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged)
}

fn build_input<T>(
    dev: &cpal::Device,
    cfg: cpal::StreamConfig,
    mut state: InputState,
    err: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    dev.build_input_stream::<T, _, _>(
        cfg,
        move |data: &[T], info: &cpal::InputCallbackInfo| {
            let ts = info.timestamp();
            take_input(&mut state, data, ts.callback.duration_since(ts.capture).as_secs_f32());
        },
        err,
        None,
    )
    .map_err(|e| format!("Micro: {e}"))
}
