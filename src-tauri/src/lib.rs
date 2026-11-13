pub mod audio;
mod fastvideo;
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
    /// The UI's saved state (library, settings), one file per key: shared by
    /// the dev build and the installed app, whose webviews keep separate
    /// localStorage (another origin each).
    store: PathBuf,
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
    /// Automatic harmony made from `guide` for the whole song (untransformed,
    /// like it); `backing` is it limited to `backing_parts` (all of it when
    /// there are none). And the scale steps it was made with.
    backing_raw: Option<Arc<Vec<f32>>>,
    backing: Option<Arc<Vec<f32>>>,
    /// Parts of the recording (seconds) to harmonise, and parts the original
    /// singer sings (a duet's other voice): `lead` is `guide` there only.
    backing_parts: Vec<(f64, f64)>,
    /// `(start, full_from, full_to, end, start_voice, end_voice)`: the
    /// original singer at full from `full_from` to `full_to`; before and after
    /// that (reaching into a line the user sings, where a duet overlaps) only
    /// one voice is kept: 0 the part's own singer, 1 the female, 2 the male.
    original_parts: Vec<(f64, f64, f64, f64, u8, u8)>,
    lead: Option<Arc<Vec<f32>>>,
    /// The singer's melody as notes (for keeping only the sung voice), once fetched.
    melody: Arc<Vec<audio::melody::Note>>,
    backing_degrees: Vec<i32>,
    /// "choir" (a synthesised "ooh") or "voice" (the singer's own, shifted).
    backing_style: String,
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
    /// ffmpeg encoding an exported video (Linux: WebKitGTK's WebCodecs crash).
    encoder: Mutex<Option<std::process::Child>>,
    /// The export's still background as yuv420p, when the lyrics are laid on
    /// it here (a still picture: ffmpeg then only encodes).
    encoder_still: Mutex<Option<Vec<u8>>>,
    /// The fast export of a lyric video over a still picture, while recorded.
    fast: Mutex<Option<FastExport>>,
    fast_cancel: Arc<std::sync::atomic::AtomicBool>,
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
    let (inst, guide, backing, lead, semis, tempo, sr) = {
        let s = state.song.lock().unwrap();
        if s.separating.is_some() {
            return Err("Đổi tông và nhịp độ được sau khi tách giọng xong.".into());
        }
        let Some(inst) = s.inst.clone() else { return Err("Chưa mở bài hát nào".into()) };
        (inst, s.guide.clone(), s.backing.clone(), s.lead.clone(), s.semitones, s.tempo, s.sr)
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

    let (audio, guide, backing, lead) = blocking(move || {
        std::thread::scope(|sc| {
            let g = guide.as_ref().map(|g| sc.spawn(|| audio::stretch::render(g, sr, semis, tempo)));
            let b = backing.as_ref().map(|b| sc.spawn(|| audio::stretch::render(b, sr, semis, tempo)));
            let l = lead.as_ref().map(|l| sc.spawn(|| audio::stretch::render(l, sr, semis, tempo)));
            let a = audio::stretch::render(&inst, sr, semis, tempo);
            (a, g.map(|h| h.join().unwrap()), b.map(|h| h.join().unwrap()), l.map(|h| h.join().unwrap()))
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
        backing: backing.map(|b| Buf::Full(Arc::new(b))),
        lead: lead.map(|l| Buf::Full(Arc::new(l))),
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
async fn search_lyrics(title: String, artist: String, duration: f64) -> Res<Vec<meta::LyricCandidate>> {
    meta::search_lyrics(&title, &artist, duration).await
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
        let track = Track { audio: Buf::Growing(sep.inst.clone()), guide: Some(Buf::Growing(sep.vox.clone())), guide_offset: 0, backing: None, lead: None };
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
    let track = Track { audio: Buf::Growing(inst_buf.clone()), guide: Some(Buf::Growing(vox_buf.clone())), guide_offset: 0, backing: None, lead: None };
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
    lrc: Option<Vec<Option<f64>>>,
) -> Res<Vec<Vec<Option<audio::align::WordTime>>>> {
    let em = emissions_of(app, source, None, false).await?;
    let windows = windows.unwrap_or_default();
    blocking(move || {
        use audio::align::{align_lines_guided, align_lines_within, STAR_PENALTY};
        // No heard windows but the published line times: let those guide.
        match lrc {
            Some(lrc) if windows.iter().all(Option::is_none) => align_lines_guided(&em, &lines, &lrc, STAR_PENALTY),
            _ => align_lines_within(&em, &lines, &windows, STAR_PENALTY),
        }
    })
    .await?
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

/// The beat of a recording (its separated instrumental): tempo and beat
/// times, for countdowns on the beat. Kept on disk, so each recording is
/// analysed once (a second or two).
#[tauri::command]
async fn song_beats(state: State<'_, AppState>, source: String) -> Res<audio::beats::Beats> {
    let (inst, _) = stem_paths(&state.dirs.stems, &source)?;
    let file = state.dirs.stems.join(format!("{source}.beats.json"));
    // (Files saved before the loudness was added are made again.)
    if let Some(b) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<audio::beats::Beats>(&b).ok()).filter(|b| !b.energy.is_empty()) {
        return Ok(b);
    }
    if !inst.is_file() {
        return Err("Chưa có nhạc nền đã tách".into());
    }
    let beats = blocking(move || -> Res<_> {
        const SR: u32 = 22_050;
        let stereo = audio::decode::decode_file(&inst, SR)?;
        let mono: Vec<f32> = stereo.chunks(2).map(|c| 0.5 * (c[0] + c.get(1).copied().unwrap_or(c[0]))).collect();
        Ok(audio::beats::track(&mono, SR))
    })
    .await??;
    let _ = std::fs::write(&file, serde_json::to_vec(&beats).unwrap_or_default());
    Ok(beats)
}

/// The chords of the open song's instrumental, for the harmony to sing
/// chord notes. Kept on disk next to the stems (about a second the first time).
async fn song_chords(state: &AppState) -> Vec<audio::chords::Chord> {
    let (inst, sr, key, source) = {
        let s = state.song.lock().unwrap();
        (s.inst.clone(), s.sr, s.key.clone(), s.source_id.clone())
    };
    let file = source.as_ref().map(|id| state.dirs.stems.join(format!("{id}.chords.json")));
    if let Some(c) = file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()) {
        return c;
    }
    let Some(inst) = inst else { return Vec::new() };
    let key = key.map(|k| (k.tonic, k.minor));
    let chords = blocking(move || audio::chords::detect(&inst, 2, sr, key)).await.unwrap_or_default();
    if let Some(f) = file.filter(|_| !chords.is_empty()) {
        let _ = std::fs::write(f, serde_json::to_vec(&chords).unwrap_or_default());
    }
    chords
}

#[tauri::command]
async fn transcribe_vocal(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    prompt: Option<String>,
    language: Option<String>,
) -> Res<Vec<audio::transcribe::HeardLine>> {
    use sha2::{Digest, Sha256};
    let vocal = separated_vocal(&state, &source)?;
    // Vietnamese songs: the lyrics fine-tune, if it has been installed.
    let vi_model = state.dirs.tools.join("models").join(audio::transcribe::MODEL_VI_LYRICS);
    let vi_model = (language.as_deref() == Some("vi") && vi_model.is_file()).then_some(vi_model);
    // The cache key covers what changes the result. Turbo on Vietnamese
    // keeps the old key (the prompt alone), so earlier results stay valid.
    let mut what = prompt.clone().unwrap_or_default();
    if vi_model.is_some() || language.as_deref() != Some("vi") {
        let model = if vi_model.is_some() { audio::transcribe::MODEL_VI_LYRICS } else { audio::transcribe::MODEL.file };
        what = format!("{what}\0{model}\0{}", language.as_deref().unwrap_or("auto"));
    }
    let digest = Sha256::digest(what.as_bytes());
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
            let model = match vi_model {
                Some(m) => m,
                None => tools::ensure_whisper_model(&app, &tools_dir).await?,
            };
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
                        language.as_deref(),
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
            // A failure here is the aligner's to report later, but a stop is
            // the user's: end the fit now (what was heard is already on disk).
            if let Err(e) = emissions_of(app.clone(), source.clone(), Some(mono), true).await {
                if e == "cancelled" {
                    return Err(e);
                }
            }
            if job.cancelled.load(Relaxed) {
                return Err("cancelled".into());
            }
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
        .map(|c| if c.is_alphanumeric() || " -_(),#%".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .chars()
        .take(160)
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
/// Make (or drop, with no `degrees`) the automatic harmony from the open
/// song's separated vocal: one voice per scale step in `degrees` (+2 = a
/// third above), in the song's detected key. Takes a few seconds; kept until
/// the song changes, and follows key and tempo changes.
#[tauri::command]
async fn song_backing(app: AppHandle, state: State<'_, AppState>, degrees: Vec<i32>, style: Option<String>) -> Res<()> {
    let style = style.unwrap_or_else(|| "choir".into());
    let gen = state.generation.load(Relaxed);
    let degrees: Vec<i32> = degrees.into_iter().filter(|d| *d != 0).collect();
    let (guide, key, sr) = {
        let s = state.song.lock().unwrap();
        if s.backing_degrees == degrees && s.backing_style == style && (s.backing_raw.is_some() || degrees.is_empty()) {
            return Ok(());
        }
        if degrees.is_empty() {
            (None, None, s.sr)
        } else {
            if s.separating.is_some() {
                return Err("Bè tự động có sau khi tách giọng xong.".into());
            }
            let Some(guide) = s.guide.clone().filter(|_| !s.vocal_removed) else {
                return Err("Bè tự động cần giọng ca sĩ đã tách bằng AI.".into());
            };
            (Some(guide), s.key.clone(), s.sr)
        }
    };
    let (tonic, minor) = key.map(|k| (k.tonic as i32, k.minor)).unwrap_or((0, false));
    let degrees2 = degrees.clone();
    let style2 = style.clone();
    // The singer's melody as notes, so each harmony note follows a whole sung
    // note (cached after the first time; without it the harmony still works).
    let source = state.song.lock().unwrap().source_id.clone();
    let notes = match (&guide, source) {
        (Some(_), Some(id)) => melody_notes(app.clone(), app.state::<AppState>(), id).await.unwrap_or_default(),
        _ => Vec::new(),
    };
    let original = style == "original";
    if guide.is_some() && style == "choir" && notes.is_empty() {
        return Err("Chưa dò được giai điệu của bài nên chưa tạo được bè hợp xướng.".into());
    }
    // The record's own backing vocals, split from the singer's (minutes the
    // first time, then from the cache).
    let id = state.song.lock().unwrap().source_id.clone();
    let own = match (&guide, original, id) {
        (Some(_), true, Some(id)) => Some(original_backing(&app, &state, &id, sr).await?),
        (Some(_), true, None) => return Err("Bè gốc cần bản thu đã tách giọng.".into()),
        _ => None,
    };
    if state.generation.load(Relaxed) != gen {
        return Err("superseded".into());
    }
    let chords = if guide.is_some() && !original { song_chords(&state).await } else { Vec::new() };
    let parts = state.song.lock().unwrap().backing_parts.clone();
    let made = blocking(move || {
        guide.map(|g| {
            let raw = Arc::new(if let Some(mut b) = own {
                // On the vocal's timeline, as long as it.
                b.resize(g.len(), 0.0);
                b
            } else if style2 == "voice" {
                audio::backing::harmony(&g, sr, tonic, minor, &degrees2, &notes, &chords)
            } else {
                audio::backing::choir(g.len() / 2, sr, tonic, minor, &degrees2, &notes, &chords)
            });
            let layer = backing_layer(&raw, sr, &parts, &style2);
            (raw, layer, parts)
        })
    })
    .await?;
    if state.generation.load(Relaxed) != gen {
        return Err("superseded".into());
    }
    let stale = {
        let mut s = state.song.lock().unwrap();
        let stale = made.as_ref().is_some_and(|m| m.2 != s.backing_parts);
        s.backing_raw = made.as_ref().map(|m| m.0.clone());
        s.backing = made.map(|m| m.1);
        s.backing_degrees = degrees;
        s.backing_style = style;
        stale
    };
    // The parts changed while it was being made: cut it to the new ones.
    if stale {
        refresh_backing(&state).await?;
    }
    swap_layers(&state).await
}

/// Progress of splitting a recording's backing vocals (`backing://progress`).
#[derive(Serialize, Clone)]
struct BackingProgress {
    source: String,
    fraction: f32,
}

/// The record's own backing vocals for `source`, at `sr`: its separated
/// vocal split by the karaoke model (`audio::karaoke`) into lead and
/// backing, kept as `<id>.backing.wav` in the stems dir. One at a time (the
/// model takes about 5 GB), on half the cores; minutes for a song.
async fn original_backing(app: &AppHandle, state: &AppState, source: &str, sr: u32) -> Res<Vec<f32>> {
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let (_, vocals) = stem_paths(&state.dirs.stems, source)?;
    let file = state.dirs.stems.join(format!("{source}.backing.wav"));
    let _turn = ONE.lock().await;
    if !file.is_file() {
        let model = state.dirs.tools.join("models").join(audio::karaoke::MODEL_FILE);
        if !model.is_file() {
            return Err("Chưa có mô hình tách bè gốc (tạo bằng scripts/export_karaoke.sh).".into());
        }
        if !vocals.is_file() {
            return Err("Chưa có giọng ca sĩ đã tách của bài.".into());
        }
        let (app2, id, out) = (app.clone(), source.to_string(), file.clone());
        blocking(move || -> Res<()> {
            let vocal = audio::decode::decode_file(&vocals, audio::karaoke::RATE)?;
            let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).div_ceil(2);
            let mut model = audio::karaoke::LeadSplitter::load(&model, threads)?;
            let mut last = -1.0f32;
            let parts = model.split(&vocal, |f| {
                if f - last >= 0.01 {
                    last = f;
                    let _ = app2.emit("backing://progress", BackingProgress { source: id.clone(), fraction: f });
                }
                true
            })?;
            // Written next to it first, so a stopped run leaves no half file.
            let tmp = out.with_extension("wav.part");
            audio::decode::write_wav(&tmp, &parts.backing, audio::karaoke::RATE)?;
            std::fs::rename(&tmp, &out).map_err(|e| e.to_string())
        })
        .await??;
    }
    let file2 = file.clone();
    blocking(move || audio::decode::decode_file(&file2, sr)).await?
}

/// `count` frames of gain: 1 inside `parts` (seconds), 0 outside. The short
/// fades that keep a part from clicking lie inside it, so nothing of it
/// reaches past its edges (into a line the user sings).
fn part_gain(count: usize, sr: u32, parts: &[(f64, f64)]) -> Vec<f32> {
    const FADE: f64 = 0.04;
    let fs = sr as f64;
    let mut g = vec![0.0f32; count];
    for &(a, b) in parts {
        let fade = FADE.min((b - a) / 2.0).max(1e-3);
        let (from, to) = ((a * fs).max(0.0) as usize, ((b * fs) as usize).min(count));
        for (f, x) in g.iter_mut().enumerate().take(to).skip(from) {
            let t = f as f64 / fs;
            let v = ((t - a) / fade).min((b - t) / fade).clamp(0.0, 1.0) as f32;
            *x = x.max(v);
        }
    }
    g
}

/// Stereo `buf` kept only in `parts`.
fn keep_parts(buf: &[f32], sr: u32, parts: &[(f64, f64)]) -> Vec<f32> {
    let gain = part_gain(buf.len() / 2, sr, parts);
    buf.chunks_exact(2).zip(gain).flat_map(|(c, g)| [c[0] * g, c[1] * g]).collect()
}

/// Rebuild the harmony from the chosen parts (the whole song when no part is
/// chosen for it). Cheap: done under the song's lock.
async fn refresh_backing(state: &AppState) -> Res<()> {
    let (raw, sr, parts, style) = {
        let s = state.song.lock().unwrap();
        (s.backing_raw.clone(), s.sr, s.backing_parts.clone(), s.backing_style.clone())
    };
    let Some(raw) = raw else {
        state.song.lock().unwrap().backing = None;
        return Ok(());
    };
    let layer = {
        let (raw, parts) = (raw.clone(), parts.clone());
        blocking(move || backing_layer(&raw, sr, &parts, &style)).await?
    };
    let mut s = state.song.lock().unwrap();
    // Only if nothing changed meanwhile (a newer call does its own).
    if s.backing_raw.as_ref().is_some_and(|r| Arc::ptr_eq(r, &raw)) && s.backing_parts == parts {
        s.backing = Some(layer);
    }
    Ok(())
}

/// The harmony as heard: `raw` kept to `parts` (all of it without any),
/// then mixed like recorded backing vocals (its room rings on past a part's
/// end, as a real one would).
fn backing_layer(raw: &[f32], sr: u32, parts: &[(f64, f64)], style: &str) -> Arc<Vec<f32>> {
    // The record's own backing is already mixed, and sings only where the
    // record has it: all of it, as it is.
    if style == "original" {
        return Arc::new(raw.to_vec());
    }
    let kept = if parts.is_empty() { None } else { Some(keep_parts(raw, sr, parts)) };
    Arc::new(audio::backing::polish(kept.as_deref().unwrap_or(raw), sr, style == "voice"))
}

/// Rebuild the original singer's layer from the chosen parts. Where a part
/// reaches into the user's lines (a duet's overlap) the duet model runs on
/// that stretch, so this takes a moment: outside the song's lock.
async fn refresh_lead(app: &AppHandle, state: &AppState) -> Res<()> {
    let gen = state.generation.load(Relaxed);
    let (guide, sr, parts, notes, removed) = {
        let s = state.song.lock().unwrap();
        (s.guide.clone(), s.sr, s.original_parts.clone(), s.melody.clone(), s.vocal_removed)
    };
    let lead = match guide {
        Some(g) if !parts.is_empty() && !removed => {
            let overlaps = parts.iter().any(|p| p.1 - p.0 > 0.02 || p.3 - p.2 > 0.02);
            // The male/female model, if it has been converted into the models
            // dir (scripts/export_male_female.py); else the pitch filter. (The
            // lead/backing model UVR KARA_2 was tried first: on a real overlap
            // it kept 94% of the input, so it doesn't split two lead singers.)
            let _ = app;
            let model = state.dirs.tools.join("models").join(audio::duet::MODEL_FILE);
            let model = (overlaps && model.is_file()).then_some(model);
            let stems = state.dirs.stems.clone();
            let source = state.song.lock().unwrap().source_id.clone().unwrap_or_default();
            Some(Arc::new(
                blocking(move || {
                    let cache = (!source.is_empty()).then(|| DuetCache { dir: &stems, source: &source });
                    lead_layer(&g, sr, &parts, &notes, model.as_deref(), cache)
                })
                .await?,
            ))
        }
        _ => None,
    };
    if state.generation.load(Relaxed) != gen {
        return Err("superseded".into());
    }
    state.song.lock().unwrap().lead = lead;
    Ok(())
}

/// The original singer in their parts: at full where the part is theirs
/// alone, and only their sung pitch where it reaches into a line the user
/// sings (a duet's overlap), crossfaded over the same 40 ms as the fades.
/// Where a duet's overlaps, split by the male/female model, are kept on disk:
/// `<dir>/<source>.duet.<sr>.<from_ms>-<to_ms>.v<voice>.f32` (raw little-endian f32).
struct DuetCache<'a> {
    dir: &'a Path,
    source: &'a str,
}

impl DuetCache<'_> {
    fn path(&self, sr: u32, a: f64, b: f64, voice: u8) -> PathBuf {
        self.dir.join(format!("{}.duet.{sr}.{}-{}.v{voice}.f32", self.source, (a * 1000.0).round(), (b * 1000.0).round()))
    }
    fn get(&self, sr: u32, a: f64, b: f64, voice: u8) -> Option<Vec<f32>> {
        let bytes = std::fs::read(self.path(sr, a, b, voice)).ok()?;
        Some(bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
    fn put(&self, sr: u32, a: f64, b: f64, voice: u8, x: &[f32]) {
        let bytes: Vec<u8> = x.iter().flat_map(|v| v.to_le_bytes()).collect();
        let _ = std::fs::write(self.path(sr, a, b, voice), bytes);
    }
}

fn lead_layer(
    g: &[f32],
    sr: u32,
    parts: &[(f64, f64, f64, f64, u8, u8)],
    notes: &[audio::melody::Note],
    duet: Option<&Path>,
    cache: Option<DuetCache>,
) -> Vec<f32> {
    const X: f64 = 0.04;
    /// How much of the part next to an overlap tells whose part it is.
    const REFERENCE: f64 = 2.0;
    let full: Vec<(f64, f64)> = parts.iter().map(|p| (p.1, p.2)).filter(|(a, b)| b > a).collect();
    let mut out = keep_parts(g, sr, &full);
    let fs = sr as f64;
    // Loaded only if an overlap isn't cached yet.
    let mut splitter: Option<Option<audio::duet::VoiceSplitter>> = None;
    for &(a, ha, hb, b, va, vb) in parts {
        // Each overlap, the stretch of the part beside it that is the singer's
        // alone, and which voice to keep there.
        let zones = [
            (ha - a > 0.02).then_some((a, ha + X, (ha, hb.min(ha + REFERENCE)), va)),
            (b - hb > 0.02).then_some((hb - X, b, (ha.max(hb - REFERENCE), hb), vb)),
        ];
        for (za, zb, reference, voice) in zones.into_iter().flatten() {
            let za = za.max(0.0);
            // The male/female model keeps the chosen voice (or the part's own
            // singer); cached per overlap and choice. The pitch filter is the fallback.
            let cached = cache.as_ref().and_then(|c| c.get(sr, za, zb, voice));
            let split = cached.or_else(|| {
                let sp = splitter.get_or_insert_with(|| duet.and_then(|m| audio::duet::VoiceSplitter::load(m).ok())).as_mut()?;
                let x = audio::isolate::split_duet(sp, g, sr, za, zb, reference, voice).ok()?;
                if let Some(c) = &cache {
                    c.put(sr, za, zb, voice, &x);
                }
                Some(x)
            });
            let iso = split.unwrap_or_else(|| audio::isolate::sung_only(g, sr, za, zb, notes));
            let start = (za * fs) as usize;
            for (k, pair) in iso.chunks_exact(2).enumerate() {
                let t = (start + k) as f64 / fs;
                let gain = ((t - za) / X).min((zb - t) / X).clamp(0.0, 1.0) as f32;
                if let Some(o) = out.get_mut(2 * (start + k)..2 * (start + k) + 2) {
                    o[0] += pair[0] * gain;
                    o[1] += pair[1] * gain;
                }
            }
        }
    }
    out
}

/// Put the song's harmony and original-singer layers, transformed to its key
/// and tempo, into the playing track (the rest of it stays as it is).
async fn swap_layers(state: &AppState) -> Res<()> {
    let gen = state.generation.load(Relaxed);
    let (backing, lead, sr, semis, tempo) = {
        let s = state.song.lock().unwrap();
        (s.backing.clone(), s.lead.clone(), s.sr, s.semitones, s.tempo)
    };
    let (backing, lead) = blocking(move || {
        std::thread::scope(|sc| {
            let b = backing.as_ref().map(|b| sc.spawn(|| audio::stretch::render(b, sr, semis, tempo)));
            let l = lead.as_ref().map(|l| audio::stretch::render(l, sr, semis, tempo));
            (b.map(|h| h.join().unwrap()), l)
        })
    })
    .await?;
    if state.generation.load(Relaxed) != gen {
        return Err("superseded".into());
    }
    if let Some(t) = state.engine.current_track() {
        let track = Track {
            audio: t.audio.clone(),
            guide: t.guide.clone(),
            guide_offset: t.guide_offset,
            backing: backing.map(|b| Buf::Full(Arc::new(b))),
            lead: lead.map(|l| Buf::Full(Arc::new(l))),
        };
        let pos = state.engine.shared.position.load(Relaxed);
        state.engine.set_track(Some(Arc::new(track)), pos);
    }
    Ok(())
}

/// Choose the parts (seconds in the recording) that get the harmony, and the
/// parts the original singer sings (a duet's other voice: the user sings the
/// rest). Empty harmony parts = the whole song.
#[tauri::command]
async fn song_parts(
    app: AppHandle,
    state: State<'_, AppState>,
    backing: Vec<(f64, f64)>,
    original: Vec<(f64, f64, f64, f64, u8, u8)>,
) -> Res<()> {
    // Parts reaching into the user's lines keep only the sung pitch there,
    // which needs the melody.
    let reaches = original.iter().any(|p| p.1 - p.0 > 0.02 || p.3 - p.2 > 0.02);
    let (need, source) = {
        let s = state.song.lock().unwrap();
        (reaches && s.melody.is_empty(), s.source_id.clone())
    };
    if let (true, Some(id)) = (need, source) {
        let notes = melody_notes(app.clone(), app.state::<AppState>(), id).await.unwrap_or_default();
        state.song.lock().unwrap().melody = Arc::new(notes);
    }
    {
        let mut s = state.song.lock().unwrap();
        if s.backing_parts == backing && s.original_parts == original {
            return Ok(());
        }
        if s.separating.is_some() && !original.is_empty() {
            return Err("Chọn đoạn giọng gốc được sau khi tách giọng xong.".into());
        }
        s.backing_parts = backing;
        s.original_parts = original;
    }
    refresh_backing(&state).await?;
    refresh_lead(&app, &state).await?;
    swap_layers(&state).await
}

/// The exported video's sound: the backing track as rendered (key, tempo),
/// with the automatic harmony and the original singer's parts at the levels
/// heard on stage. Interleaved stereo at the engine rate.
fn export_mix(state: &AppState) -> Res<Vec<f32>> {
    if state.song.lock().unwrap().separating.is_some() {
        return Err("Đợi tách giọng xong rồi mới xuất video được.".into());
    }
    let track = state.engine.current_track().ok_or("Chưa mở bài hát nào")?;
    let samples = track.audio.ready();
    let p = &state.engine.shared.params;
    let level = p.backing.get().clamp(0.0, 1.5) / p.instrumental.get().max(0.05);
    let backing = track.backing.as_ref().map(|b| b.ready()).filter(|_| level > 0.0).unwrap_or(&[]);
    let lead_level = p.lead.get().clamp(0.0, 1.5) / p.instrumental.get().max(0.05);
    let lead = track.lead.as_ref().map(|b| b.ready()).filter(|_| lead_level > 0.0).unwrap_or(&[]);
    let offset = track.guide_offset * 2;
    Ok(samples
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let j = usize::try_from(i as i64 - offset).ok();
            let h = j.and_then(|j| backing.get(j)).copied().unwrap_or(0.0);
            let l = j.and_then(|j| lead.get(j)).copied().unwrap_or(0.0);
            x + h * level + l * lead_level
        })
        .collect())
}

#[tauri::command]
fn export_audio(state: State<'_, AppState>) -> Res<tauri::ipc::Response> {
    let mix = export_mix(&state)?;
    let mut bytes = Vec::with_capacity(4 + mix.len() * 4);
    bytes.extend_from_slice(&state.engine.sample_rate().to_le_bytes());
    for x in mix {
        bytes.extend_from_slice(&x.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

// ------------------------------------------------- export through ffmpeg --
// WebKitGTK's WebCodecs (GStreamer 1.20 on Ubuntu 22.04) kills the web
// process the moment an encoder is touched ("gst_register_core_elements:
// code should not be reached"). There the webview draws the frames and
// ffmpeg encodes them: JPEG frames through its stdin, the sound from a WAV.

/// Whether ffmpeg with libx264 can be run.
#[tauri::command]
fn video_ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("libx264"))
        .unwrap_or(false)
}

/// The `.part` path if it is one of ours.
fn checked_part(state: &AppState, path: &str) -> Res<PathBuf> {
    let part = PathBuf::from(path);
    if part.parent() != Some(state.dirs.recordings.as_path()) || !path.ends_with(".mp4.part") {
        return Err("Đường dẫn video không hợp lệ".into());
    }
    Ok(part)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSound {
    sample_rate: u32,
    /// Frames skipped at the start (the start trim) and kept.
    first: usize,
    frames: usize,
    /// Whether the GPU encodes (the CPU is then free for drawing frames).
    hardware: bool,
}

/// The export's still layer (raw PNG body, `x-path` header: the `.part`
/// path): the whole background when there is no video, otherwise the shade
/// laid over the video. Sent before `video_ffmpeg_begin`.
#[tauri::command]
fn video_ffmpeg_backdrop(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dữ liệu ảnh nền không hợp lệ".into());
    };
    let part = video_part(&state, &request)?;
    // `x-format: yuv420p`: a still picture already in the video's format.
    let raw = request.headers().get("x-format").and_then(|v| v.to_str().ok()) == Some("yuv420p");
    std::fs::write(part.with_extension(if raw { "part.bg.yuv" } else { "part.bg.png" }), bytes).map_err(|e| e.to_string())
}

/// Write one yuv420p frame to `out`: the still background `still` (`w`×`h`)
/// with the lyric band (yuva420p planes of `rows` rows from row `y`, as
/// `video_ffmpeg_frame` gets them) laid over it; straight alpha, chroma by
/// the mean alpha of its 2×2 pixels, as ffmpeg's overlay does.
fn composite_still(still: &[u8], band: &[u8], w: usize, h: usize, y: usize, rows: usize, out: &mut impl std::io::Write) -> std::io::Result<()> {
    let n = w * rows;
    let (cw, ch) = (w / 2, h / 2);
    let (sy, su, sv) = (&still[..w * h], &still[w * h..w * h + cw * ch], &still[w * h + cw * ch..]);
    let (by, bu, bv, ba) = (&band[..n], &band[n..n + n / 4], &band[n + n / 4..n + n / 2], &band[n + n / 2..]);
    let mix = |f: u8, b: u8, a: u32| ((f as u32 * a + b as u32 * (255 - a) + 127) / 255) as u8;
    let mut row = vec![0u8; w];
    // Y: untouched rows straight from the still.
    out.write_all(&sy[..y * w])?;
    for r in 0..rows {
        let (s, f, a) = (&sy[(y + r) * w..(y + r + 1) * w], &by[r * w..(r + 1) * w], &ba[r * w..(r + 1) * w]);
        for x in 0..w {
            row[x] = if a[x] == 0 { s[x] } else { mix(f[x], s[x], a[x] as u32) };
        }
        out.write_all(&row)?;
    }
    out.write_all(&sy[(y + rows) * w..])?;
    // U and V: half size, alpha averaged over each 2×2 block.
    let (cy, crows) = (y / 2, rows / 2);
    for (sp, fp) in [(su, bu), (sv, bv)] {
        out.write_all(&sp[..cy * cw])?;
        for r in 0..crows {
            let (s, f) = (&sp[(cy + r) * cw..(cy + r + 1) * cw], &fp[r * cw..(r + 1) * cw]);
            for x in 0..cw {
                let at = |dr: usize, dc: usize| ba[(2 * r + dr) * w + 2 * x + dc] as u32;
                let a = (at(0, 0) + at(0, 1) + at(1, 0) + at(1, 1) + 2) / 4;
                row[x] = if a == 0 { s[x] } else { mix(f[x], s[x], a) };
            }
            out.write_all(&row[..cw])?;
        }
        out.write_all(&sp[(cy + crows) * cw..])?;
    }
    Ok(())
}

/// Keep a copy of the picture the user chose for the exported video's
/// background (raw body; `x-ext` its extension) in the cache, where the page
/// can read it, one per song. A new name each time (the webview caches by
/// URL); that song's previous copies go. Returns its path.
#[tauri::command]
fn export_image_save(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dữ liệu hình không hợp lệ".into());
    };
    let ext = request.headers().get("x-ext").and_then(|v| v.to_str().ok()).unwrap_or("img").to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].contains(&ext.as_str()) {
        return Err("Chỉ dùng được hình PNG, JPEG, WebP, GIF, BMP hoặc AVIF".into());
    }
    if bytes.is_empty() || bytes.len() > 64 << 20 {
        return Err("Hình rỗng hoặc quá lớn (tối đa 64 MB)".into());
    }
    // Each song its own picture (`x-song`: the song's id); only its older copies go.
    let song: String = request.headers().get("x-song").and_then(|v| v.to_str().ok()).unwrap_or("all").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    // (A dot ends the id: ids never hold one, so one song's prefix never matches another's.)
    let prefix = format!("export-background-{song}.");
    if let Ok(entries) = std::fs::read_dir(&state.dirs.cache) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = state.dirs.cache.join(format!("{prefix}{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("Không lưu được hình: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ store --

/// A store key as a file name: the UI's own keys only (`openkaraoke.*`).
fn store_file(state: &AppState, key: &str) -> Res<PathBuf> {
    if !key.starts_with("openkaraoke.") || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err("Khóa lưu trữ không hợp lệ".into());
    }
    Ok(state.dirs.store.join(format!("{key}.json")))
}

/// Every saved key and its value (the UI loads these before it starts).
#[tauri::command]
fn store_load(state: State<'_, AppState>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&state.dirs.store) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(key) = name.strip_suffix(".json").filter(|k| k.starts_with("openkaraoke.")) {
                if let Ok(v) = std::fs::read_to_string(e.path()) {
                    out.insert(key.to_string(), v);
                }
            }
        }
    }
    out
}

/// Save one key (written whole, then renamed: never half a file), or remove it.
#[tauri::command]
fn store_set(state: State<'_, AppState>, key: String, value: Option<String>) -> Res<()> {
    let path = store_file(&state, &key)?;
    match value {
        Some(v) => {
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, v).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("Không lưu được dữ liệu: {e}"))
        }
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    }
}

