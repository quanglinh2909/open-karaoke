pub mod audio;
mod meta;
mod tools;
mod youtube;

use audio::analysis::{self, KeyEstimate};
use audio::engine::{self, AudioStatus, Buf, DeviceChoice, DeviceList, Engine, Track};
use audio::separate::{Growing, GrowingWriter, Separator, MODEL, MODEL_RATE};
use ringbuf::traits::Consumer;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

struct Dirs {
    tools: PathBuf,
    cache: PathBuf,
    /// Separated instrumental/vocal stems, so repeat songs start instantly.
    stems: PathBuf,
    recordings: PathBuf,
}

#[derive(Default)]
struct Song {
    /// The original recording the song is built from.
    source: Option<PathBuf>,
    /// YouTube id of `source`; names its cached stems.
    source_id: Option<String>,
    /// Decoded, untransformed audio at `sr` (None while separating).
    inst: Option<Arc<Vec<f32>>>,
    /// The isolated original vocal, used as a guide.
    guide: Option<Arc<Vec<f32>>>,
    key: Option<KeyEstimate>,
    semitones: f32,
    tempo: f32,
    sr: u32,
    vocal_removed: bool,
    /// Length in frames while the separator is still running.
    separating: Option<u64>,
    /// The UI's id for the separation that built this song.
    job: u32,
}

struct AppState {
    engine: Arc<Engine>,
    dirs: Dirs,
    song: Mutex<Song>,
    /// Bumped whenever the loaded audio changes; stale background work is dropped.
    generation: Arc<AtomicU32>,
    /// The AI model, loaded once and reused for every song.
    separator: Arc<Mutex<Option<Separator>>>,
    /// Separations running, per recording. They go on when their song is
    /// closed, and a reopened song attaches to its own.
    separations: Mutex<std::collections::HashMap<String, Arc<Separation>>>,
    /// Whisper transcripts, per recording and prompt.
    heard_jobs: Jobs<Vec<audio::transcribe::HeardLine>>,
    /// The aligner's view of each recording's vocal, so lyric variants can
    /// be compared without re-running the model.
    emission_jobs: Jobs<audio::align::Emissions>,
    /// Lyric analyses run one recording at a time, in the order requested.
    lyric_queue: Arc<tokio::sync::Semaphore>,
    /// Songs being opened right now; lyric analysis waits so they load fast.
    opening: AtomicU32,
    /// The original singer's melody per recording, once found: drives
    /// the note bars and scoring against the melody.
    melodies: Mutex<std::collections::HashMap<String, Arc<Vec<audio::melody::Note>>>>,
}

/// Counts a song being opened for as long as it lives.
struct Opening<'a>(&'a AtomicU32);

impl<'a> Opening<'a> {
    fn start(n: &'a AtomicU32) -> Self {
        n.fetch_add(1, Relaxed);
        Self(n)
    }
}

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Relaxed);
    }
}

/// One slow analysis of a recording (Whisper, the aligner's model). At most
/// one runs per key: a reloaded page or a reopened song waits for the same
/// run and is shown its progress so far. Results are also kept on disk, so
/// a recording is only ever analysed once.
struct Job<T> {
    result: tokio::sync::OnceCell<Arc<T>>,
    /// Latest progress, 0–1, as `f32` bits.
    progress: AtomicU32,
    /// Waiting for its turn in the lyric queue.
    queued: AtomicBool,
    running: AtomicBool,
    /// Set to stop it (the user pressed Stop, or deleted the recording).
    cancelled: AtomicBool,
    /// Wakes it if it is still waiting in the queue when stopped.
    stop: tokio::sync::Notify,
}

type Jobs<T> = Mutex<std::collections::HashMap<String, Arc<Job<T>>>>;

fn job<T>(jobs: &Jobs<T>, key: &str) -> Arc<Job<T>> {
    jobs.lock()
        .unwrap()
        .entry(key.to_string())
        .or_insert_with(|| {
            Arc::new(Job {
                result: tokio::sync::OnceCell::new(),
                progress: AtomicU32::new(0),
                queued: AtomicBool::new(false),
                running: AtomicBool::new(false),
                cancelled: AtomicBool::new(false),
                stop: tokio::sync::Notify::new(),
            })
        })
        .clone()
}

impl<T> Job<T> {
    /// Record progress and tell the UI.
    fn report(&self, app: &AppHandle, event: &str, source: &str, fraction: f32) {
        self.progress.store(fraction.to_bits(), Relaxed);
        let _ = app.emit(event, AlignProgress { source: source.to_string(), fraction });
    }

    /// Show a newly attached caller where a running job already is.
    fn replay(&self, app: &AppHandle, event: &str, source: &str) {
        if self.running.load(Relaxed) {
            let _ = app.emit(event, AlignProgress { source: source.to_string(), fraction: f32::from_bits(self.progress.load(Relaxed)) });
        }
    }

    /// Run `work` unless a result exists or another caller is already
    /// running it (then wait for that). Failed runs leave no result.
    async fn run<F: std::future::Future<Output = Res<T>>>(&self, work: F) -> Res<Arc<T>> {
        let r = self
            .result
            .get_or_try_init(|| async {
                self.progress.store(0, Relaxed);
                self.cancelled.store(false, Relaxed);
                self.running.store(true, Relaxed);
                let r = work.await.map(Arc::new);
                self.running.store(false, Relaxed);
                self.queued.store(false, Relaxed);
                r
            })
            .await?;
        Ok(r.clone())
    }

    /// Wait for this job's turn in the lyric queue (first come, first
    /// served); stopping it while it waits takes it out of the queue.
    async fn turn(&self, queue: &Arc<tokio::sync::Semaphore>) -> Res<tokio::sync::OwnedSemaphorePermit> {
        self.queued.store(true, Relaxed);
        let permit = tokio::select! {
            p = queue.clone().acquire_owned() => p.map_err(|e| e.to_string()),
            _ = self.stop.notified() => Err("cancelled".into()),
        };
        self.queued.store(false, Relaxed);
        if self.cancelled.load(Relaxed) {
            return Err("cancelled".into());
        }
        permit
    }

    fn cancel(&self) {
        self.cancelled.store(true, Relaxed);
        self.stop.notify_waiters();
    }
}

/// Stop a recording's lyric analysis, queued or running, so others go
/// first. Nothing is cached; starting it again begins from the start.
#[tauri::command]
fn cancel_lyrics(state: State<'_, AppState>, source: String) {
    let prefix = format!("{source}.");
    for (k, j) in state.heard_jobs.lock().unwrap().iter() {
        if k.starts_with(&prefix) {
            j.cancel();
        }
    }
    if let Some(j) = state.emission_jobs.lock().unwrap().get(&source) {
        j.cancel();
    }
}

/// Smooth progress for work that only reports between long chunks: within
/// a chunk it advances at the speed measured so far, never past the chunk.
struct ProgressEstimate {
    audio_secs: f64,
    started: Instant,
    /// (done, next chunk end, when the chunk started), shares of the song.
    chunk: Mutex<(f32, f32, Instant)>,
}

