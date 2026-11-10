//! WASAPI exclusive mode (Windows only). The app takes the device for
//! itself, so audio skips the Windows mixer and its extra buffering: the
//! delay between singing and hearing yourself drops from ~50 ms to ~15 ms.
//! cpal only does shared mode, so this drives WASAPI directly. Each stream
//! runs on its own event-driven thread at "Pro Audio" priority.
#![cfg(windows)]

use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, S_OK, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE};
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, WaitForSingleObject};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Sample {
    F32,
    /// 32-bit container (some devices use only the top 24 bits).
    I32,
    /// Packed 3-byte samples.
    I24,
    I16,
}

impl Sample {
    fn bytes(self) -> usize {
        match self {
            Sample::F32 | Sample::I32 => 4,
            Sample::I24 => 3,
            Sample::I16 => 2,
        }
    }
}

/// What the device was opened with.
#[derive(Clone, Copy, Debug)]
pub struct Format {
    pub rate: u32,
    pub channels: usize,
    sample: Sample,
}

#[derive(Clone, Copy, Debug)]
pub struct Info {
    pub format: Format,
    /// Frames per callback.
    pub frames: u32,
    /// Estimated device-side delay, seconds.
    pub latency: f32,
}

/// Fills one interleaved block for the device; the second argument is the
/// estimated output latency in seconds.
pub type Render = Box<dyn FnMut(&mut [f32], f32) + Send>;
/// Receives one interleaved block from the device, with the estimated input latency.
pub type Capture = Box<dyn FnMut(&[f32], f32) + Send>;

/// A running exclusive stream. Dropping it stops the thread and frees the device.
pub struct Stream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Open the render endpoint `id` (a WASAPI endpoint id) in exclusive mode.
/// `make` builds the render callback once the format is known.
pub fn output(
    id: String,
    rates: Vec<u32>,
    frames: u32,
    make: impl FnOnce(&Format) -> Render + Send + 'static,
    on_error: impl Fn(String) + Send + 'static,
) -> Result<(Stream, Info), String> {
    spawn("wasapi-out", move |stop, ready| unsafe { run_output(&id, &rates, frames, make, &on_error, &stop, ready) })
}

/// Open the capture endpoint `id` in exclusive mode.
pub fn input(
    id: String,
    rates: Vec<u32>,
    frames: u32,
    make: impl FnOnce(&Format) -> Capture + Send + 'static,
    on_error: impl Fn(String) + Send + 'static,
) -> Result<(Stream, Info), String> {
    spawn("wasapi-in", move |stop, ready| unsafe { run_input(&id, &rates, frames, make, &on_error, &stop, ready) })
}

type Ready = mpsc::Sender<Result<Info, String>>;

/// Runs `body` on a new thread with COM initialised; returns once the
/// stream has started (or failed to).
fn spawn(name: &str, body: impl FnOnce(Arc<AtomicBool>, Ready) + Send + 'static) -> Result<(Stream, Info), String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    let stop2 = stop.clone();
    let thread = thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            body(stop2, tx);
            if com.is_ok() {
                unsafe { CoUninitialize() };
            }
        })
        .map_err(|e| e.to_string())?;
    let stream = Stream { stop, thread: Some(thread) };
    match rx.recv() {
        Ok(Ok(info)) => Ok((stream, info)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("luồng âm thanh dừng bất ngờ".into()),
    }
}

/// Plain-language reasons for the failures people actually hit.
fn explain(e: &windows::core::Error) -> String {
    match e.code() {
        AUDCLNT_E_DEVICE_IN_USE => "thiết bị đang bị app khác dùng độc quyền".into(),
        AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED => {
            "Windows đang chặn chế độ độc quyền (Sound → thiết bị → Properties → Advanced → bật \"Allow applications to take exclusive control\")".into()
        }
        AUDCLNT_E_UNSUPPORTED_FORMAT => "thiết bị không nhận định dạng âm thanh nào ở chế độ độc quyền".into(),
        AUDCLNT_E_DEVICE_INVALIDATED => "thiết bị đã bị rút ra hoặc tắt".into(),
        _ => e.message().to_string(),
    }
}

unsafe fn device(id: &str) -> windows::core::Result<IMMDevice> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    enumerator.GetDevice(PCWSTR(wide.as_ptr()))
}

fn wave_format(rate: u32, channels: usize, sample: Sample, valid_bits: u16, mask: u32) -> WAVEFORMATEXTENSIBLE {
    let bytes = sample.bytes() as u16;
    let ch = channels as u16;
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE as u16,
            nChannels: ch,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * (bytes * ch) as u32,
            nBlockAlign: bytes * ch,
            wBitsPerSample: bytes * 8,
            cbSize: (size_of::<WAVEFORMATEXTENSIBLE>() - size_of::<WAVEFORMATEX>()) as u16,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 { wValidBitsPerSample: valid_bits },
        dwChannelMask: mask,
        SubFormat: if sample == Sample::F32 { KSDATAFORMAT_SUBTYPE_IEEE_FLOAT } else { KSDATAFORMAT_SUBTYPE_PCM },
    }
}