/// A line from the UI in the app's log (e.g. how long an export took).
#[tauri::command]
fn dev_log(state: State<'_, AppState>, text: String) {
    use std::io::Write;
    eprintln!("[ui] {text}");
    // Also kept in the cache dir's ui.log (the terminal may not be at hand).
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(state.dirs.cache.join("ui.log")) {
        let _ = writeln!(f, "{text}");
    }
}

/// One more piece of the looping background (raw MJPEG frames, `x-path`
/// header: the `.part` path), appended. Sent before `video_ffmpeg_begin`.
#[tauri::command]
fn video_ffmpeg_loop(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<()> {
    use std::io::Write;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Dữ liệu nền động không hợp lệ".into());
    };
    let part = video_part(&state, &request)?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(part.with_extension("part.loop.mjpeg"))
        .and_then(|mut f| f.write_all(bytes))
        .map_err(|e| e.to_string())
}

/// A VAAPI device (Intel/AMD GPU) that ffmpeg can encode H.264 with, found
/// once by a one-frame trial encode. The GPU takes the encoding (most of
/// ffmpeg's work) off the CPU, which then draws the lyric frames.
fn vaapi_device() -> Option<&'static str> {
    static DEVICE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    DEVICE
        .get_or_init(|| {
            if !cfg!(target_os = "linux") {
                return None;
            }
            let mut nodes: Vec<PathBuf> = std::fs::read_dir("/dev/dri")
                .ok()?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("renderD")))
                .collect();
            nodes.sort();
            nodes.into_iter().map(|p| p.to_string_lossy().into_owned()).find(|dev| {
                std::process::Command::new("ffmpeg")
                    .args(["-hide_banner", "-loglevel", "error", "-vaapi_device", dev])
                    .args(["-f", "lavfi", "-i", "color=c=black:s=1280x720", "-frames:v", "2"])
                    .args(["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", "17", "-f", "null", "-"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success())
            })
        })
        .as_deref()
}

