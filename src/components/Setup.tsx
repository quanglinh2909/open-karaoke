import { useEffect, useRef, useState } from "react";
import { api, errorText, onSetupProgress } from "../lib/api";
import { useStore } from "../lib/store";
import { Mic } from "./Icons";

export function Setup() {
  const [label, setLabel] = useState("Đang chuẩn bị…");
  const [fraction, setFraction] = useState(0);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const run = async () => {
    setError(null);
    try {
      const status = await api.toolsInstall();
      useStore.setState({ tools: status, view: "search" });
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    const un = onSetupProgress((p) => {
      setLabel(p.label);
      setFraction(p.fraction);
      setStep({ ytdlp: 0, deno: 1, model: 2 }[p.step] ?? 3);
    });
    if (!started.current) {
      started.current = true;
      void run();
    }
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const overall = Math.min(1, (step + fraction) / 3);

  return (
    <div className="center-screen">
      <div className="setup">
        <div className="logo">
          <Mic />
        </div>
        <h1>Đang dựng sân khấu</h1>
        <p>Open Karaoke đang tải các công cụ miễn phí cần dùng: trình tải nhạc và mô hình AI tách giọng khỏi bài hát. Chỉ làm một lần (khoảng 190 MB).</p>
        <div className="progress">
          <div style={{ width: `${overall * 100}%` }} />
        </div>
        <div className="step-label">{error ? <span className="err">{error}</span> : `${label} · ${Math.round(fraction * 100)}%`}</div>
        {error && (
          <button className="btn primary" style={{ marginTop: 20 }} onClick={run}>
            Thử lại
          </button>
        )}
      </div>
    </div>
  );
}
