import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { inScale, mod12, noteName } from "../lib/music";
import { pitchTrail, songTime, useStore } from "../lib/store";

const PAST = 4; // seconds of the voice trail left of "now"
const NOW = 0.62; // where "now" sits across the plot; the melody to come is on its right
const READOUT = 128; // px reserved for the note readout

export function PitchGraph() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const noteEl = useRef<HTMLDivElement>(null);
  const centsEl = useRef<HTMLDivElement>(null);
  const needle = useRef<HTMLElement>(null);
  const hasMelody = useStore((s) => !!s.song?.melody?.length);

  useEffect(() => {
    let raf = 0;
    let center = 60;
    let octave = 0; // the melody drawn this many semitones off, to sit in the singer's register
    // Mic → ear delay: the singer sings to music heard a moment earlier.
    let late = 0.05;
    const poll = () =>
      api
        .audioLatency()
        .then((l) => (late = l.mic ? l.totalMs / 1000 : late))
        .catch(() => {});
    void poll();
    const latencyTimer = setInterval(poll, 2000);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const { params, song } = useStore.getState();
      const tonic = Math.round(params.tune_key ?? 0);
      const scale = Math.round(params.tune_scale ?? 1);
      // Trail the newest data slightly so batched frames scroll in smoothly.
      const now = performance.now() / 1000 - 0.035;
      const plotW = w - READOUT;
      // The melody, when known, gets room on the right for what is to come.
      const melody = song?.melody;
      const nowX = Math.round(plotW * (melody?.length ? NOW : 1));
      const pxPerSec = nowX / PAST;

      // The melody around now, in playback seconds (key and tempo applied):
      // the note the singer should be on right now lines up with "now".
      const tempo = song?.info?.tempo ?? 1;
      const semis = song?.info?.semitones ?? 0;
      const singing = songTime() - late;
      const ahead = (plotW - nowX) / pxPerSec;
      const notes = melody
        ? melody.filter((n) => n.end / tempo > singing - PAST && n.start / tempo < singing + ahead).map((n) => ({ ...n, midi: n.midi + semis }))
        : [];

      // Follow the singer's register smoothly; with nobody singing, follow
      // the melody. The melody is drawn in the octave closest to the singer.
      const recent = pitchTrail.slice(-120).filter((p) => p[4]);
      const melodyMid = notes.length ? notes.map((n) => n.midi).sort((a, b) => a - b)[notes.length >> 1] : null;
      if (recent.length > 10) {
        const sorted = recent.map((p) => p[2]).sort((a, b) => a - b);
        const median = sorted[sorted.length >> 1];
        center += (median - center) * 0.04;
        if (melodyMid !== null) {
          const want = Math.round((median - melodyMid) / 12) * 12;
          // Only move an octave when clearly in another one, so bars don't flip.
          if (want !== octave && Math.abs(median - (melodyMid + octave)) > 8) octave = want;
        }
      } else if (melodyMid !== null) {
        center += (melodyMid + octave - center) * 0.04;
      }
      const span = 11;
      const lo = center - span;
      const hi = center + span;
      const y = (m: number) => h - ((m - lo) / (hi - lo)) * h;
      const x = (t: number) => nowX - (now - t) * pxPerSec;
      const lane = Math.abs(y(1) - y(0));

      // Note lanes: scale notes visible, tonic emphasised.
      ctx.font = "600 10px Inter Variable, system-ui";
      ctx.textBaseline = "middle";
      for (let n = Math.floor(lo); n <= Math.ceil(hi); n++) {
        const yy = Math.round(y(n)) + 0.5;
        const isTonic = mod12(n - tonic) === 0;
        if (inScale(n, tonic, scale)) {
          ctx.fillStyle = isTonic ? "rgba(255,61,127,0.08)" : "rgba(255,255,255,0.025)";
          ctx.fillRect(0, yy - lane / 2, plotW, lane);
          ctx.strokeStyle = isTonic ? "rgba(255,61,127,0.35)" : "rgba(255,255,255,0.07)";
          ctx.beginPath();
          ctx.moveTo(0, yy);
          ctx.lineTo(plotW, yy);
          ctx.stroke();
          // Label every scale note when there's room, otherwise only the tonic and fifth.
          const fifth = mod12(n - tonic) === 7;
          if (lane >= 11 || isTonic || fifth) {
            ctx.fillStyle = isTonic ? "rgba(255,120,170,0.9)" : "rgba(255,255,255,0.28)";
            ctx.fillText(noteName(n), 14, yy);
          }
        }
      }

      // The melody's notes as bars: how high, when and how long to sing.
      for (const n of notes) {
        const x0 = nowX + (n.start / tempo - singing) * pxPerSec;
        const x1 = nowX + (n.end / tempo - singing) * pxPerSec;
        const yy = y(n.midi + octave);
        const bh = Math.max(4, lane * 0.62);
        const active = x0 <= nowX && x1 >= nowX;
        const done = x1 < nowX;
        ctx.beginPath();
        ctx.roundRect(Math.max(0, x0), yy - bh / 2, Math.max(2, Math.min(plotW, x1) - Math.max(0, x0)), bh, bh / 2);
        if (active) {
          ctx.fillStyle = "rgba(255,61,127,0.55)";
          ctx.shadowColor = "rgba(255,61,127,0.8)";
          ctx.shadowBlur = 14;
        } else {
          ctx.fillStyle = done ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.16)";
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (!done) {
          ctx.strokeStyle = active ? "rgba(255,200,225,0.9)" : "rgba(255,61,127,0.45)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      const visible = pitchTrail.filter((p) => p[0] > now - PAST - 0.1);
      const path = (idx: 1 | 2) => {
        ctx.beginPath();
        let prev: number | null = null;
        for (const p of visible) {
          if (!p[4]) {
            prev = null;
            continue;
          }
          const px = x(p[0]);
          const py = y(p[idx]);
          if (prev === null || p[0] - prev > 0.06) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
          prev = p[0];
        }
      };

      // Raw voice underneath, corrected voice on top with a glow.
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(47,216,238,0.45)";
      ctx.lineWidth = 1.5;
      path(1);
      ctx.stroke();

      const grad = ctx.createLinearGradient(0, 0, nowX, 0);
      grad.addColorStop(0, "rgba(139,92,246,0.2)");
      grad.addColorStop(0.6, "#c13cf0");
      grad.addColorStop(1, "#ff3d7f");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3.5;
      ctx.shadowColor = "rgba(255,61,127,0.7)";
      ctx.shadowBlur = 12;
      path(2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // "Now" cursor.
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(nowX - 0.5, 0);
      ctx.lineTo(nowX - 0.5, h);
      ctx.stroke();

      // Readout: latest frame within the last 150 ms.
      const last = pitchTrail[pitchTrail.length - 1];
      const live = last && last[4] && performance.now() / 1000 - last[0] < 0.2;
      if (noteEl.current && centsEl.current && needle.current) {
        if (live) {
          const n = noteName(last[3], false);
          const oct = Math.floor(last[3] / 12) - 1;
          noteEl.current.innerHTML = `${n}<small>${oct}</small>`;
          const cents = Math.round((last[1] - last[3]) * 100);
          centsEl.current.textContent = `lệch ${cents > 0 ? "+" : ""}${cents}¢`;
          needle.current.style.left = `${Math.max(0, Math.min(100, 50 + cents))}%`;
          needle.current.style.opacity = "1";
        } else {
          noteEl.current.innerHTML = "–";
          centsEl.current.textContent = "hát để bắt đầu";
          needle.current.style.opacity = "0";
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(latencyTimer);
    };
  }, []);

  return (
    <div className="pitch">
      <canvas ref={canvas} />
      <div className="legend">
        {hasMelody && (
          <span>
            <i style={{ background: "rgba(255,61,127,0.55)", height: 6, borderRadius: 3 }} />
            Giai điệu gốc
          </span>
        )}
        <span>
          <i style={{ background: "rgba(47,216,238,0.8)" }} />
          Giọng bạn
        </span>
        <span>
          <i style={{ background: "linear-gradient(90deg,#c13cf0,#ff3d7f)" }} />
          Sau chỉnh
        </span>
      </div>
      <div className="readout">
        <div className="nn" ref={noteEl}>
          –
        </div>
        <div className="tuner">
          <i ref={needle} style={{ left: "50%", opacity: 0 }} />
        </div>
        <div className="cents" ref={centsEl}>
          hát để bắt đầu
        </div>
      </div>
    </div>
  );
}