/// What lies under the lyrics: the recording's video (path, from which
/// second, at what tempo), a short loop played over and over, or only the
/// still backdrop.
enum Under<'a> {
    Video(&'a Path, f64, f64),
    Loop(&'a Path),
    Still,
    /// Frames arrive whole (lyrics laid on a still picture here): only encode.
    Composited,
}
enum UnderKind {
    Composited,
    Other,
}

/// The ffmpeg arguments that composite the export. Inputs: what lies
/// `under`, the still `backdrop` (the shade over a video, the picture
/// itself when there is nothing under; a loop needs none), the lyric frames
/// (transparent PNGs on stdin) and the sound. Encoded on the GPU (`vaapi`)
/// or with x264.
fn ffmpeg_args(
    under: Under,
    backdrop: &Path,
    wav: &Path,
    out: &Path,
    (width, height, fps): (u32, u32, u32),
    vaapi: Option<&str>,
) -> Vec<std::ffi::OsString> {
    fn add(a: &mut Vec<std::ffi::OsString>, xs: &[&str]) {
        a.extend(xs.iter().map(std::ffi::OsString::from));
    }
    let rate = fps.to_string();
    let mut a: Vec<std::ffi::OsString> = Vec::new();
    add(&mut a, &["-hide_banner", "-loglevel", "error", "-y"]);
    if let Some(dev) = vaapi {
        add(&mut a, &["-vaapi_device", dev]);
    }
    let fit = |flags: &str| format!("scale={width}:{height}:force_original_aspect_ratio=increase:flags={flags},crop={width}:{height},setsar=1");
    let still = |a: &mut Vec<std::ffi::OsString>| {
        add(a, &["-loop", "1", "-framerate", &rate, "-i"]);
        a.push(backdrop.as_os_str().to_owned());
    };
    if let Under::Composited = under {
        let size = format!("{width}x{height}");
        add(&mut a, &["-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", &size, "-framerate", &rate, "-i", "pipe:0", "-i"]);
        a.push(wav.as_os_str().to_owned());
        add(&mut a, &["-map", "0:v", "-map", "1:a"]);
        if vaapi.is_some() {
            add(&mut a, &["-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-qp", "17", "-profile:v", "high"]);
        } else {
            add(&mut a, &["-c:v", "libx264", "-preset", "fast", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p"]);
        }
        add(&mut a, &["-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", "-f", "mp4"]);
        a.push(out.as_os_str().to_owned());
        return a;
    }
    // Inputs in order; `lyrics` is the index of the frames' input.
    let (base, lyrics) = match under {
        Under::Video(path, from, tempo) => {
            add(&mut a, &["-ss", &format!("{:.3}", from.max(0.0)), "-i"]);
            a.push(path.as_os_str().to_owned());
            still(&mut a);
            // The video runs at the song's tempo, holding its last picture if it ends early.
            let graph = format!(
                "[0:v]setpts=(PTS-STARTPTS)/{tempo:.6},fps={fps},{},tpad=stop_mode=clone:stop=-1[v];[v][1:v]overlay=format=auto[b];",
                fit("lanczos")
            );
            (graph, 2)
        }
        Under::Loop(path) => {
            add(&mut a, &["-stream_loop", "-1", "-f", "mjpeg", "-framerate", &rate, "-i"]);
            a.push(path.as_os_str().to_owned());
            // All soft light: a plain scale-up looks the same.
            (format!("[0:v]setpts=PTS-STARTPTS,fps={fps},{}[b];", fit("bilinear")), 1)
        }
        Under::Still => {
            still(&mut a);
            (format!("[0:v]{}[b];", fit("lanczos")), 1)
        }
        Under::Composited => unreachable!(),
    };
    let tail = if vaapi.is_some() { "format=nv12,hwupload" } else { "format=yuv420p" };
    let graph = format!("{base}[b][{lyrics}:v]overlay=shortest=1:format=yuv420,{tail}[out]");
    let size = format!("{width}x{height}");
    add(&mut a, &["-f", "rawvideo", "-pix_fmt", "yuva420p", "-s", &size, "-framerate", &rate, "-i", "pipe:0", "-i"]);
    a.push(wav.as_os_str().to_owned());
    let audio = format!("{}:a", lyrics + 1);
    add(&mut a, &["-filter_complex", &graph, "-map", "[out]", "-map", &audio]);
    if vaapi.is_some() {
        add(&mut a, &["-c:v", "h264_vaapi", "-qp", "17", "-profile:v", "high"]);
    } else {
        add(&mut a, &["-c:v", "libx264", "-preset", "fast", "-crf", "16", "-profile:v", "high", "-pix_fmt", "yuv420p"]);
    }
    add(&mut a, &["-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", "-f", "mp4"]);
    a.push(out.as_os_str().to_owned());
    a
}

/// Start ffmpeg writing `path` (from `video_begin`): `width`×`height` at
/// `fps`, with the export's sound between the trims (seconds of the rendered
/// track), over the backdrop sent first and, when `video` is given (a file in
/// the cache), that video from `video_from` seconds at `tempo`. Lyric frames
/// follow through `video_ffmpeg_frame`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn video_ffmpeg_begin(
    state: State<'_, AppState>,
    path: String,
    width: u32,
    height: u32,
    fps: u32,
    trim_start: f64,
    trim_end: f64,
    video: Option<String>,
    video_from: f64,
    tempo: f64,
    ambient: Option<bool>,
) -> Res<ExportSound> {
    use std::process::{Command, Stdio};
    let part = checked_part(&state, &path)?;
    let backdrop = part.with_extension("part.bg.png");
    // A still picture already in yuv420p: the lyrics are laid on it here.
    let still = std::fs::read(part.with_extension("part.bg.yuv")).ok().filter(|b| b.len() == (width * height * 3 / 2) as usize);
    if still.is_none() && !backdrop.exists() {
        return Err("Chưa có ảnh nền video".into());
    }
    let video = match video {
        Some(v) => {
            let v = PathBuf::from(v);
            if v.parent() != Some(state.dirs.cache.as_path()) || !v.is_file() {
                return Err("Video nền không hợp lệ".into());
            }
            Some(v)
        }
        None => None,
    };
    let mix = export_mix(&state)?;
    let sr = state.engine.sample_rate();
    let total = mix.len() / 2;
    let first = ((trim_start.max(0.0) * sr as f64).round() as usize).min(total);
    let last = total.saturating_sub((trim_end.max(0.0) * sr as f64).round() as usize).max(first);
    let wav = part.with_extension("part.wav");
    audio::decode::write_wav(&wav, &mix[2 * first..2 * last], sr)?;
    let log = std::fs::File::create(part.with_extension("part.log")).map_err(|e| e.to_string())?;
    let tempo = if tempo > 0.05 { tempo } else { 1.0 };
    let looped = part.with_extension("part.loop.mjpeg");
    let under = match (&video, ambient.unwrap_or(false)) {
        (Some(v), _) => Under::Video(v, video_from, tempo),
        (None, true) if looped.is_file() => Under::Loop(&looped),
        _ if still.is_some() => Under::Composited,
        _ => Under::Still,
    };
    let under_kind = if matches!(under, Under::Composited) { UnderKind::Composited } else { UnderKind::Other };
    let vaapi = vaapi_device();
    let args = ffmpeg_args(under, &backdrop, &wav, &part, (width, height, fps), vaapi);
    let child = Command::new("ffmpeg")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .map_err(|e| format!("Không chạy được ffmpeg: {e}"))?;
    if let Some(mut old) = state.encoder.lock().unwrap().replace(child) {
        let _ = old.kill();
    }
    let composited = matches!(under_kind, UnderKind::Composited);
    *state.encoder_still.lock().unwrap() = if composited { still } else { None };
    Ok(ExportSound { sample_rate: sr, first, frames: last - first, hardware: vaapi.is_some() })
}

/// One lyric frame for the running ffmpeg: the `x-rows` rows from row `x-y`
/// of a `x-w`×`x-h` yuva420p frame that hold anything, as planes Y, U, V, A
/// (raw body); the rest is transparent. Padded here into the whole frame
/// that ffmpeg reads (no image coding or colour conversion on its side).
#[tauri::command]
fn video_ffmpeg_frame(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<()> {
    use std::io::Write;
    static ZEROS: [u8; 1 << 16] = [0; 1 << 16];
    let header = |k: &str| -> Res<usize> {
        request.headers().get(k).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).ok_or_else(|| format!("Thiếu {k}"))
    };
    let (y, rows, w, h) = (header("x-y")?, header("x-rows")?, header("x-w")?, header("x-h")?);
    let band: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => &[],
    };
    let n = w * rows;
    if y % 2 != 0 || rows % 2 != 0 || w % 2 != 0 || h % 2 != 0 || y + rows > h || band.len() != n * 2 + n / 2 {
        return Err("Dữ liệu khung hình không hợp lệ".into());
    }
    let mut enc = state.encoder.lock().unwrap();
    let stdin = enc.as_mut().and_then(|c| c.stdin.as_mut()).ok_or("Chưa bắt đầu xuất video")?;
    // On a still background the lyrics are laid on it here: a plain frame for ffmpeg.
    if let Some(still) = state.encoder_still.lock().unwrap().as_deref() {
        if still.len() != w * h * 3 / 2 {
            return Err("Ảnh nền không khớp khung hình".into());
        }
        let mut out = std::io::BufWriter::with_capacity(1 << 20, &mut *stdin);
        return composite_still(still, band, w, h, y, rows, &mut out)
            .and_then(|_| out.flush())
            .map_err(|e| format!("ffmpeg dừng giữa chừng: {e}"));
    }
    let zeros = |out: &mut std::process::ChildStdin, mut n: usize| -> std::io::Result<()> {
        while n > 0 {
            let k = n.min(ZEROS.len());
            out.write_all(&ZEROS[..k])?;
            n -= k;
        }
        Ok(())
    };
    // Each plane: blank rows above, the band's rows, blank rows below.
    let (cw, cy, crows, ch) = (w / 2, y / 2, rows / 2, h / 2);
    let planes = [(w, y, rows, h, 0, n), (cw, cy, crows, ch, n, n / 4), (cw, cy, crows, ch, n + n / 4, n / 4), (w, y, rows, h, n + n / 2, n)];
    (|| -> std::io::Result<()> {
        for (pw, py, prows, ph, at, len) in planes {
            zeros(stdin, pw * py)?;
            stdin.write_all(&band[at..at + len])?;
            zeros(stdin, pw * (ph - py - prows))?;
        }
        Ok(())
    })()
    .map_err(|e| format!("ffmpeg dừng giữa chừng: {e}"))
}

/// End the frames, wait for ffmpeg and keep the video. Returns its path.
#[tauri::command]
async fn video_ffmpeg_finish(state: State<'_, AppState>, path: String) -> Res<String> {
    let part = checked_part(&state, &path)?;
    let child = state.encoder.lock().unwrap().take().ok_or("Chưa bắt đầu xuất video")?;
    let log = part.with_extension("part.log");
    let status = blocking(move || {
        let mut child = child;
        drop(child.stdin.take());
        child.wait().map_err(|e| e.to_string())
    })
    .await??;
    let _ = std::fs::remove_file(part.with_extension("part.wav"));
    let _ = std::fs::remove_file(part.with_extension("part.bg.png"));
    let _ = std::fs::remove_file(part.with_extension("part.bg.yuv"));
    *state.encoder_still.lock().unwrap() = None;
    let _ = std::fs::remove_file(part.with_extension("part.loop.mjpeg"));
    if !status.success() {
        let why = std::fs::read_to_string(&log).unwrap_or_default();
        let _ = std::fs::remove_file(&log);
        return Err(format!("ffmpeg không mã hóa được video: {}", why.lines().last().unwrap_or("")));
    }
    let _ = std::fs::remove_file(&log);
    let mp4 = part.with_extension("");
    std::fs::rename(&part, &mp4).map_err(|e| format!("Không lưu được video: {e}"))?;
    Ok(mp4.to_string_lossy().into_owned())
}

/// A fast export being put together (see `fastvideo`): the still picture,
/// the frames recorded so far, and the audio encoding alongside.
struct FastExport {
    part: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
    still: Vec<u8>,
    chunks: Vec<fastvideo::canvas::Chunk>,
    /// Writing the sound out and encoding it (started in the background).
    audio: Option<std::thread::JoinHandle<Res<std::process::Child>>>,
}

impl FastExport {
    /// Its own files (the still picture stays for the caller: a failed start
    /// falls back to the ordinary export, which removes it).
    fn files(part: &Path) -> [PathBuf; 3] {
        ["part.wav", "part.m4a", "part.h264"].map(|e| part.with_extension(e))
    }
    fn drop_files(part: &Path) {
        for f in Self::files(part) {
            let _ = std::fs::remove_file(f);
        }
    }
}

/// Start a fast export: the still picture (sent as yuv420p with
/// `video_ffmpeg_backdrop`) and the sound; the frames come next as recorded
/// canvas calls (`video_fast_chunk`).
#[tauri::command]
fn video_fast_begin(state: State<'_, AppState>, path: String, width: u32, height: u32, fps: u32, trim_start: f64, trim_end: f64) -> Res<ExportSound> {
    let part = checked_part(&state, &path)?;
    let still = std::fs::read(part.with_extension("part.bg.yuv")).map_err(|_| "Chưa có ảnh nền video".to_string())?;
    if width % 2 != 0 || height % 2 != 0 || still.len() != (width * height * 3 / 2) as usize {
        return Err("Ảnh nền không khớp khung hình".into());
    }
    let mix = export_mix(&state)?;
    let sr = state.engine.sample_rate();
    let total = mix.len() / 2;
    let first = ((trim_start.max(0.0) * sr as f64).round() as usize).min(total);
    let last = total.saturating_sub((trim_end.max(0.0) * sr as f64).round() as usize).max(first);
    // The sound is written and encoded in the background while the frames
    // are recorded and drawn.
    let (wav, m4a) = (part.with_extension("part.wav"), part.with_extension("part.m4a"));
    let audio = std::thread::spawn(move || -> Res<std::process::Child> {
        audio::decode::write_wav(&wav, &mix[2 * first..2 * last], sr)?;
        fastvideo::encode_audio(&wav, &m4a).map_err(|e| format!("Không chạy được ffmpeg: {e}"))
    });
    state.fast_cancel.store(false, Relaxed);
    if let Some(mut old) = state.fast.lock().unwrap().replace(FastExport { part, width, height, fps, still, chunks: Vec::new(), audio: Some(audio) }) {
        if let Some(Ok(Ok(mut a))) = old.audio.take().map(|h| h.join()) {
            let _ = a.kill();
        }
    }
    Ok(ExportSound { sample_rate: sr, first, frames: last - first, hardware: false })
}

/// Recorded frames for the fast export (raw body, `x-path` header).
#[tauri::command]
fn video_fast_chunk(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<()> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        _ => return Err("Thiếu dữ liệu khung hình".into()),
    };
    let chunk = fastvideo::canvas::Chunk::parse(bytes)?;
    let mut fast = state.fast.lock().unwrap();
    let job = fast.as_mut().filter(|j| j.part == Path::new(&path)).ok_or("Chưa bắt đầu xuất video")?;
    job.chunks.push(chunk);
    Ok(())
}