impl ProgressEstimate {
    fn new(audio_secs: f64) -> Self {
        Self { audio_secs: audio_secs.max(1.0), started: Instant::now(), chunk: Mutex::new((0.0, 0.0, Instant::now())) }
    }

    fn chunk(&self, done: f32, next: f32) {
        *self.chunk.lock().unwrap() = (done, next, Instant::now());
    }

    fn now(&self) -> f32 {
        let (done, next, since) = *self.chunk.lock().unwrap();
        // Seconds of work per second of audio: measured once a chunk is
        // done, otherwise a typical CPU speed for large-v3-turbo.
        let rate = if done > 0.0 { self.started.elapsed().as_secs_f64() / (done as f64 * self.audio_secs) } else { 1.1 };
        let expected = ((next - done) as f64 * self.audio_secs * rate).max(1.0);
        done + (next - done) * (since.elapsed().as_secs_f64() / expected).min(0.95) as f32
    }
}

/// Checked between chunks of lyric analysis. While a song is being
/// separated it waits (the song being opened goes first, and nothing done so
/// far is lost); then it says whether to stop (the recording was deleted).
fn pause_or_stop(app: &AppHandle, cancelled: &AtomicBool) -> bool {
    loop {
        if cancelled.load(Relaxed) {
            return true;
        }
        let state = app.state::<AppState>();
        // A song being opened or separated gets the CPU first.
        // Only a separation that moved lately counts: one paused for the open
        // song's (or stuck) must not hold lyrics up forever.
        let separating = state.separations.lock().unwrap().values().any(|s| s.last_progress.lock().unwrap().elapsed() < Duration::from_secs(15));
        if state.opening.load(Relaxed) == 0 && !separating {
            return false;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// What a lyric job for one recording is doing, for the home screen.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LyricJob {
    source: String,
    /// "queued", "listen" (Whisper) or "time" (the aligner).
    stage: &'static str,
    fraction: f32,
}

/// Lyric analyses waiting or running for any of `sources`.
#[tauri::command]
fn lyric_jobs(state: State<'_, AppState>, sources: Vec<String>) -> Vec<LyricJob> {
    let of = |key: &str| sources.iter().find(|s| key == s.as_str() || key.starts_with(&format!("{s}."))).cloned();
    let mut out = Vec::new();
    let mut add = |key: &str, queued: bool, running: bool, progress: f32, stage: &'static str| {
        if let Some(source) = of(key).filter(|_| queued || running) {
            out.push(LyricJob { source, stage: if queued { "queued" } else { stage }, fraction: progress });
        }
    };
    for (key, j) in state.heard_jobs.lock().unwrap().iter() {
        add(key, j.queued.load(Relaxed), j.running.load(Relaxed), f32::from_bits(j.progress.load(Relaxed)), "listen");
    }
    for (key, j) in state.emission_jobs.lock().unwrap().iter() {
        add(key, j.queued.load(Relaxed), j.running.load(Relaxed), f32::from_bits(j.progress.load(Relaxed)), "time");
    }
    for (key, sep) in state.separations.lock().unwrap().iter() {
        add(key, false, true, sep.progress.lock().unwrap().0 as f32, "separate");
    }
    out
}

/// Forget a recording: its separated stems, downloaded audio and lyric
/// analyses (stopping any that run). The UI closes the song first if it is
/// loaded.
#[tauri::command]
fn delete_source(state: State<'_, AppState>, source: String) -> Res<()> {
    stem_paths(&state.dirs.stems, &source)?; // validates the id
    if state.song.lock().unwrap().source_id.as_deref() == Some(source.as_str()) {
        return Err("Hãy đóng bài hát trước khi xóa".into());
    }
    if let Some(sep) = state.separations.lock().unwrap().remove(&source) {
        sep.cancelled.store(true, Relaxed);
    }
    let prefix = format!("{source}.");
    state.heard_jobs.lock().unwrap().retain(|k, j| {
        let mine = k.starts_with(&prefix);
        if mine {
            j.cancel();
        }
        !mine
    });
    state.emission_jobs.lock().unwrap().retain(|k, j| {
        let mine = k == &source;
        if mine {
            j.cancel();
        }
        !mine
    });
    for dir in [&state.dirs.stems, &state.dirs.cache] {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

type Res<T> = Result<T, String>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SongInfo {
    duration: f64,
    source_duration: f64,
    key: Option<KeyEstimate>,
    semitones: f32,
    tempo: f32,
    has_guide: bool,
    separating: bool,
    vocal_removed: bool,
}

fn info(song: &Song) -> SongInfo {
    let frames = song
        .inst
        .as_ref()
        .map(|a| (a.len() / 2) as u64)
        .or(song.separating)
        .unwrap_or(0) as f64;
    let sr = song.sr.max(1) as f64;
    SongInfo {
        duration: frames / sr / song.tempo as f64,
        source_duration: frames / sr,
        key: song.key,
        semitones: song.semitones,
        tempo: song.tempo,
        has_guide: song.guide.is_some() || song.separating.is_some(),
        separating: song.separating.is_some(),
        vocal_removed: song.vocal_removed,
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Render the current song with its key/tempo settings and hand it to the
/// engine, keeping the musical position.
async fn apply_track(state: &AppState) -> Res<SongInfo> {
    let gen = state.generation.load(Relaxed);
    let (inst, guide, semis, tempo, sr) = {
        let s = state.song.lock().unwrap();
        if s.separating.is_some() {
            return Err("Đổi tông và nhịp độ được sau khi tách giọng xong.".into());
        }
        let Some(inst) = s.inst.clone() else { return Err("Chưa mở bài hát nào".into()) };
        (inst, s.guide.clone(), s.semitones, s.tempo, s.sr)
    };
    let old_tempo = {
        let t = state.engine.current_track();
        let frames = t.map(|t| t.frames()).unwrap_or(0) as f64;
        if frames > 0.0 {
            (inst.len() / 2) as f64 / frames
        } else {
            1.0
        }
    };
    let source_pos = state.engine.shared.position.load(Relaxed) as f64 * old_tempo;

    let (audio, guide) = blocking(move || {
        std::thread::scope(|sc| {
            let g = guide.as_ref().map(|g| sc.spawn(|| audio::stretch::render(g, sr, semis, tempo)));
            let a = audio::stretch::render(&inst, sr, semis, tempo);
            (a, g.map(|h| h.join().unwrap()))
        })
    })
    .await?;
    if state.generation.load(Relaxed) != gen {
        return Err("superseded".into());
    }
    let track = Track {
        audio: Buf::Full(Arc::new(audio)),
        guide: guide.map(|g| Buf::Full(Arc::new(g))),
        guide_offset: 0,
    };
    let pos = (source_pos / tempo as f64) as u64;
    state.engine.set_track(Some(Arc::new(track)), pos);
    Ok(info(&state.song.lock().unwrap()))
}

// ---------------------------------------------------------------- setup --

#[tauri::command]
fn tools_status(state: State<'_, AppState>) -> tools::ToolStatus {
    tools::status(&state.dirs.tools)
}

#[tauri::command]
async fn tools_install(app: AppHandle, state: State<'_, AppState>) -> Res<tools::ToolStatus> {
    tools::install(&app, &state.dirs.tools).await
}

// ------------------------------------------------------------- catalogue --

#[tauri::command]
async fn search_songs(query: String) -> Res<Vec<meta::SongMeta>> {
    meta::search_songs(query.trim()).await
}

#[tauri::command]
async fn get_lyrics(artist: String, title: String, album: String, duration: f64) -> Res<meta::Lyrics> {
    meta::lyrics(&artist, &title, &album, duration).await
}

#[tauri::command]
async fn yt_search(state: State<'_, AppState>, query: String, limit: u32) -> Res<Vec<youtube::Video>> {
    youtube::search(&state.dirs.tools, &query, limit).await
}

#[tauri::command]
async fn yt_download(app: AppHandle, state: State<'_, AppState>, id: String) -> Res<String> {
    youtube::download(&app, &state.dirs.tools, &state.dirs.cache, &id)
        .await
        .map(|p| p.to_string_lossy().into_owned())
}

/// The recording's video (≤1080p, picture only), for a video background
/// on stage and in the exported karaoke video.
#[tauri::command]
async fn yt_download_video(app: AppHandle, state: State<'_, AppState>, id: String) -> Res<String> {
    youtube::download_video(&app, &state.dirs.tools, &state.dirs.cache, &id)
        .await
        .map(|p| p.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ song --

fn stem_paths(dir: &Path, id: &str) -> Res<(PathBuf, PathBuf)> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Mã bản thu không hợp lệ".into());
    }
    Ok((dir.join(format!("{id}.instrumental.wav")), dir.join(format!("{id}.vocals.wav"))))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SeparateProgress {
    /// The caller's job id; events for any other job are stale.
    job: u32,
    fraction: f64,
    /// Seconds of the song that are ready to play.
    ready: f64,
    /// Separation speed relative to real time.
    speed: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SeparateDone {
    job: u32,
    info: SongInfo,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SeparateError {
    job: u32,
    message: String,
}

/// Build the karaoke track from the original recording: the AI model splits
/// it into instrumental and vocals. Returns as soon as playback can begin;
/// the rest is separated in the background ("separate://progress", then
/// "separate://done" or "separate://error"). Results are cached per source.
#[tauri::command]
async fn song_separate(app: AppHandle, state: State<'_, AppState>, path: String, id: String, job: u32) -> Res<SongInfo> {
    state.engine.pause();
    let _opening = Opening::start(&state.opening);
    let gen = state.generation.fetch_add(1, Relaxed) + 1;
    let sr = state.engine.sample_rate();
    let (inst_wav, vox_wav) = stem_paths(&state.dirs.stems, &id)?;
    let fresh = |s: &AppState| s.generation.load(Relaxed) == gen;

    if inst_wav.is_file() && vox_wav.is_file() {
        let (inst, vox, key) = blocking(move || -> Res<_> {
            // Both stems at once: about half the wait.
            let (inst, vox) = std::thread::scope(|sc| {
                let vox = sc.spawn(|| audio::decode::decode_file(&vox_wav, sr));
                let inst = audio::decode::decode_file(&inst_wav, sr);
                (inst, vox.join().unwrap_or_else(|_| Err("decode panicked".into())))
            });
            let (inst, vox) = (inst?, vox?);
            let full: Vec<f32> = inst.iter().zip(&vox).map(|(a, b)| a + b).collect();
            let key = analysis::detect_key(&analysis::mono(&full), sr);
            Ok((inst, vox, key))
        })
        .await??;
        if !fresh(&state) {
            return Err("superseded".into());
        }
        *state.song.lock().unwrap() = Song {
            source: Some(path.into()),
            source_id: Some(id),
            job,
            inst: Some(Arc::new(inst)),
            guide: Some(Arc::new(vox)),
            key: Some(key),
            semitones: 0.0,
            tempo: 1.0,
            sr,
            ..Default::default()
        };
        state.engine.set_track(None, 0);
        return apply_track(&state).await;
    }

    // Still being separated (the song was closed meanwhile): pick it up where
    // it is instead of starting over.
    let running = state.separations.lock().unwrap().get(&id).cloned();
    if let Some(sep) = running.filter(|s| s.sr == sr && !s.cancelled.load(Relaxed)) {
        sep.job.store(job, Relaxed);
        let info_now = {
            let mut s = state.song.lock().unwrap();
            *s = Song {
                source: Some(path.into()),
                source_id: Some(id),
                job,
                key: Some(sep.key.clone()),
                semitones: 0.0,
                tempo: 1.0,
                sr,
                separating: Some(sep.frames as u64),
                ..Default::default()
            };
            info(&s)
        };
        let track = Track { audio: Buf::Growing(sep.inst.clone()), guide: Some(Buf::Growing(sep.vox.clone())), guide_offset: 0 };
        state.engine.set_track(Some(Arc::new(track)), 0);
        // Catch the UI up with the progress so far.
        let (fraction, ready, speed) = *sep.progress.lock().unwrap();
        let _ = app.emit("separate://progress", SeparateProgress { job, fraction, ready, speed });
        return Ok(info_now);
    }

    if !audio::separate::AVAILABLE {
        return Err(audio::separate::UNAVAILABLE.into());
    }
    let model = tools::ensure_model(&app, &state.dirs.tools).await?;
    let p = PathBuf::from(&path);
    let (mix, key) = blocking(move || -> Res<_> {
        let mix = audio::decode::decode_file(&p, MODEL_RATE)?;
        let key = analysis::detect_key(&analysis::mono(&mix), MODEL_RATE);
        Ok((mix, key))
    })
    .await??;
    if !fresh(&state) {
        return Err("superseded".into());
    }

    let frames = ((mix.len() / 2) as f64 * sr as f64 / MODEL_RATE as f64).round() as usize;
    let (inst_buf, inst_w) = Growing::new(frames * 2);
    let (vox_buf, vox_w) = Growing::new(frames * 2);
    let info_now = {
        let mut s = state.song.lock().unwrap();
        *s = Song {
            source: Some(path.into()),
            source_id: Some(id.clone()),
            job,
            key: Some(key),
            semitones: 0.0,
            tempo: 1.0,
            sr,
            separating: Some(frames as u64),
            ..Default::default()
        };
        info(&s)
    };
    let track = Track { audio: Buf::Growing(inst_buf.clone()), guide: Some(Buf::Growing(vox_buf.clone())), guide_offset: 0 };
    state.engine.set_track(Some(Arc::new(track)), 0);

    let sep = Arc::new(Separation {
        inst: inst_buf.clone(),
        vox: vox_buf.clone(),
        frames,
        sr,
        key: key.clone(),
        job: AtomicU32::new(job),
        progress: Mutex::new((0.0, 0.0, 0.0)),
        cancelled: AtomicBool::new(false),
        last_progress: Mutex::new(Instant::now()),
    });
    state.separations.lock().unwrap().insert(id.clone(), sep.clone());
    let work = SeparationJob {
        app: app.clone(),
        id,
        sep,
        separator: state.separator.clone(),
        model,
        mix,
        sr,
        inst_w,
        vox_w,
        inst_buf,
        vox_buf,
        inst_wav,
        vox_wav,
    };
    std::thread::Builder::new()
        .name("vocal-separation".into())
        .spawn(move || work.run())
        .map_err(|e| e.to_string())?;
    Ok(info_now)
}

/// A vocal separation running for one recording. It goes on when its song
/// is closed (the stems are cached at the end), pauses while the open song's
/// own separation runs, and a reopened song attaches to it.
struct Separation {
    inst: Arc<Growing>,
    vox: Arc<Growing>,
    /// Song length in frames at `sr`.
    frames: usize,
    sr: u32,
    key: KeyEstimate,
    /// The UI job to report to: the latest load of this song.
    job: AtomicU32,
    /// (fraction, seconds ready, speed) so far, for a song attaching late.
    progress: Mutex<(f64, f64, f64)>,
    /// Set when the recording is deleted.
    cancelled: AtomicBool,
    /// When the model last finished a chunk: only a separation that is
    /// actually moving makes lyric analysis wait.
    last_progress: Mutex<Instant>,
}

/// Takes a recording off the running separations when its worker ends,
/// however it ends (a panic included), so nothing waits on it forever.
struct SeparationDone {
    app: AppHandle,
    id: String,
}

impl Drop for SeparationDone {
    fn drop(&mut self) {
        if let Ok(mut map) = self.app.state::<AppState>().separations.lock() {
            map.remove(&self.id);
        }
    }
}

struct SeparationJob {
    app: AppHandle,
    /// The recording (YouTube id).
    id: String,
    sep: Arc<Separation>,
    separator: Arc<Mutex<Option<Separator>>>,
    model: PathBuf,
    /// Interleaved stereo at [`MODEL_RATE`].
    mix: Vec<f32>,
    sr: u32,
    inst_w: GrowingWriter,
    vox_w: GrowingWriter,
    inst_buf: Arc<Growing>,
    vox_buf: Arc<Growing>,
    inst_wav: PathBuf,
    vox_wav: PathBuf,
}

impl SeparationJob {
    fn run(self) {
        let app = self.app.clone();
        let (id, sep) = (self.id.clone(), self.sep.clone());
        let _done = SeparationDone { app: app.clone(), id: id.clone() };
        let (inst_buf, vox_buf) = (self.inst_buf.clone(), self.vox_buf.clone());
        let result = self.separate();
        let state = app.state::<AppState>();
        state.separations.lock().unwrap().remove(&id);
        // Its song was closed: the stems are cached for next time, done.
        let open = {
            let s = state.song.lock().unwrap();
            s.source_id.as_deref() == Some(id.as_str()) && s.separating.is_some()
        };
        if !open {
            return;
        }
        let job = sep.job.load(Relaxed);
        let result = result.and_then(|()| {
            // Swap the growing buffers for regular ones so key/tempo changes
            // work; same samples, so playback doesn't skip.
            {
                let mut s = state.song.lock().unwrap();
                s.inst = Some(Arc::new(inst_buf.ready_slice().to_vec()));
                s.guide = Some(Arc::new(vox_buf.ready_slice().to_vec()));
                s.separating = None;
            }
            tauri::async_runtime::block_on(apply_track(&state))
        });
        match result {
            Ok(info) => {
                let _ = app.emit("separate://done", SeparateDone { job, info });
            }
            Err(e) if e == "cancelled" || e == "superseded" => {}
            Err(message) => {
                let _ = app.emit("separate://error", SeparateError { job, message });
            }
        }
    }

    fn separate(self) -> Res<()> {
        let Self { app, id, sep, separator, model, mix, sr, mut inst_w, mut vox_w, inst_wav, vox_wav, .. } = self;
        let state = app.state::<AppState>();
        let cached = separator.lock().unwrap().take();
        let mut model_sep = match cached {
            Some(sep) => sep,
            None => Separator::load(&model, MODEL.config)?,
        };
        let result = Self::stream(&app, &state, &mut model_sep, &id, &sep, &mix, sr, &mut inst_w, &mut vox_w);
        // Keep the model loaded for the next song, whatever happened.
        *separator.lock().unwrap() = Some(model_sep);
        let (inst_all, vox_all) = result?;
        inst_w.finish();
        vox_w.finish();
        // A failed cache write only costs time next play.
        let _ = audio::decode::write_wav(&inst_wav, &inst_all, MODEL_RATE)
            .and_then(|_| audio::decode::write_wav(&vox_wav, &vox_all, MODEL_RATE));
        Ok(())
    }

    /// Run the model over the song, streaming results into the playback
    /// buffers. Returns the full-rate stems for the cache.
    #[allow(clippy::too_many_arguments)]
    fn stream(
        app: &AppHandle,
        state: &AppState,
        model: &mut Separator,
        id: &str,
        sep: &Separation,
        mix: &[f32],
        sr: u32,
        inst_w: &mut GrowingWriter,
        vox_w: &mut GrowingWriter,
    ) -> Res<(Vec<f32>, Vec<f32>)> {
        let mut rs_inst = audio::decode::StreamResampler::new(MODEL_RATE, sr)?;
        let mut rs_vox = audio::decode::StreamResampler::new(MODEL_RATE, sr)?;
        let mut inst_all = Vec::with_capacity(mix.len());
        let mut vox_all = Vec::with_capacity(mix.len());
        let (mut out, mut vox) = (Vec::new(), Vec::new());
        let started = Instant::now();
        let mut failure: Option<String> = None;
        model.run(mix, |seg, fraction| {
            // The open song's own separation goes first: wait while it runs.
            loop {
                if sep.cancelled.load(Relaxed) {
                    return false;
                }
                let open = state.song.lock().unwrap().source_id.clone();
                let other = open.is_some_and(|o| o != id && state.separations.lock().unwrap().contains_key(&o));
                if !other {
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
            let base = inst_all.len();
            vox.clear();
            vox.extend(seg.iter().enumerate().map(|(i, &v)| mix[base + i] - v));
            inst_all.extend_from_slice(seg);
            vox_all.extend_from_slice(&vox);
            for (rs, src, w) in [(&mut rs_inst, seg, &mut *inst_w), (&mut rs_vox, &vox[..], &mut *vox_w)] {
                if let Err(e) = rs.push(src, &mut out) {
                    failure = Some(e);
                    return false;
                }
                w.append(&out);
            }
            let ready = inst_all.len() as f64 / 2.0 / MODEL_RATE as f64;
            let speed = ready / started.elapsed().as_secs_f64().max(1e-3);
            *sep.progress.lock().unwrap() = (fraction as f64, ready, speed);
            *sep.last_progress.lock().unwrap() = Instant::now();
            let job = sep.job.load(Relaxed);
            let _ = app.emit("separate://progress", SeparateProgress { job, fraction: fraction as f64, ready, speed });
            true
        })
        .map_err(|e| failure.clone().unwrap_or(e))?;
        rs_inst.flush(&mut out)?;
        inst_w.append(&out);
        rs_vox.flush(&mut out)?;
        vox_w.append(&out);
        Ok((inst_all, vox_all))
    }
}

/// Which of these sources already have separated stems on disk (their
/// songs start instantly).
#[tauri::command]
fn stems_cached(state: State<'_, AppState>, ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .filter(|id| stem_paths(&state.dirs.stems, id).map(|(i, v)| i.is_file() && v.is_file()).unwrap_or(false))
        .collect()
}

/// Loudness of the separated vocal in `VOCAL_HOP` steps (RMS, linear), used
/// to line the lyrics up with the recording. None until separation finishes,
/// and for the basic remover, whose "guide" is the full mix.
#[tauri::command]
async fn vocal_activity(state: State<'_, AppState>) -> Res<Option<Vec<f32>>> {
    let (guide, sr) = {
        let s = state.song.lock().unwrap();
        if s.vocal_removed || s.separating.is_some() {
            return Ok(None);
        }
        match &s.guide {
            Some(g) => (g.clone(), s.sr),
            None => return Ok(None),
        }
    };
    blocking(move || {
        let hop = ((sr as f64 * VOCAL_HOP) as usize).max(1) * 2;
        Some(
            guide
                .chunks(hop)
                .map(|c| (c.iter().map(|x| x * x).sum::<f32>() / c.len() as f32).sqrt())
                .collect(),
        )
    })
    .await
}

/// Seconds per `vocal_activity` value.
const VOCAL_HOP: f64 = 0.05;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AlignProgress {
    /// The recording being analysed (the UI shows only its current song's).
    source: String,
    fraction: f32,
}

/// The aligner's model output for `source`, from disk or computed. `mono`
/// is its vocal if already at hand; `in_turn` when the caller already holds
/// the lyric queue (otherwise this waits for a turn).
async fn emissions_of(app: AppHandle, source: String, mono: Option<Arc<Vec<f32>>>, in_turn: bool) -> Res<Arc<audio::align::Emissions>> {
    let state = app.state::<AppState>();
    let job = job(&state.emission_jobs, &source);
    job.replay(&app, "align://progress", &source);
    let file = state.dirs.stems.join(format!("{source}.mms"));
    let tools_dir = state.dirs.tools.clone();
    let queue = state.lyric_queue.clone();
    let vocal = if mono.is_some() { None } else { Some(separated_vocal(&state, &source)?) };
    job.run(async {
        if let Some(em) = std::fs::read(&file).ok().and_then(|b| audio::align::Emissions::from_bytes(&b)) {
            return Ok(em);
        }
        let _turn = if in_turn { None } else { Some(job.turn(&queue).await?) };
        let model = tools::ensure_align_model(&app, &tools_dir).await?;
        let (app, job, src) = (app.clone(), job.clone(), source.clone());
        let em = blocking(move || -> Res<_> {
            let mono = match (mono, vocal) {
                (Some(m), _) => m,
                (None, Some(v)) => Arc::new(v.mono_16k()?),
                (None, None) => unreachable!(),
            };
            let mut aligner = audio::align::Aligner::load(&model)?;
            aligner.emissions(&mono, |f| job.report(&app, "align://progress", &src, f), || pause_or_stop(&app, &job.cancelled))
        })
        .await??;
        let _ = std::fs::write(&file, em.to_bytes());
        Ok(em)
    })
    .await
}

/// Time every lyric word against the separated vocal (forced alignment).
/// `lines` hold romanized words (a–z, apostrophes); the result mirrors them,
/// None where a word had no letters or could not be placed.
#[tauri::command]
/// `windows`: where speech recognition heard each line (seconds), to keep
/// the aligner near it.
async fn align_lyrics(
    app: AppHandle,
    source: String,
    lines: Vec<Vec<String>>,
    windows: Option<Vec<Option<(f64, f64)>>>,
) -> Res<Vec<Vec<Option<audio::align::WordTime>>>> {
    let em = emissions_of(app, source, None, false).await?;
    let windows = windows.unwrap_or_default();
    blocking(move || audio::align::align_lines_within(&em, &lines, &windows, audio::align::STAR_PENALTY)).await?
}

/// Write down what the singer actually sings (Whisper on the separated
/// vocal), phrase by phrase with rough word times. `prompt` is the
/// published lyrics, which prime Whisper with the song's words.
///
/// Recordings take turns in the lyric queue in the order they were opened;
/// a turn covers Whisper and the aligner's model, so one song's lyrics are
/// finished before the next song's start.
/// The original singer's melody as notes (seconds in the recording,
/// fractional MIDI), from the separated vocal. About a second for a song;
/// kept on disk, so each recording is analysed once.
#[tauri::command]
async fn melody_notes(app: AppHandle, state: State<'_, AppState>, source: String) -> Res<Vec<audio::melody::Note>> {
    if let Some(n) = state.melodies.lock().unwrap().get(&source) {
        return Ok(n.to_vec());
    }
    let file = state.dirs.stems.join(format!("{source}.melody.json"));
    let notes: Vec<audio::melody::Note> = match std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(n) => n,
        None => {
            let vocal = separated_vocal(&state, &source)?;
            let model = tools::ensure_melody_model(&app, &state.dirs.tools).await?;
            let notes = blocking(move || -> Res<_> {
                let mono = vocal.mono_16k()?;
                let contour = audio::melody::Tracker::load(&model)?.contour(&mono)?;
                Ok(audio::melody::notes(&contour, audio::melody::NOTE_HOLD_MS))
            })
            .await??;
            let _ = std::fs::write(&file, serde_json::to_vec(&notes).unwrap_or_default());
            notes
        }
    };
    state.melodies.lock().unwrap().insert(source, Arc::new(notes.clone()));
    Ok(notes)
}

#[tauri::command]
async fn transcribe_vocal(app: AppHandle, state: State<'_, AppState>, source: String, prompt: Option<String>) -> Res<Vec<audio::transcribe::HeardLine>> {
    use sha2::{Digest, Sha256};
    let vocal = separated_vocal(&state, &source)?;
    let digest = Sha256::digest(prompt.as_deref().unwrap_or("").as_bytes());
    let key = format!("{source}.{}", digest.iter().take(4).map(|b| format!("{b:02x}")).collect::<String>());
    let job = job(&state.heard_jobs, &key);
    job.replay(&app, "transcribe://progress", &source);
    // "heard2": since chunks Whisper fills with an invention are heard again.
    let file = state.dirs.stems.join(format!("{key}.heard2.json"));
    let tools_dir = state.dirs.tools.clone();
    let queue = state.lyric_queue.clone();
    let heard = job
        .run(async {
            if let Some(h) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
                return Ok(h);
            }
            let _turn = job.turn(&queue).await?;
            let model = tools::ensure_whisper_model(&app, &tools_dir).await?;
            let mono = Arc::new(blocking(move || vocal.mono_16k()).await??);
            let (app2, job2, src, mono2) = (app.clone(), job.clone(), source.clone(), mono.clone());
            let heard = blocking(move || -> Res<_> {
                let estimate = ProgressEstimate::new(mono2.len() as f64 / 16_000.0);
                let finished = AtomicBool::new(false);
                std::thread::scope(|scope| {
                    // Whisper is silent within a chunk (~30 s of work), so the
                    // bar moves on an estimate from the speed so far.
                    scope.spawn(|| {
                        while !finished.load(Relaxed) {
                            job2.report(&app2, "transcribe://progress", &src, estimate.now());
                            std::thread::sleep(Duration::from_millis(500));
                        }
                    });
                    let r = audio::transcribe::transcribe(
                        &model,
                        &mono2,
                        prompt.as_deref(),
                        |done, next| estimate.chunk(done, next),
                        || pause_or_stop(&app2, &job2.cancelled),
                    );
                    finished.store(true, Relaxed);
                    r
                })
            })
            .await??;
            let _ = std::fs::write(&file, serde_json::to_vec(&heard).unwrap_or_default());
            // Still in this turn: get the aligner's model output ready too.
            let _ = emissions_of(app.clone(), source.clone(), Some(mono), true).await;
            Ok(heard)
        })
        .await?;
    Ok(heard.as_ref().clone())
}

/// A recording's AI-separated vocal: in memory if it is the loaded song,
/// otherwise its cached stem (so analysis can go on from the home screen).
enum Vocal {
    Loaded(Arc<Vec<f32>>, u32),
    Stem(PathBuf),
}

impl Vocal {
    /// 16 kHz mono, what both speech models hear.
    fn mono_16k(self) -> Res<Vec<f32>> {
        match self {
            Vocal::Loaded(stereo, sr) => vocal_16k(&stereo, sr),
            Vocal::Stem(path) => Ok(analysis::mono(&audio::decode::decode_file(&path, 16_000)?)),
        }
    }
}

fn separated_vocal(state: &AppState, source: &str) -> Res<Vocal> {
    {
        let s = state.song.lock().unwrap();
        if s.source_id.as_deref() == Some(source) && !s.vocal_removed && s.separating.is_none() {
            if let Some(g) = &s.guide {
                return Ok(Vocal::Loaded(g.clone(), s.sr));
            }
        }
    }
    let (_, vocals) = stem_paths(&state.dirs.stems, source)?;
    if vocals.is_file() {
        Ok(Vocal::Stem(vocals))
    } else {
        Err("Cần giọng hát đã tách bằng AI".into())
    }
}

/// Interleaved stereo at `sr` → 16 kHz mono, what both speech models hear.
fn vocal_16k(stereo: &[f32], sr: u32) -> Res<Vec<f32>> {
    let mut rs = audio::decode::StreamResampler::new(sr, 16_000)?;
    let (mut a, mut b) = (Vec::new(), Vec::new());
    rs.push(stereo, &mut a)?;
    rs.flush(&mut b)?;
    a.extend_from_slice(&b);
    Ok(audio::analysis::mono(&a))
}

/// Fallback when the AI model can't run: a basic centre-channel remover.
#[tauri::command]
async fn song_vocal_removal(state: State<'_, AppState>, path: String) -> Res<SongInfo> {
    state.engine.pause();
    let gen = state.generation.fetch_add(1, Relaxed) + 1;
    let sr = state.engine.sample_rate();
    let p = PathBuf::from(&path);
    let (inst, guide, key) = blocking(move || -> Res<_> {
        let guide = audio::decode::decode_file(&p, sr)?;
        let inst = analysis::remove_center(&guide, sr);
        let key = analysis::detect_key(&analysis::mono(&guide), sr);
        Ok((inst, guide, key))
    })
    .await??;
    if state.generation.load(Relaxed) != gen {
        return Err("superseded".into());
    }
    *state.song.lock().unwrap() = Song {
        source: Some(path.into()),
        inst: Some(Arc::new(inst)),
        guide: Some(Arc::new(guide)),
        key: Some(key),
        semitones: 0.0,
        tempo: 1.0,
        sr,
        vocal_removed: true,
        ..Default::default()
    };
    state.engine.set_track(None, 0);
    apply_track(&state).await
}

#[tauri::command]
async fn song_transform(state: State<'_, AppState>, semitones: f32, tempo: f32) -> Res<SongInfo> {
    {
        let mut s = state.song.lock().unwrap();
        if s.separating.is_some() {
            return Err("Đổi tông và nhịp độ được sau khi tách giọng xong.".into());
        }
        s.semitones = semitones.clamp(-12.0, 12.0);
        s.tempo = tempo.clamp(0.5, 1.5);
    }
    apply_track(&state).await
}

#[tauri::command]
fn song_unload(state: State<'_, AppState>) {
    state.generation.fetch_add(1, Relaxed);
    state.engine.pause();
    state.engine.set_track(None, 0);
    *state.song.lock().unwrap() = Song::default();
}

// ------------------------------------------------------------- transport --

#[tauri::command]
fn transport_play(state: State<'_, AppState>) {
    state.engine.play();
}

#[tauri::command]
fn transport_pause(state: State<'_, AppState>) {
    state.engine.pause();
}

#[tauri::command]
fn transport_seek(state: State<'_, AppState>, seconds: f64) {
    let sr = state.engine.sample_rate() as f64;
    state.engine.seek_frames((seconds.max(0.0) * sr) as u64);
}

#[tauri::command]
fn set_params(state: State<'_, AppState>, params: Vec<(String, f32)>) -> Vec<String> {
    params
        .into_iter()
        .filter(|(k, v)| !state.engine.shared.params.set(k, *v))
        .map(|(k, _)| k)
        .collect()
}

// ----------------------------------------------------------------- audio --

#[tauri::command]
fn audio_devices() -> DeviceList {
    engine::list_devices()
}

#[tauri::command]
fn audio_latency(state: State<'_, AppState>) -> engine::LatencyReport {
    state.engine.latency()
}

#[tauri::command]
async fn audio_open(
    app: AppHandle,
    state: State<'_, AppState>,
    input: Option<String>,
    output: Option<String>,
    buffer: Option<u32>,
    exclusive: Option<bool>,
    asio: Option<String>,
) -> Res<AudioStatus> {
    let engine = state.engine.clone();
    let exclusive = exclusive.unwrap_or(false);
    let status = blocking(move || engine.open(DeviceChoice { input, output, buffer, exclusive, asio })).await??;
    // A new device may run at a different rate; rebuild the song if so.
    let reload = {
        let s = state.song.lock().unwrap();
        let loaded = s.inst.is_some() || s.separating.is_some();
        (loaded && s.sr != status.sample_rate).then(|| (s.source.clone(), s.source_id.clone(), s.vocal_removed, s.job))
    };
    if let Some((Some(source), id, removed, job)) = reload {
        let source = source.to_string_lossy().into_owned();
        match (removed, id) {
            (false, Some(id)) => {
                // Same job id, so the UI keeps following its progress.
                song_separate(app, state.clone(), source, id, job).await?;
            }
            _ => {
                song_vocal_removal(state.clone(), source).await?;
            }
        }
    }
    Ok(status)
}

#[tauri::command]
fn audio_status(state: State<'_, AppState>) -> AudioStatus {
    state.engine.status()
}

#[tauri::command]
fn record_start(state: State<'_, AppState>, name: String) -> Res<String> {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_()".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .chars()
        .take(100)
        .collect();
    let mut path = state.dirs.recordings.join(format!("{safe}.wav"));
    let mut n = 2;
    while path.exists() {
        path = state.dirs.recordings.join(format!("{safe} ({n}).wav"));
        n += 1;
    }
    state.engine.start_recording(path.clone())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn record_stop(state: State<'_, AppState>) -> Res<Option<String>> {
    Ok(state.engine.stop_recording()?.map(|p| p.to_string_lossy().into_owned()))
}

// ------------------------------------------------------------- voice lab --

#[tauri::command]
fn lab_record(state: State<'_, AppState>) -> Res<()> {
    state.engine.lab_record()
}

#[tauri::command]
fn lab_stop_record(state: State<'_, AppState>) -> Res<f64> {
    state.engine.lab_stop_record()
}

#[tauri::command]
fn lab_play(state: State<'_, AppState>, looped: bool) -> Res<()> {
    state.engine.lab_play(looped)
}

#[tauri::command]
fn lab_stop(state: State<'_, AppState>) {
    state.engine.lab_stop();
}

#[tauri::command]
fn lab_bypass(state: State<'_, AppState>, on: bool) {
    state.engine.shared.lab_bypass.store(on, Relaxed);
}

/// Render the take through the current settings and save it as a WAV.
#[tauri::command]
async fn lab_export(state: State<'_, AppState>) -> Res<String> {
    let take = state.engine.lab_take().ok_or("Hãy thu một đoạn trước")?;
    let sr = state.engine.sample_rate();
    let shared = state.engine.shared.clone();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = state.dirs.recordings.join(format!("Voice Lab take {stamp}.wav"));
    let out = path.clone();
    blocking(move || -> Res<()> {
        let mut chain = audio::chain::VocalChain::new(sr as f32);
        // Flush the chain's latency with a little silence at the end.
        let mut input = (*take).clone();
        input.extend(std::iter::repeat(0.0).take(sr as usize / 2));
        let mut stereo = Vec::new();
        chain.process(&input, &mut stereo, &shared.params, |_| {});
        let skip = chain.latency() * 2;
        if let Some(dir) = out.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let spec = hound::WavSpec { channels: 2, sample_rate: sr, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&out, spec).map_err(|e| e.to_string())?;
        for &x in stereo.iter().skip(skip) {
            w.write_sample((x.clamp(-1.0, 1.0) * 8_388_607.0) as i32).map_err(|e| e.to_string())?;
        }
        w.finalize().map_err(|e| e.to_string())
    })
    .await??;
    Ok(path.to_string_lossy().into_owned())
}

/// The open song's instrumental as played (current key and tempo), for
/// video export: the sample rate as a little-endian u32, then interleaved
/// stereo f32 samples.
#[tauri::command]
fn export_audio(state: State<'_, AppState>) -> Res<tauri::ipc::Response> {
    if state.song.lock().unwrap().separating.is_some() {
        return Err("Đợi tách giọng xong rồi mới xuất video được.".into());
    }
    let track = state.engine.current_track().ok_or("Chưa mở bài hát nào")?;
    let samples = track.audio.ready();
    let mut bytes = Vec::with_capacity(4 + samples.len() * 4);
    bytes.extend_from_slice(&state.engine.sample_rate().to_le_bytes());
    for x in samples {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Start writing an exported video into the recordings folder: returns the
/// path of its `.part` file, which `video_write` fills as the muxer produces
/// data and `video_finish` renames to the final `.mp4`. Writing as it goes
/// keeps a long Full HD export (hundreds of MB) out of memory and out of a
/// single IPC call.
#[tauri::command]
fn video_begin(state: State<'_, AppState>, name: String) -> Res<String> {
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_()".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .chars()
        .take(100)
        .collect();
    let safe = if safe.is_empty() { "Karaoke".to_string() } else { safe };
    std::fs::create_dir_all(&state.dirs.recordings).map_err(|e| e.to_string())?;
    let mut n = 1;
    let path = loop {
        let base = if n == 1 { safe.clone() } else { format!("{safe} ({n})") };
        let (mp4, part) = (state.dirs.recordings.join(format!("{base}.mp4")), state.dirs.recordings.join(format!("{base}.mp4.part")));
        if !mp4.exists() && !part.exists() {
            break part;
        }
        n += 1;
    };
    std::fs::File::create(&path).map_err(|e| format!("Không lưu được video: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The `.part` file named in the `x-path` header, if it is one of ours.
fn video_part(state: &AppState, request: &tauri::ipc::Request<'_>) -> Res<PathBuf> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).map(percent_decode).map(PathBuf::from).ok_or("Thiếu đường dẫn video")?;
    let inside = path.parent() == Some(state.dirs.recordings.as_path());
    if !inside || !path.to_string_lossy().ends_with(".mp4.part") {
        return Err("Đường dẫn video không hợp lệ".into());
    }
    Ok(path)
}

/// Write a piece of an exported video (raw body) at byte `x-pos`.
#[tauri::command]
fn video_write(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<()> {
    use std::io::{Seek, SeekFrom, Write};
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dữ liệu video không hợp lệ".into());
    };
    let path = video_part(&state, &request)?;
    let pos: u64 = request.headers().get("x-pos").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).ok_or("Thiếu vị trí ghi")?;
    let mut file = std::fs::OpenOptions::new().write(true).open(&path).map_err(|e| format!("Không lưu được video: {e}"))?;
    file.seek(SeekFrom::Start(pos)).and_then(|_| file.write_all(bytes)).map_err(|e| format!("Không lưu được video: {e}"))
}

/// Finish an exported video: the `.part` becomes the `.mp4`. Returns its path.
#[tauri::command]
fn video_finish(state: State<'_, AppState>, path: String) -> Res<String> {
    let part = PathBuf::from(&path);
    if part.parent() != Some(state.dirs.recordings.as_path()) || !path.ends_with(".mp4.part") {
        return Err("Đường dẫn video không hợp lệ".into());
    }
    let mp4 = part.with_extension("");
    std::fs::rename(&part, &mp4).map_err(|e| format!("Không lưu được video: {e}"))?;
    Ok(mp4.to_string_lossy().into_owned())
}

/// Drop an unfinished export (cancelled or failed).
#[tauri::command]
fn video_abort(state: State<'_, AppState>, path: String) {
    let part = PathBuf::from(&path);
    if part.parent() == Some(state.dirs.recordings.as_path()) && path.ends_with(".mp4.part") {
        let _ = std::fs::remove_file(part);
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn recordings_dir(state: State<'_, AppState>) -> Res<String> {
    std::fs::create_dir_all(&state.dirs.recordings).map_err(|e| e.to_string())?;
    Ok(state.dirs.recordings.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ tick --

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tick {
    pos: f64,
    duration: f64,
    playing: bool,
    ended: bool,
    recording: bool,
    mic: f32,
    out: f32,
    /// [song seconds, sung MIDI, corrected MIDI, target note, voiced 0/1]
    pitch: Vec<(f64, f32, f32, i32, u8)>,
    score: Score,
    /// Voice Lab: [state, position s, length s]
    lab: (u32, f64, f64),
    /// Waiting for the vocal separator to catch up.
    buffering: bool,
    /// Seconds of the song ready to play.
    ready: f64,
    error: Option<String>,
}

#[derive(Serialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
struct Score {
    /// 0..100, average in-tune-ness of everything sung.
    accuracy: f32,
    /// Seconds of voiced singing counted.
    sung: f32,
    points: u32,
    streak: u32,
}

fn spawn_ticker(app: AppHandle, engine: Arc<Engine>, generation: Arc<AtomicU32>) {
    std::thread::Builder::new()
        .name("ui-ticker".into())
        .spawn(move || {
            let mut score = Score::default();
            let mut acc_sum = 0.0f64;
            let mut seen_gen = generation.load(Relaxed);
            let mut last_pos = 0u64;
            let mut held = 0u32;
            loop {
                std::thread::sleep(Duration::from_millis(33));
                let sh = &engine.shared;
                let sr = sh.sample_rate.load(Relaxed).max(1) as f64;
                let playing = sh.flags.playing.load(Relaxed);
                let pos = sh.position.load(Relaxed);
                // New song or rewound to the start: fresh score.
                let gen = generation.load(Relaxed);
                if gen != seen_gen || (pos < last_pos && pos < sr as u64) {
                    seen_gen = gen;
                    score = Score::default();
                    acc_sum = 0.0;
                }
                last_pos = pos;

                // The melody to score against, if this recording's is known:
                // its notes, and how the song is shifted (key, tempo).
                let melody = {
                    let state = app.state::<AppState>();
                    let s = state.song.lock().unwrap();
                    s.source_id.as_ref().and_then(|id| state.melodies.lock().unwrap().get(id).cloned()).map(|m| (m, s.semitones, s.tempo))
                };
                // The singer sings to what they heard: the music played a
                // moment before the voice reached the input.
                let late = engine.latency().total_ms / 1000.0;

                let mut pitch = Vec::new();
                if let Some(cons) = engine.frames.lock().unwrap().as_mut() {
                    while let Some(f) = cons.try_pop() {
                        let fr = f.frame;
                        // Distance to the note to sing: the melody's note at
                        // this moment (any octave, so a man can sing a woman's
                        // part), or the nearest note of the key without one.
                        let target = melody.as_ref().map(|(notes, semis, tempo)| {
                            let t = ((f.pos as f64 / sr) as f32 - late) * tempo;
                            audio::melody::note_at(notes, t, 0.12).map(|n| n.midi + semis)
                        });
                        let dev = match target {
                            Some(Some(note)) => (fr.input - note + 6.0).rem_euclid(12.0) - 6.0,
                            _ => fr.input - fr.target as f32,
                        }
                        .abs();
                        // Where the melody rests, singing isn't scored.
                        let scored = !matches!(target, Some(None));
                        if fr.voiced && playing && scored {
                            let acc = (1.0 - dev / 0.5).clamp(0.0, 1.0);
                            acc_sum += acc as f64;
                            score.sung += 0.004;
                            if acc > 0.6 {
                                held += 1;
                                score.points += 1 + (score.streak / 100).min(4);
                                if held % 25 == 0 {
                                    score.streak += 1;
                                }
                            } else {
                                held = 0;
                                score.streak = 0;
                            }
                        }
                        pitch.push((f.pos as f64 / sr, fr.input, fr.output, fr.target, fr.voiced as u8));
                    }
                }
                let voiced_frames = (score.sung / 0.004).max(1.0) as f64;
                score.accuracy = (acc_sum / voiced_frames * 100.0) as f32;

                let tick = Tick {
                    pos: pos as f64 / sr,
                    duration: sh.length.load(Relaxed) as f64 / sr,
                    playing,
                    ended: sh.ended.load(Relaxed),
                    recording: sh.flags.recording.load(Relaxed),
                    mic: sh.mic_peak.get(),
                    out: sh.out_peak.get(),
                    pitch,
                    score,
                    buffering: sh.buffering.load(Relaxed),
                    ready: engine.current_track().map(|t| t.ready_frames()).unwrap_or(0) as f64 / sr,
                    lab: (
                        sh.lab_state.load(Relaxed),
                        sh.lab_pos.load(Relaxed) as f64 / sr,
                        sh.lab_len.load(Relaxed) as f64 / sr,
                    ),
                    error: sh.stream_error.lock().unwrap().take(),
                };
                if app.emit("engine://tick", tick).is_err() {
                    break;
                }
            }
        })
        .expect("spawn ticker");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Panics go to `crash.log` in the app data folder: an installed build has
/// no console, and this is the only trace of what went wrong.
fn log_panics(data: PathBuf) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let _ = std::fs::create_dir_all(&data);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(data.join("crash.log")) {
            let thread = std::thread::current().name().unwrap_or("?").to_string();
            let when = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = writeln!(f, "[{when}] thread '{thread}' {info}
{}", std::backtrace::Backtrace::force_capture());
        }
        default(info);
    }));
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = app.path();
            let data = paths.app_data_dir()?;
            log_panics(data.clone());
            let cache = paths.app_cache_dir()?.join("audio");
            let stems = paths.app_cache_dir()?.join("stems");
            let recordings = paths
                .audio_dir()
                .map(|d| d.join("Open Karaoke"))
                .unwrap_or_else(|_| data.join("recordings"));
            let dirs = Dirs { tools: data.join("bin"), cache: cache.clone(), stems: stems.clone(), recordings };
            std::fs::create_dir_all(&dirs.tools)?;
            std::fs::create_dir_all(&dirs.cache)?;
            std::fs::create_dir_all(&dirs.stems)?;
            // A full installer ships the tools and models: adopt them before
            // the UI asks whether setup is needed.
            if let Ok(res) = paths.resource_dir() {
                tools::adopt_bundled(&res, &dirs.tools);
            }

            let engine = Engine::new();
            let generation = Arc::new(AtomicU32::new(0));
            spawn_ticker(app.handle().clone(), engine.clone(), generation.clone());

            let tools_dir = dirs.tools.clone();
            tauri::async_runtime::spawn(async move {
                youtube::prune_cache(&cache, 3 * 1024 * 1024 * 1024);
                youtube::prune_cache(&stems, 3 * 1024 * 1024 * 1024);
                tools::maybe_update_ytdlp(&tools_dir).await;
            });

            app.manage(AppState {
                engine,
                dirs,
                song: Mutex::new(Song::default()),
                generation,
                separator: Arc::new(Mutex::new(None)),
                separations: Mutex::default(),
                heard_jobs: Mutex::default(),
                emission_jobs: Mutex::default(),
                lyric_queue: Arc::new(tokio::sync::Semaphore::new(1)),
                opening: AtomicU32::new(0),
                melodies: Mutex::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tools_status,
            tools_install,
            search_songs,
            get_lyrics,
            yt_search,
            yt_download,
            song_separate,
            stems_cached,
            vocal_activity,
            align_lyrics,
            transcribe_vocal,
            melody_notes,
            yt_download_video,
            lyric_jobs,
            cancel_lyrics,
            delete_source,
            song_vocal_removal,
            song_transform,
            song_unload,
            transport_play,
            transport_pause,
            transport_seek,
            set_params,
            audio_devices,
            audio_open,
            audio_latency,
            audio_status,
            record_start,
            record_stop,
            lab_record,
            lab_stop_record,
            lab_play,
            lab_stop,
            lab_bypass,
            lab_export,
            recordings_dir,
            export_audio,
            video_begin,
            video_write,
            video_finish,
            video_abort,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Open Karaoke");
}
