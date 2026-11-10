# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Open Karaoke is a Tauri 2 desktop app with a Rust core (`src-tauri/`) for real-time audio, DSP and on-device AI, and a React + TypeScript UI (`src/`).

## Commands

```bash
npm install
npm run app            # tauri dev: Vite on :1420 + cargo run, hot reload for both
npm run dist           # installers → src-tauri/target/release/bundle/
# run-app.cmd / build-installer.cmd: the same with this machine's build env set (Windows).
# build-installer.cmd makes the full installer: it stages %APPDATA%pp.openkaraoke.desktopin
# (yt-dlp, Deno, all models, ~1.1 GB) into src-tauri/bundled/ and builds with
# tauri.bundle.conf.json (NSIS, uncompressed); on first launch tools::adopt_bundled
# hard-links them into the tools dir, so nothing is downloaded.
npx tsc --noEmit       # type-check the UI (there is no separate lint step)
npm run build          # tsc + vite build of the UI only

cd src-tauri
cargo test --lib                       # all Rust unit tests (what CI runs)
cargo test --lib align                 # tests whose path matches "align"
cargo test --lib audio::transcribe::tests::splits_long_phrases   # one test
```

Prerequisites: Rust stable, Node 20+, the Tauri prerequisites, and **libclang** (bindgen for `signalsmith-stretch` and `whisper-rs-sys`; set `LIBCLANG_PATH` if it is not found). On Windows, ONNX Runtime's prebuilt static lib needs the **MSVC v143 toolset (VS 2022)**; with only VS 2019 it fails to link (`__std_find_end_1` and similar). On Linux also `libasound2-dev`. On Windows the ASIO host (cpal's `asio` feature, for drivers like ASIO Link Pro or ASIO4ALL) needs the Steinberg ASIO SDK: set `CPAL_ASIO_DIR` to the unpacked `ASIOSDK` folder, or asio-sys downloads it into the temp dir. The SDK is dual-licensed (Steinberg proprietary or GPLv3), which matters only when distributing builds.

Debug tools in `src-tauri/examples/` run the AI stages on real files (models live in the app data dir, `…/app.openkaraoke.desktop/bin/models/`):
- `separate_check`, `separation_flow`: vocal separation
- `transcribe_check -- ggml-model.bin vocals.wav [prompt.txt]`: Whisper on a vocal stem
- `melody_check -- swift-f0.onnx vocals.wav [from_s to_s]`: the original melody as notes.
- `align_check -- mms.onnx vocals.wav lyrics.tsv|lines.json [star_penalty…]`: forced alignment. It caches emissions in `vocals.wav.emissions`, so reruns are instant.

Stop `npm run app` before running `cargo` commands by hand. Two concurrent builds in `target/` have left corrupt incremental objects (`LNK1120` with hundreds of mangled symbols); `cargo clean -p open-karaoke` fixes it.

## Build configuration that matters

- `[profile.dev]` uses `opt-level = 2` (and 3 for dependencies) because the DSP is unusable unoptimised.
- `src-tauri/.cargo/config.toml` passes `CMAKE_*_FLAGS_*` (with `/O2`) and `GGML_AVX2/FMA/F16C` to whisper.cpp. Without it, the `cmake` crate drops the optimisation flags and MSVC builds ggml without SIMD, which makes Whisper about 30× slower. `[profile.dev.build-override] debug-assertions = false` stops whisper-rs-sys from compiling with `WHISPER_DEBUG`, which logs every token.
- `build.rs` sets `cfg(has_ort)` everywhere except Intel macOS (ONNX Runtime has no build there). `separate.rs` and `align.rs` provide stand-ins returning `UNAVAILABLE` when it is off.

## Architecture

### Rust core (`src-tauri/src`)

- **`lib.rs`** holds every `#[tauri::command]` and `AppState`:
  - `song: Mutex<Song>` holds the decoded instrumental, the separated vocal (`guide`) and the key/tempo settings.
  - `generation: AtomicU32` is bumped whenever the loaded audio changes. Background work captures it at start and returns `Err("superseded")` if it moved; the UI ignores that error.
  - `spawn_ticker` emits `engine://tick` (~30 fps) with position, pitch frames, score and stream errors. That is the UI's only view of playback state.
