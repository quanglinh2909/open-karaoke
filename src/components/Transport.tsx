import { useRef } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText } from "../lib/api";
import { formatTime } from "../lib/music";
import { trimRange, useStore } from "../lib/store";
import { Mic, MicOff, Pause, Play, Rewind } from "./Icons";

/** Mic on/off: when off, the mic is not heard, recorded, drawn or scored. */
export function toggleMic() {
  const s = useStore.getState();
  const on = (s.params.mic ?? 1) > 0.5;
  s.setParam("mic", on ? 0 : 1);
  // An earlier mic switch muted through the voice level; bring it back.
  if (!on && (s.params.vocal ?? 0) < 0.005) s.setParam("vocal", 0.9);
}

export async function togglePlay() {
  const { playing, song } = useStore.getState();
  if (song?.phase !== "ready") return;
  if (playing) await api.pause();
  else {
    // Before the trimmed start (an ad), or at the cut end: begin where singing does.
    const { start, end } = trimRange();
    const pos = useStore.getState().pos;
    if (pos < start - 0.05 || pos >= end - 0.05) await api.seek(start);
    await api.play();
  }
}

/** From the top of the song, skipping its trimmed start. */
export async function playFromStart() {
  useStore.setState({ ended: false });
  await api.seek(trimRange().start);
  await api.play();
}

export async function toggleRecord() {
  const s = useStore.getState();
  if (!s.song?.info) return;
  try {
    if (s.recording) {
      const path = await api.recordStop();
      if (path) {
        useStore.setState({ lastRecording: path });
        s.toast("Đã lưu bản thu", "success", { label: "Xem", run: () => revealItemInDir(path) });
      }
    } else {
      // Local time (toISOString is UTC, 7 hours off in Vietnam).
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}`;
      await api.recordStart(`${s.song.meta.artist} - ${s.song.meta.title} (${stamp})`);
      if (!s.playing) await api.play();
    }
  } catch (e) {
    s.toast(errorText(e), "error");
  }
}

function Meter({ value }: { value: number }) {
  // Peak (linear) → dB → 0..1 over a 48 dB range.
  const db = 20 * Math.log10(Math.max(value, 1e-5));
  const h = Math.max(0, Math.min(1, (db + 48) / 48));
  return (
    <div className="meter">
      <div style={{ height: `${h * 100}%` }} />
    </div>
  );
}

export function Transport() {
  const playing = useStore((s) => s.playing);
  const pos = useStore((s) => s.pos);
  const duration = useStore((s) => s.duration);
  const recording = useStore((s) => s.recording);
  const micOn = useStore((s) => (s.params.mic ?? 1) > 0.5);
  const mic =useStore((s) => s.mic);
  const out = useStore((s) => s.out);
  const score = useStore((s) => s.score);
  const lines = useStore((s) => s.song?.lyrics.lines);
  const info = useStore((s) => s.song?.info);
  const userOffset = useStore((s) => s.song?.userOffset ?? 0);
  const ready = useStore((s) => s.ready);
  const separating = useStore((s) => !!s.song?.info?.separating);
  const seek = useRef<HTMLDivElement>(null);

  const ratio = duration > 0 ? Math.min(1, pos / duration) : 0;
  const trim = trimRange({ song: useStore((s) => s.song), duration });
  const tempo = info?.tempo ?? 1;
  const offset = userOffset;

  const onSeek = (e: React.PointerEvent) => {
    const el = seek.current;
    if (!el || duration <= 0) return;
    const go = (clientX: number) => {
      const r = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      useStore.setState({ pos: f * duration });
      void api.seek(f * duration);
    };
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="transport">
      <button className="icon-btn" title="Phát lại từ đầu" onClick={() => api.seek(trimRange().start)}>
        <Rewind />
      </button>
      <button className="play-btn" onClick={togglePlay} title="Phát / tạm dừng (Space)">
        {playing ? <Pause /> : <Play style={{ marginLeft: 3 }} />}
      </button>
      <div className="timeline">
        <span>{formatTime(pos)}</span>
        <div className="seek" ref={seek} onPointerDown={onSeek}>
          <div className="rail">
            {separating && duration > 0 && <div className="ready-fill" style={{ width: `${Math.min(1, ready / duration) * 100}%` }} />}
            <div className="fill" style={{ width: `${ratio * 100}%` }} />
            {/* Skipped parts (ads, talk) shaded out. */}
            {duration > 0 && trim.start > 0 && <div className="trim-cut" style={{ left: 0, width: `${(trim.start / duration) * 100}%` }} />}
            {duration > 0 && trim.end < duration && <div className="trim-cut" style={{ right: 0, width: `${((duration - trim.end) / duration) * 100}%` }} />}
          </div>
          {duration > 0 &&
            lines?.map((l, i) => {
              const t = (l.start + offset) / tempo;
              if (t < 0 || t > duration) return null;
              const gap = i === 0 || l.start - lines[i - 1].end > 4;
              return gap ? <div key={i} className="mark" style={{ left: `${(t / duration) * 100}%` }} /> : null;
            })}
          <div className="knob" style={{ left: `${ratio * 100}%` }} />
        </div>
        <span>{formatTime(duration)}</span>
      </div>
      <div className="meters" title="Mức mic / đầu ra">
        <Meter value={mic} />
        <Meter value={out} />
      </div>
      <div className="score-pill" title={`Độ chuẩn cao độ ${Math.round(score.accuracy)}%`}>
        <b>{score.points.toLocaleString()}</b>
        <span>{score.streak > 1 ? `chuỗi ${score.streak}×` : "điểm"}</span>
      </div>
      <button className={`icon-btn mic-btn ${micOn ? "" : "off"}`} onClick={toggleMic} title={micOn ? "Tắt mic (M)" : "Bật mic (M)"}>
        {micOn ? <Mic /> : <MicOff />}
      </button>
      <button className={`rec-btn ${recording ? "on" : ""}`} onClick={toggleRecord} title="Thu lại phần hát của bạn">
        <i />
        {recording ? "Dừng" : "Thu"}
      </button>
    </div>
  );
}
