import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { closeSong, openSong, startThreshold } from "../lib/loader";
import { keyName } from "../lib/music";
import { songTime, useStore, type Phase } from "../lib/store";
import { Check, Circle, Play } from "./Icons";
import { Lyrics } from "./Lyrics";
import { MixPanel, SidebarTabs, SongPanel, TunePanel, VoicePanel } from "./Panels";
import { PitchGraph } from "./PitchGraph";
import { playFromStart, togglePlay, Transport } from "./Transport";

const STEPS: { phase: Phase; label: string }[] = [
  { phase: "searching", label: "Tìm bản thu gốc" },
  { phase: "downloading", label: "Tải âm thanh" },
  { phase: "separating", label: "Tách giọng hát bằng AI" },
];

function LoadingCard() {
  const song = useStore((s) => s.song)!;
  const order = STEPS.findIndex((s) => s.phase === song.phase);
  return (
    <div className="overlay">
      <div className="loading-card">
        {song.meta.artwork && <img src={song.meta.artwork} alt="" />}
        <h2>{song.meta.title}</h2>
        <div className="a">{song.meta.artist}</div>
        {song.phase === "error" ? (
          <>
            <p className="err" style={{ margin: "0 0 18px" }}>
              {song.message}
            </p>
            <div className="row">
              <button className="btn" onClick={closeSong}>
                Về trang tìm kiếm
              </button>
              <button className="btn primary" onClick={() => openSong(song.meta)}>
                Thử lại
              </button>
            </div>
          </>
        ) : (
          <div className="steps">
            {STEPS.map((s, i) => (
              <div key={s.phase} className={i < order ? "done" : i === order ? "on" : ""}>
                {i < order ? <Check style={{ color: "var(--ok)" }} /> : i === order ? <div className="spinner" /> : <Circle />}
                {s.phase === "separating" && i === order && !song.separation ? "Mở bài đã tách sẵn" : s.label}
                {i === order && s.phase === "downloading" && song.progress > 0 && ` · ${Math.round(song.progress * 100)}%`}
                {i === order && s.phase === "separating" && song.separation && ` · ${Math.round(song.separation.fraction * 100)}%`}
                {i === order && s.phase === "separating" && song.separation && song.separation.ready > 0 && ` · ${Math.round(song.separation.ready)} giây đã sẵn sàng`}
              </div>
            ))}
            {song.phase === "separating" && song.separation && <SeparationBar />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Progress toward the head start needed before singing can begin. */
function SeparationBar() {
  const song = useStore((s) => s.song)!;
  const p = song.separation!;
  const duration = song.info?.sourceDuration ?? song.meta.duration;
  const target = duration > 0 ? startThreshold(p, duration) : 30;
  const frac = Math.min(1, p.ready / Math.max(1, target));
  return (
    <div style={{ marginTop: 6 }}>
      <div className="progress">
        <div style={{ width: `${frac * 100}%` }} />
      </div>
      <p className="help" style={{ marginTop: 8 }}>
        {p.speed > 0 ? `Đang chạy nhanh gấp ${p.speed.toFixed(1)} lần thời gian thực. ` : "Đang tải mô hình AI… "}
        Có thể bắt đầu hát khi đã sẵn sàng {Math.round(target)} giây; phần còn lại xử lý tiếp trong lúc bạn hát. Lần sau bài này mở là hát ngay.
      </p>
    </div>
  );
}

function StartCard() {
  const song = useStore((s) => s.song)!;
  return (
    <div className="overlay" style={{ background: "rgba(11,10,16,0.35)" }}>
      <div className="start-card">
        <div className="ready">Sẵn sàng</div>
        <h2>{song.meta.title}</h2>
        <div className="a">{song.meta.artist}</div>
        <button className="btn primary big" onClick={() => void playFromStart()} autoFocus>
          <Play /> Bắt đầu hát
        </button>
        <div className="hint">
          <span className="kbd">Space</span> phát/tạm dừng · <span className="kbd">←</span>
          <span className="kbd">→</span> tua · <span className="kbd">[</span>
          <span className="kbd">]</span> canh lời · <span className="kbd">F</span> toàn màn hình · <span className="kbd">M</span> bật/tắt mic
        </div>
      </div>
    </div>
  );
}

function grade(acc: number) {
  if (acc >= 92) return "S";
  if (acc >= 82) return "A";
  if (acc >= 70) return "B";
  if (acc >= 55) return "C";
  return "D";
}

function ScoreCard() {
  const score = useStore((s) => s.score);
  const lastRecording = useStore((s) => s.lastRecording);
  const song = useStore((s) => s.song)!;
  const sang = score.sung > 5;
  return (
    <div className="overlay">
      <div className="scorecard">
        <div className="ready" style={{ color: "var(--muted)", letterSpacing: "0.18em", fontSize: 12, fontWeight: 700 }}>
          KẾT QUẢ
        </div>
        <div className="grade">{sang ? grade(score.accuracy) : "–"}</div>
        <div className="stats">
          <div>
            <b>{sang ? `${Math.round(score.accuracy)}%` : "–"}</b>
            <span>độ chuẩn cao độ</span>
          </div>
          <div>
            <b>{score.points.toLocaleString()}</b>
            <span>điểm</span>
          </div>
          <div>
            <b>{Math.round(score.sung)}s</b>
            <span>đã hát</span>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={closeSong}>
            Bài khác
          </button>
          {lastRecording && (
            <button className="btn" onClick={() => revealItemInDir(lastRecording)}>
              Xem bản thu
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => {
              void playFromStart();
            }}
          >
            Hát lại{song.meta.title.length > 18 ? "" : ` "${song.meta.title}"`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The recording's video behind the lyrics, kept in step with the music. */
function StageVideo({ path }: { path: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = ref.current;
      if (!v || v.readyState < 1) return;
      const { playing, song } = useStore.getState();
      // The video runs on the original recording's clock, like the lyrics.
      const tempo = song?.info?.tempo || 1;
      const want = songTime() * tempo;
      if (Math.abs(v.playbackRate - tempo) > 1e-3) v.playbackRate = tempo;
      if (playing) {
        if (v.paused) void v.play().catch(() => {});
        if (Math.abs(v.currentTime - want) > 0.2) v.currentTime = want;
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - want) > 0.05) v.currentTime = want;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <video ref={ref} className="stage-video" src={convertFileSrc(path)} muted playsInline preload="auto" />;
}

export function Stage() {
  const song = useStore((s) => s.song);
  const videoPath = useStore((s) => (s.videoBg && s.song?.video?.status === "ready" ? s.song.video.path : undefined));
  const tab = useStore((s) => s.tab);
  const sidebar = useStore((s) => s.sidebar);
  const playing = useStore((s) => s.playing);
  const ended = useStore((s) => s.ended);
  const pos = useStore((s) => s.pos);
  const recording = useStore((s) => s.recording);
  const tuneOn = useStore((s) => s.params.tune_enabled > 0.5);
  const tuneKey = useStore((s) => s.params.tune_key);
  const tuneScale = useStore((s) => s.params.tune_scale);
  const buffering = useStore((s) => s.buffering);
  if (!song) return null;

  const loading = song.phase !== "ready";
  const fresh = song.phase === "ready" && !playing && pos < 0.25 && !ended;

  return (
    <div className={`stage ${sidebar ? "" : "no-sidebar"}`}>
      <div className={`stage-bg ${videoPath ? "video-on" : ""}`}>
        {videoPath ? <StageVideo path={videoPath} /> : song.meta.artwork && <img src={song.meta.artwork} alt="" />}
      </div>
      <div className={`stage-main ${fresh ? "starting" : ""}`}>
        <div className="song-head">
          {song.meta.artwork ? <img src={song.meta.artwork} alt="" /> : <div className="art-ph" />}
          <div className="meta">
            <div className="t">{song.meta.title}</div>
            <div className="a">{song.meta.artist}</div>
          </div>
          <div className="chips">
            {recording && (
              <span className="chip">
                <span className="dot live" />
                <b>Đang thu</b>
              </span>
            )}
            <span className="chip" title="Tông autotune đang dùng">
              <span className={`dot ${tuneOn ? "ok" : ""}`} />
              Autotune <b>{tuneOn ? keyName(tuneKey, tuneScale) : "tắt"}</b>
            </span>
            {song.info && (song.info.semitones !== 0 || song.info.tempo !== 1) && (
              <span className="chip">
                {song.info.semitones !== 0 && (
                  <b>
                    {song.info.semitones > 0 ? "+" : ""}
                    {song.info.semitones} nửa cung
                  </b>
                )}
                {song.info.tempo !== 1 && <b>{Math.round(song.info.tempo * 100)}%</b>}
              </span>
            )}
            {song.info?.vocalRemoved && <span className="chip">Lọc giọng cơ bản</span>}
            {song.info?.separating && song.separation && (
              <span className="chip" title="AI vẫn tiếp tục tách phần còn lại của bài trong lúc bạn hát">
                <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />
                Đang tách <b>{Math.round(song.separation.fraction * 100)}%</b>
              </span>
            )}
            {buffering && (
              <span className="chip">
                <span className="dot warn" />
                <b>Đang bắt kịp…</b>
              </span>
            )}
          </div>
        </div>
        <Lyrics />
        <PitchGraph />
        <Transport />
        {loading && <LoadingCard />}
        {fresh && <StartCard />}
        {ended && <ScoreCard />}
        {song.busy && (
          <div className="overlay" style={{ background: "rgba(11,10,16,0.3)" }}>
            <div className="loading-card" style={{ width: "auto", display: "flex", gap: 12, alignItems: "center", padding: "16px 22px" }}>
              <div className="spinner" />
              {song.busy}
            </div>
          </div>
        )}
      </div>
      <aside className="sidebar">
        <div className="tabs" style={{ display: "block" }}>
          <SidebarTabs />
        </div>
        {tab === "tune" && <TunePanel />}
        {tab === "voice" && <VoicePanel />}
        {tab === "mix" && <MixPanel />}
        {tab === "song" && <SongPanel />}
      </aside>
    </div>
  );
}

export { togglePlay };