- **`audio/engine.rs`** handles cpal input/output streams. The audio callbacks must stay real-time safe: no locks, allocation or I/O. Data crosses threads through `ringbuf` rings, `crossbeam` channels (`Cmd`, `LabCmd`) and atomics. Buffers that are swapped out are sent to a garbage channel instead of being dropped on the audio thread. `Track` holds `Buf::Growing` while separation is still streaming, then `Buf::Full`.
- **`audio/params.rs`**: one macro defines every live parameter as an `AtomicF32`. The UI sets them by string name via `set_params`. The keys in `src/lib/presets.ts` (`DEFAULT_PARAMS`) must match these names.
- **Vocal chain** (`chain.rs`, input thread): pitch detection (`pitch.rs`, McLeod) → autotune controller → TD-PSOLA voices (`psola.rs`) → effects (`fx.rs`).
- **Separation** (`separate.rs`): MDX-Net on ONNX Runtime over overlapping chunks. Finished segments stream into a `Growing` buffer so playback can start after about 30 s. Stems are cached in the app cache dir as `<youtubeId>.{instrumental,vocals}.wav`. A separation belongs to its recording, not to the open song (`AppState.separations`): closing the song lets it finish in the background and cache the stems; reopening attaches to the running one (its `Growing` buffers and `job` id for progress events); while another song's separation runs for the open song, background ones wait between chunks; `delete_source` cancels it; `lyric_jobs` reports it as stage "separate" for the home cards. Without the AI, `song_vocal_removal` uses a centre-channel remover; in that case `guide` is the full mix (`vocal_removed = true`).
- **`tools.rs`**: first-run downloads (yt-dlp, Deno, separation model) and lazy, SHA-256-verified downloads of the lyric models. Every model is pinned by URL revision and checksum (`MODEL` consts in `separate.rs`, `align.rs`, `transcribe.rs`).
- **`youtube.rs`** (yt-dlp) and **`meta.rs`** (iTunes → Deezer search, LRCLIB lyrics) are the network sources. The home search uses YouTube (`yt_search`): `songFromVideo` in `sources.ts` turns a video into a song (title/artist parsed from the video title and channel, for the lyrics lookup), and `openSong` uses that video as the recording instead of ranking candidates. Songs found earlier through iTunes still open the old way.

### UI (`src`)

- **`lib/store.ts`** is a single Zustand store: `song: SongState`, params, history, toasts. **`lib/api.ts`** has typed `invoke` wrappers and event listeners for every command and event.
- **`lib/loader.ts`** orchestrates a song: `openSong` → rank YouTube candidates (`sources.ts`) → download → `songSeparate` → lyrics. A module-level `loadToken` is also the separation job id. Every async step checks `isCurrent(token)` so a stale song never writes state. Per-song results (chosen source, lyrics, aligned lyrics) persist in localStorage via `library.ts`.

### Lyrics pipeline (follows the actual singer)

Published LRC lyrics are often timed to another edit or another singer's version. After separation finishes, `autoAlign` in `loader.ts` applies cached fitted lyrics if there are any. Otherwise it does only step 1. Steps 2–5 are heavy, so they run **only when the user asks**: the "Fit lyrics" button on a home card or on the stage calls `startLyrics`, and `stopLyrics` / `cancel_lyrics` stops them.

1. **Instant whole-file shift**: `vocal_activity` (vocal RMS) is cross-correlated with the LRC line spans (`estimateLyricOffset` in `lib/align.ts`). This is only a rough fix applied immediately.
2. **Listen**: `transcribe_vocal` (`audio/transcribe.rs`, Whisper large-v3-turbo via whisper-rs) runs only on sung chunks, so long silences, where Whisper invents text, are skipped. It is prompted with the distinct LRC lines, without which it hallucinates on bare vocals. It drops known hallucination phrases and runs of words piled on a single timestamp; `dropRushed` (in `lyricsMerge.ts`) also drops repeat hallucinations, where a just-sung line comes back crammed into a second or two.
3. **Merge**: `lib/lyricsMerge.ts` cuts Whisper's word stream into the LRC lines it matches; any line may match anywhere because choruses repeat. It keeps LRC spelling except where the singer sings a different word. Words that only one side has get `heard: false`. Disputed words carry `alt`, and near-tied rival lines carry `alts`.
4. **Time**: `align_lyrics` (`audio/align.rs`) runs MMS-300M CTC forced alignment with Viterbi and optional "star" states between lines, on romanized text (`romanize` strips Vietnamese diacritics). Each merged line carries `heardAt` (where Whisper heard it). `align_lines_within` keeps the line's letters within ±3 s of that window, and falls back to unconstrained alignment if the windows can't all be met. This stops a short line from hanging on an echo in the next interlude. Emissions are cached in `AppState.emissions` per generation, so `forceAlign` can align each variant (`alternatives` / `chooseVariants`) cheaply and keep what the vocal fits best. `retime` drops `heard: false` words the aligner can't hear either, and interpolates low-score words.
   Whisper is touchy about where a chunk starts. When a chunk comes back empty, or as one of the `HALLUCINATIONS` (such as "subscribe… Ghiền Mì Gõ" over singing), `transcribe` hears it again. It retries first with the recent heard lines as the prompt, then 2 s wider, then in halves. The cache file is `<source>.<digest>.heard2.json`. Set `OK_DEBUG_WHISPER=1` to log each pass. With no published lyrics, a long segment is split into lines at capitalised words.
   With no published lyrics, Whisper words below p 0.4 are kept as `unsure` (dotted underline), not dropped. `withHums` adds a `hum` stand-in line ("♪♪♪", one word spanning the passage) where the melody notes show singing but no lyric line covers it. The user types the words into it, or deletes it with an empty fix (`withFixes` then drops the line).