/// Draw and encode the recorded frames, add the sound, and save the video.
/// Progress goes out as `export://fast` events (0–1).
#[tauri::command]
async fn video_fast_finish(app: AppHandle, state: State<'_, AppState>, path: String, frames: usize) -> Res<String> {
    let part = checked_part(&state, &path)?;
    let mut job = state.fast.lock().unwrap().take().filter(|j| j.part == part).ok_or("Chưa bắt đầu xuất video")?;
    let cancel = state.fast_cancel.clone();
    let audio = job.audio.take();
    let started = std::time::Instant::now();
    let result = blocking(move || -> Res<String> {
        let input = fastvideo::Job { width: job.width, height: job.height, fps: job.fps, still: std::mem::take(&mut job.still), chunks: std::mem::take(&mut job.chunks), frames };
        let last = std::sync::Mutex::new(0.0f32);
        let report = |f: f32| {
            let mut l = last.lock().unwrap();
            if f - *l >= 0.01 {
                *l = f;
                let _ = app.emit("export://fast", f);
            }
        };
        let stream = fastvideo::encode(&input, &report, &cancel)?;
        let h264 = part.with_extension("part.h264");
        std::fs::write(&h264, &stream).map_err(|e| format!("Không ghi được video: {e}"))?;
        drop(stream);
        if let Some(a) = audio {
            let mut a = a.join().map_err(|_| "Lỗi khi ghi tiếng".to_string())??;
            let ok = a.wait().map(|s| s.success()).unwrap_or(false);
            if !ok {
                return Err("ffmpeg không mã hóa được tiếng".into());
            }
        }
        fastvideo::mux(&h264, &part.with_extension("part.m4a"), job.fps, &part)?;
        let mp4 = part.with_extension("");
        std::fs::rename(&part, &mp4).map_err(|e| format!("Không lưu được video: {e}"))?;
        Ok(mp4.to_string_lossy().into_owned())
    })
    .await;
    let part = checked_part(&state, &path)?;
    FastExport::drop_files(&part);
    let out = result??;
    let _ = std::fs::remove_file(part.with_extension("part.bg.yuv"));
    eprintln!("fast export: {frames} frames in {:.1}s (drawing and encoding)", started.elapsed().as_secs_f32());
    Ok(out)
}