/// The first format the device accepts exclusively: preferred rates first,
/// then the shared-mode channel layout, then sample types from best to worst.
unsafe fn negotiate(client: &IAudioClient, rates: &[u32]) -> Result<(Format, WAVEFORMATEXTENSIBLE), String> {
    let mix = client.GetMixFormat().map_err(|e| explain(&e))?;
    let (mix_ch, mix_mask) = {
        let f = ptr::read_unaligned(mix);
        let mask = if f.wFormatTag == WAVE_FORMAT_EXTENSIBLE as u16 {
            ptr::read_unaligned(mix as *const WAVEFORMATEXTENSIBLE).dwChannelMask
        } else {
            0
        };
        (f.nChannels as usize, mask)
    };
    CoTaskMemFree(Some(mix as *const _));
    let mut channels = vec![mix_ch];
    for c in [2, 1] {
        if !channels.contains(&c) {
            channels.push(c);
        }
    }
    const SAMPLES: [(Sample, u16); 5] = [(Sample::F32, 32), (Sample::I32, 32), (Sample::I32, 24), (Sample::I24, 24), (Sample::I16, 16)];
    for &rate in rates {
        for &ch in &channels {
            let mask = if ch == mix_ch && mix_mask != 0 {
                mix_mask
            } else if ch == 1 {
                0x4 // front centre
            } else {
                0x3 // front left + right
            };
            for (sample, valid) in SAMPLES {
                let wf = wave_format(rate, ch, sample, valid, mask);
                if client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &wf as *const _ as *const WAVEFORMATEX, None) == S_OK {
                    return Ok((Format { rate, channels: ch, sample }, wf));
                }
            }
        }
    }
    Err("thiết bị không nhận định dạng âm thanh nào ở chế độ độc quyền".into())
}

/// Activate, pick a format and initialise an event-driven exclusive client
/// with periods of about `frames`. Returns the client, format and buffer size.
unsafe fn open(id: &str, rates: &[u32], frames: u32) -> Result<(IAudioClient, Format, u32, HANDLE), String> {
    let dev = device(id).map_err(|e| explain(&e))?;
    let activate = || -> Result<IAudioClient, String> { dev.Activate(CLSCTX_ALL, None).map_err(|e| explain(&e)) };
    let mut client = activate()?;
    let (format, wf) = negotiate(&client, rates)?;
    let (mut _default, mut min) = (0i64, 0i64);
    client.GetDevicePeriod(Some(&mut _default), Some(&mut min)).map_err(|e| explain(&e))?;
    let mut period = (frames as i64 * 10_000_000 / format.rate as i64).max(min);
    let fmt = &wf as *const _ as *const WAVEFORMATEX;
    let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    if let Err(e) = client.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, period, period, fmt, None) {
        if e.code() != AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
            return Err(explain(&e));
        }
        // The device needs a period that is a whole number of its own
        // blocks: take the size it suggests and start over.
        let n = client.GetBufferSize().map_err(|e| explain(&e))?;
        period = (10_000_000f64 * n as f64 / format.rate as f64).round() as i64;
        client = activate()?;
        client.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, flags, period, period, fmt, None).map_err(|e| explain(&e))?;
    }
    let buffer = client.GetBufferSize().map_err(|e| explain(&e))?;
    let event = CreateEventW(None, false, false, PCWSTR::null()).map_err(|e| explain(&e))?;
    client.SetEventHandle(event).map_err(|e| explain(&e))?;
    Ok((client, format, buffer, event))
}

fn latency(client: &IAudioClient, buffer: u32, rate: u32) -> f32 {
    let stream = unsafe { client.GetStreamLatency() }.unwrap_or(0) as f32 / 1e7;
    stream + buffer as f32 / rate as f32
}