5. The result is cached in the library as `aligned { sourceId, lines, v: ALIGN_VERSION }`. Bump `ALIGN_VERSION` in `loader.ts` when the pipeline changes.

Scheduling: `prepareLyrics` (one promise per source id) runs to the end even after the song is closed. In `lib.rs`, each analysis is a `Job` per recording:
- **One run per key.** A `OnceCell` makes later callers (a reloaded page, a reopened song) wait for the same run; `replay` shows them its progress so far.
- **Cached on disk** in the stems dir: `<id>.<prompt-hash>.heard.json` and `<id>.mms`.
- **One recording at a time.** `lyric_queue` is a FIFO `Semaphore(1)`. A turn covers Whisper and the MMS emissions, so recordings finish in the order they were opened.
- **Pausing and stopping.** `pause_or_stop` blocks between chunks while a song is being separated (the song being opened goes first). Analysis stops only when `delete_source` cancels it.
- **Progress events** (`transcribe://progress`, `align://progress`) carry `source`; the UI shows only its current song's. The home screen polls `lyric_jobs` for per-song status.

The timing rules for showing lyrics (focus and glide, rests, held notes, countdown and break panel) live in `lib/lyricCues.ts`, shared by the stage and the karaoke video export (`lib/videoExport.ts`, which draws the same layout on a canvas), so the two always match. `Lyrics.tsx` renders every synced line on one track that slides with `transform` (no resizing or reflow), so the line to sing always sits at the same height (`ANCHOR`). It moves on to the next line 0.6 s before it starts or 0.8 s after the current one ends (`focusAt`). Past lines fade out; the next two show below. It draws singing cues from the word times (one score-style vocabulary everywhere, soft pink and glowing while it applies: ’ breath, // pause, ‿ straight into the next line, a tapering trail for a held note, which a line's last word gets from 0.7 s; an entry glow swells during 0.5–2 s gaps before a line; a legend under the title explains them): countdown dots before lines, an instrumental-break panel, rest marks inside lines, and a hold bar for long notes. Only one cue moves at a time: a lead-in underline on the next line was removed because it ran during the current line's wipe and confused singers. It updates per frame through CSS variables (`--p`, `--h`) set on refs, not through React state.

### Video background

With "Dùng video gốc làm nền" on (`videoBg` in the store, kept in localStorage), `loadVideo` fetches the recording's picture-only MP4 (≤1080p, H.264 first) with `yt_download_video` into the cache as `<id>.video.mp4`. The webview reads it through Tauri's asset protocol (`protocol-asset` feature, `assetProtocol` scope `$APPCACHE/**`, CSP `media-src`/`connect-src asset:`). On stage `StageVideo` plays it muted behind the lyrics, slaved to `songTime()` (× tempo, re-seeking when it drifts). The export has three lyric styles (`LyricStyle`, chosen in the export panel and kept in localStorage): `scroll` (as on stage), `classic` (two lines low, left/right alternating, white filling with pink, outlined) and `subtitle` (bottom line plus the next, picture left clear). The karaoke export (`videoExport.ts`) then renders Full HD over it: `lib/videoFrames.ts` demuxes with mp4box (`createFile(true)`, extraction set in `onReady`, or the samples are gone) and decodes in order with WebCodecs `VideoDecoder`. Headless Edge is unreliable for testing this (fetches of media hang in fresh profiles); test in the app.

### Melody and scoring

`audio/melody.rs` runs SwiftF0 (MIT, ~135 KB ONNX, pinned in `MODEL`) on the separated vocal: pitch every 16 ms, then `notes` turns it into notes with a port of swift_f0's `segment_notes` dynamic program (5 min of audio: about 1.3 s). `melody_notes` caches them as `<id>.melody.json` in the stems dir and in `AppState.melodies`. The ticker scores each mic frame against the melody note at that moment (shifted by the key change, timed back by the measured mic→ear latency, any octave counts); where the melody rests singing isn't scored, and songs without a melody fall back to the nearest note of the key. `PitchGraph.tsx` draws the notes as bars with "now" at 62% of the plot, so the next notes are visible, in the octave closest to the singer.

## Licensing note

The MMS forced-alignment weights are **CC-BY-NC-4.0 (non-commercial)**. The rest of the stack (app MIT, Whisper MIT, UVR model) has no such restriction.

## Releasing

Bump `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`, then push a `v*` tag. `.github/workflows/release.yml` runs `cargo test --lib` and builds all platforms.