/// Stop a fast export and drop its files.
#[tauri::command]
fn video_fast_abort(state: State<'_, AppState>, path: String) {
    state.fast_cancel.store(true, Relaxed);
    if let Some(mut job) = state.fast.lock().unwrap().take() {
        if let Some(Ok(Ok(mut a))) = job.audio.take().map(|h| h.join()) {
            let _ = a.kill();
        }
    }
    if let Ok(part) = checked_part(&state, &path) {
        FastExport::drop_files(&part);
    }
}

/// Stop a running ffmpeg export and drop its files.
#[tauri::command]
fn video_ffmpeg_abort(state: State<'_, AppState>, path: String) {
    if let Some(mut c) = state.encoder.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    *state.encoder_still.lock().unwrap() = None;
    if let Ok(part) = checked_part(&state, &path) {
        for p in [part.with_extension("part.wav"), part.with_extension("part.log"), part.with_extension("part.bg.png"), part.with_extension("part.bg.yuv"), part.with_extension("part.loop.mjpeg"), part] {
            let _ = std::fs::remove_file(p);
        }
    }
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
        .map(|c| if c.is_alphanumeric() || " -_(),#%".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .chars()
        .take(160)
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
            let dirs = Dirs { tools: data.join("bin"), cache: cache.clone(), stems: stems.clone(), recordings, store: data.join("store") };
            std::fs::create_dir_all(&dirs.store)?;
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
                encoder: Mutex::new(None),
                encoder_still: Mutex::new(None),
                fast: Mutex::new(None),
                fast_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
            song_backing,
            song_parts,
            search_lyrics,
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
            video_ffmpeg_available,
            video_ffmpeg_backdrop,
            dev_log,
            store_load,
            song_beats,
            export_image_save,
            store_set,
            video_ffmpeg_loop,
            video_ffmpeg_begin,
            video_ffmpeg_frame,
            video_ffmpeg_finish,
            video_ffmpeg_abort,
            video_fast_begin,
            video_fast_chunk,
            video_fast_finish,
            video_fast_abort,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Open Karaoke");
}

#[cfg(test)]
mod composite_tests {
    use super::composite_still;

    /// Transparent lyrics leave the picture as it is; opaque ones replace it; half alpha mixes.
    #[test]
    fn lays_the_band_on_the_still() {
        let (w, h) = (4usize, 4usize);
        let still: Vec<u8> = (0..w * h * 3 / 2).map(|i| if i < w * h { 100 } else { 128 }).collect();
        // A band of rows 2..4: Y 200, U 90, V 160; alpha 0 on the left half, 255 on the right.
        let (y, rows) = (2usize, 2usize);
        let n = w * rows;
        let mut band = vec![200u8; n];
        band.extend(vec![90u8; n / 4]);
        band.extend(vec![160u8; n / 4]);
        band.extend((0..n).map(|i| if i % w >= 2 { 255 } else { 0 }));
        let mut out = Vec::new();
        composite_still(&still, &band, w, h, y, rows, &mut out).unwrap();
        assert_eq!(out.len(), still.len());
        assert_eq!(&out[..2 * w], &still[..2 * w], "rows above untouched");
        assert_eq!(&out[2 * w..3 * w], &[100, 100, 200, 200], "left transparent, right opaque");
        // Chroma (2×2 at the bottom right): the block under opaque pixels takes the band's colour.
        let (u, v) = (w * h, w * h + w * h / 4);
        assert_eq!((out[u + 3], out[v + 3]), (90, 160));
        assert_eq!((out[u + 2], out[v + 2]), (128, 128));

        // Half alpha mixes halfway.
        let half: Vec<u8> = band.iter().enumerate().map(|(i, &b)| if i >= n + n / 2 { 128 } else { b }).collect();
        let mut out = Vec::new();
        composite_still(&still, &half, w, h, y, rows, &mut out).unwrap();
        assert_eq!(out[2 * w], 150);
    }
}

#[cfg(test)]
mod part_tests {
    use super::*;

    #[test]
    fn parts_fade_in_and_out_and_stay_silent_elsewhere() {
        let sr = 1000;
        let g = part_gain(5000, sr, &[(1.0, 2.0), (3.0, 3.5)]);
        assert_eq!(g[500], 0.0); // before
        assert_eq!(g[1500], 1.0); // inside
        assert_eq!(g[2500], 0.0); // between
        assert_eq!(g[3200], 1.0);
        assert_eq!(g[4500], 0.0); // after
        assert_eq!(g[995], 0.0, "nothing before the part starts");
        assert!(g[1020] > 0.0 && g[1020] < 1.0, "fades in inside the part");
        assert_eq!(g[2005], 0.0, "nothing after the part ends");
        let kept = keep_parts(&[1.0; 10_000], sr, &[(1.0, 2.0)]);
        assert_eq!((kept[2 * 1500], kept[2 * 1500 + 1], kept[2 * 500]), (1.0, 1.0, 0.0));
    }
}
