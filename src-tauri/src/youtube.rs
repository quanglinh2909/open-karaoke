//! YouTube search and audio download through yt-dlp.

use crate::tools::{deno_path, ytdlp_path};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration: Option<f64>,
    pub views: Option<u64>,
}

pub fn command(tools: &Path) -> Command {
    let mut cmd = Command::new(ytdlp_path(tools));
    cmd.arg("--ignore-config").arg("--no-warnings");
    let deno = deno_path(tools);
    if deno.is_file() {
        cmd.arg("--js-runtimes").arg(format!("deno:{}", deno.display()));
    }
    cmd.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: don't flash a console for every search.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn friendly_error(stderr: &str) -> String {
    let line = stderr
        .lines()
        .rev()
        .find(|l| l.contains("ERROR"))
        .or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("unknown error")
        .trim()
        .trim_start_matches("ERROR:")
        .trim();
    if line.contains("Sign in to confirm") {
        "YouTube đang giới hạn mạng này. Đợi vài phút rồi thử lại.".into()
    } else if line.contains("Private video") || line.contains("unavailable") {
        "Video này không xem được. Hãy chọn bản thu khác.".into()
    } else {
        line.to_string()
    }
}

pub async fn search(tools: &Path, query: &str, limit: u32) -> Result<Vec<Video>, String> {
    let out = command(tools)
        .args(["--flat-playlist", "--dump-single-json", "--skip-download"])
        .arg(format!("ytsearch{}:{}", limit.clamp(1, 30), query))
        .output()
        .await
        .map_err(|e| format!("Không chạy được yt-dlp: {e}"))?;
    if !out.status.success() {
        return Err(friendly_error(&String::from_utf8_lossy(&out.stderr)));
    }
    let json: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let entries = json["entries"].as_array().cloned().unwrap_or_default();
    Ok(entries
        .into_iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_string();
            // Skip channels/playlists that occasionally show up in results.
            if id.len() != 11 {
                return None;
            }
            Some(Video {
                id,
                title: e["title"].as_str().unwrap_or_default().to_string(),
                channel: e["channel"].as_str().or(e["uploader"].as_str()).unwrap_or_default().to_string(),
                duration: e["duration"].as_f64(),
                views: e["view_count"].as_u64(),
            })
        })
        .collect())
}

fn cached(cache: &Path, id: &str) -> Option<PathBuf> {
    let rd = std::fs::read_dir(cache).ok()?;
    for entry in rd.flatten() {
        let p = entry.path();
        let stem_ok = p.file_stem().and_then(|s| s.to_str()) == Some(id);
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
        if stem_ok && matches!(ext, "m4a" | "mp4" | "mp3" | "webm" | "ogg" | "opus" | "aac") {
            return Some(p);
        }
    }
    None
}

#[derive(Serialize, Clone)]
struct DownloadProgress<'a> {
    id: &'a str,
    fraction: f64,
}

/// Download the audio of a video into `cache` and return its path.
fn valid_id(id: &str) -> Result<(), String> {
    if id.len() != 11 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Mã video không hợp lệ".into());
    }
    Ok(())
}

/// The recording's audio, from the cache or downloaded.
pub async fn download(app: &AppHandle, tools: &Path, cache: &Path, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    if let Some(p) = cached(cache, id) {
        return Ok(p);
    }
    // AAC first: it decodes everywhere without extra codecs.
    let format = "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/140/bestaudio[ext=mp3]/bestaudio";
    fetch(app, tools, cache, id, format, "%(id)s.%(ext)s", "download://progress")
        .await?
        .or_else(|| cached(cache, id))
        .ok_or_else(|| "yt-dlp finished but no audio file was produced".into())
}

/// The recording's video, picture only (the sound comes from the audio),
/// up to 1080p, in MP4 so the webview can both play and decode it. H.264
/// first, as every machine decodes it in hardware.
pub async fn download_video(app: &AppHandle, tools: &Path, cache: &Path, id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    let path = cache.join(format!("{id}.video.mp4"));
    if path.is_file() {
        return Ok(path);
    }
    let format = "bv*[vcodec^=avc1][height<=1080][ext=mp4]/bv*[height<=1080][ext=mp4]/bv*[ext=mp4]";
    fetch(app, tools, cache, id, format, "%(id)s.video.%(ext)s", "download://video-progress")
        .await?
        .filter(|p| p.is_file())
        .or_else(|| path.is_file().then(|| path.clone()))
        .ok_or_else(|| "YouTube không có video MP4 cho bài này".into())
}

/// Run yt-dlp for one format into the cache, reporting progress as
/// `event`. Returns the file it wrote.
async fn fetch(app: &AppHandle, tools: &Path, cache: &Path, id: &str, format: &str, name: &str, event: &str) -> Result<Option<PathBuf>, String> {
    tokio::fs::create_dir_all(cache).await.map_err(|e| e.to_string())?;
    let template = cache.join(name);
    let mut child = command(tools)
        .args(["-f", format])
        .args(["--no-playlist", "--newline", "--progress"])
        .args(["--progress-template", "download:ENC %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s"])
        .args(["--print", "after_move:ENCFILE %(filepath)s"])
        .arg("-o")
        .arg(&template)
        .arg(format!("https://www.youtube.com/watch?v={id}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Không chạy được yt-dlp: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            s.push_str(&l);
            s.push('\n');
        }
        s
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut file: Option<PathBuf> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(rest) = line.strip_prefix("ENCFILE ") {
            file = Some(PathBuf::from(rest.trim()));
        } else if let Some(rest) = line.trim().strip_prefix("ENC ") {
            let nums: Vec<f64> = rest.split_whitespace().map(|s| s.parse().unwrap_or(f64::NAN)).collect();
            if nums.len() == 3 {
                let total = if nums[1].is_finite() { nums[1] } else { nums[2] };
                if total.is_finite() && total > 0.0 && nums[0].is_finite() {
                    let _ = app.emit(event, DownloadProgress { id, fraction: (nums[0] / total).min(1.0) });
                }
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(friendly_error(&stderr));
    }
    Ok(file.filter(|f| f.is_file()))
}

/// Keep the cache from growing without bound (oldest files go first).
pub fn prune_cache(cache: &Path, max_bytes: u64) {
    let Ok(rd) = std::fs::read_dir(cache) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let t = m.accessed().or_else(|_| m.modified()).ok()?;
            m.is_file().then(|| (t, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}