unsafe fn run_output(
    id: &str,
    rates: &[u32],
    frames: u32,
    make: impl FnOnce(&Format) -> Render,
    on_error: &dyn Fn(String),
    stop: &AtomicBool,
    ready: Ready,
) {
    let (client, format, buffer, event) = match open(id, rates, frames) {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let setup = || -> Result<IAudioRenderClient, String> {
        let render: IAudioRenderClient = client.GetService().map_err(|e| explain(&e))?;
        // Start from a buffer of silence, as WASAPI asks.
        render.GetBuffer(buffer).map_err(|e| explain(&e))?;
        render.ReleaseBuffer(buffer, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32).map_err(|e| explain(&e))?;
        client.Start().map_err(|e| explain(&e))?;
        Ok(render)
    };
    let render = match setup() {
        Ok(r) => r,
        Err(e) => {
            let _ = CloseHandle(event);
            let _ = ready.send(Err(e));
            return;
        }
    };
    let lat = latency(&client, buffer, format.rate);
    let mut fill = make(&format);
    let mut block = vec![0.0f32; buffer as usize * format.channels];
    let _ = ready.send(Ok(Info { format, frames: buffer, latency: lat }));

    let mut task = 0u32;
    let mmcss = AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task);
    while !stop.load(Relaxed) {
        if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 {
            continue;
        }
        fill(&mut block, lat);
        match render.GetBuffer(buffer) {
            Ok(p) => {
                write(p, &block, format.sample);
                let _ = render.ReleaseBuffer(buffer, 0);
            }
            Err(e) => {
                on_error(format!("Thiết bị phát: {}", explain(&e)));
                break;
            }
        }
    }
    let _ = client.Stop();
    if let Ok(h) = mmcss {
        let _ = AvRevertMmThreadCharacteristics(h);
    }
    let _ = CloseHandle(event);
}

unsafe fn run_input(
    id: &str,
    rates: &[u32],
    frames: u32,
    make: impl FnOnce(&Format) -> Capture,
    on_error: &dyn Fn(String),
    stop: &AtomicBool,
    ready: Ready,
) {
    let (client, format, buffer, event) = match open(id, rates, frames) {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let setup = || -> Result<IAudioCaptureClient, String> {
        let capture: IAudioCaptureClient = client.GetService().map_err(|e| explain(&e))?;
        client.Start().map_err(|e| explain(&e))?;
        Ok(capture)
    };
    let capture = match setup() {
        Ok(c) => c,
        Err(e) => {
            let _ = CloseHandle(event);
            let _ = ready.send(Err(e));
            return;
        }
    };
    let lat = latency(&client, buffer, format.rate);
    let mut take = make(&format);
    let mut block = vec![0.0f32; buffer as usize * format.channels * 2];
    let _ = ready.send(Ok(Info { format, frames: buffer, latency: lat }));

    let mut task = 0u32;
    let mmcss = AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task);
    'run: while !stop.load(Relaxed) {
        if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 {
            continue;
        }
        loop {
            match capture.GetNextPacketSize() {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => {
                    on_error(format!("Micro: {}", explain(&e)));
                    break 'run;
                }
            }
            let (mut data, mut n, mut flags) = (ptr::null_mut(), 0u32, 0u32);
            if let Err(e) = capture.GetBuffer(&mut data, &mut n, &mut flags, None, None) {
                on_error(format!("Micro: {}", explain(&e)));
                break 'run;
            }
            let len = n as usize * format.channels;
            if block.len() < len {
                block.resize(len, 0.0);
            }
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                block[..len].fill(0.0);
            } else {
                read(data, &mut block[..len], format.sample);
            }
            take(&block[..len], lat);
            let _ = capture.ReleaseBuffer(n);
        }
    }
    let _ = client.Stop();
    if let Ok(h) = mmcss {
        let _ = AvRevertMmThreadCharacteristics(h);
    }
    let _ = CloseHandle(event);
}

unsafe fn write(p: *mut u8, src: &[f32], sample: Sample) {
    for (i, &x) in src.iter().enumerate() {
        let x = x.clamp(-1.0, 1.0);
        match sample {
            Sample::F32 => (p as *mut f32).add(i).write_unaligned(x),
            Sample::I32 => (p as *mut i32).add(i).write_unaligned((x as f64 * i32::MAX as f64) as i32),
            Sample::I24 => {
                let b = ((x * 8_388_607.0) as i32).to_le_bytes();
                ptr::copy_nonoverlapping(b.as_ptr(), p.add(i * 3), 3);
            }
            Sample::I16 => (p as *mut i16).add(i).write_unaligned((x * i16::MAX as f32) as i16),
        }
    }
}

unsafe fn read(p: *const u8, dst: &mut [f32], sample: Sample) {
    for (i, d) in dst.iter_mut().enumerate() {
        *d = match sample {
            Sample::F32 => (p as *const f32).add(i).read_unaligned(),
            Sample::I32 => (p as *const i32).add(i).read_unaligned() as f32 / 2_147_483_648.0,
            Sample::I24 => {
                let q = p.add(i * 3);
                // Sign-extend from the top byte.
                (i32::from_le_bytes([0, *q, *q.add(1), *q.add(2)]) >> 8) as f32 / 8_388_608.0
            }
            Sample::I16 => (p as *const i16).add(i).read_unaligned() as f32 / 32_768.0,
        };
    }
}
