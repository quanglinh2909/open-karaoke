import { useEffect, useState } from "react";
import { api, errorText, type DeviceList, type LatencyReport } from "../lib/api";
import { syncAllParams, useStore } from "../lib/store";
import { Select, Toggle } from "./Controls";

const BUFFERS = [
  { label: "64 mẫu (độ trễ thấp nhất)", value: 64 },
  { label: "128 mẫu", value: 128 },
  { label: "256 mẫu (khuyên dùng)", value: 256 },
  { label: "512 mẫu", value: 512 },
  { label: "1024 mẫu (ổn định nhất)", value: 1024 },
];

export async function openAudio() {
  const { audioPrefs, toast } = useStore.getState();
  try {
    const status = await api.audioOpen(audioPrefs.input, audioPrefs.output, audioPrefs.buffer, !!audioPrefs.exclusive, audioPrefs.asio ?? null);
    useStore.setState({ audio: status });
    syncAllParams();
    if (status.inputError) toast(`Không dùng được micro: ${status.inputError}`, "error");
    if (status.exclusiveNote) toast(status.exclusiveNote, "error");
    return status;
  } catch (e) {
    toast(`Lỗi thiết bị âm thanh: ${errorText(e)}`, "error");
    return null;
  }
}

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const prefs = useStore((s) => s.audioPrefs);
  const audio = useStore((s) => s.audio);
  const set = useStore((s) => s.set);
  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [busy, setBusy] = useState(false);
  const [latency, setLatency] = useState<LatencyReport | null>(null);

  useEffect(() => {
    if (open) api.audioDevices().then(setDevices).catch(() => setDevices(null));
  }, [open]);

  // Measured on the running streams while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const poll = () => api.audioLatency().then(setLatency).catch(() => setLatency(null));
    poll();
    const t = setInterval(poll, 500);
    return () => clearInterval(t);
  }, [open]);

  if (!open) return null;

  const apply = async (p: Partial<typeof prefs>) => {
    set({ audioPrefs: { ...prefs, ...p } });
    setBusy(true);
    await openAudio();
    setBusy(false);
  };

  const opt = (list: string[] | undefined, def: string | null | undefined) => [
    { label: `Mặc định hệ thống${def ? ` (${def})` : ""}`, value: "" },
    ...(list ?? []).map((d) => ({ label: d, value: d })),
  ];

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && set({ settingsOpen: false })}>
      <div className="modal">
        <h3>Cài đặt âm thanh</h3>
        <div className="sub">Dùng tai nghe là tốt nhất: không bị hú và nghe autotune đúng như khi thu.</div>

        {navigator.userAgent.includes("Windows") && (
          <>
            <label>Driver âm thanh</label>
            <Select
              value={prefs.asio ?? ""}
              options={[{ label: "Windows (mặc định)", value: "" }, ...(devices?.asio ?? []).map((d) => ({ label: `ASIO · ${d}`, value: d }))]}
              onChange={(v) => apply({ asio: v || null })}
            />
            <p className="help">
              {prefs.asio
                ? "ASIO là đường âm thanh của phần mềm thu âm (như Cubase): độ trễ thấp nhất. Chọn micro, tai nghe và bộ đệm trong bảng điều khiển của driver đó; phần mềm khác thường không dùng chung được."
                : devices?.asio.length
                  ? "Có driver ASIO trên máy: chọn để có độ trễ thấp nhất, như khi hát với Cubase."
                  : "Chưa có driver ASIO nào. Cài ASIO4ALL hoặc ASIO Link Pro (miễn phí) rồi mở lại mục này để có độ trễ thấp nhất."}
            </p>
          </>
        )}

        {!prefs.asio && (
          <>
            <label>Micro</label>
            <Select value={prefs.input ?? ""} options={opt(devices?.inputs, devices?.defaultInput)} onChange={(v) => apply({ input: v || null })} />

            <label>Đầu ra</label>
            <Select value={prefs.output ?? ""} options={opt(devices?.outputs, devices?.defaultOutput)} onChange={(v) => apply({ output: v || null })} />
          </>
        )}

        {navigator.userAgent.includes("Windows") && !prefs.asio && (
          <div style={{ marginTop: 16 }}>
            <Toggle
              on={!!prefs.exclusive}
              onChange={(v) => apply({ exclusive: v })}
              label="Độ trễ thấp (chế độ độc quyền)"
              hint="App chiếm riêng tai nghe và micro để giảm độ trễ. Trong lúc bật, app khác không phát tiếng qua tai nghe được."
            />
          </div>
        )}

        {!prefs.asio && (
          <>
            <label>Kích thước bộ đệm</label>
            <Select value={prefs.buffer ?? 256} options={BUFFERS} onChange={(v) => apply({ buffer: v })} />
            <p className="help">Bộ đệm nhỏ giảm độ trễ giữa lúc hát và lúc nghe lại giọng mình. Tăng lên nếu nghe tiếng rè.</p>
          </>
        )}

        {audio && (
          <div className="status-box">
            <span>Đầu ra</span>
            <b>{audio.output}</b>
            <span>Micro</span>
            <b className={audio.inputError ? "err" : ""}>{audio.inputError ?? audio.input ?? "Không có"}</b>
            <span>Chế độ</span>
            <b>{audio.asio ? `ASIO · ${audio.asio}` : audio.exclusive ? `Độ trễ thấp · bộ đệm ${audio.buffer ?? "?"} mẫu` : "Thường (dùng chung)"}</b>
            <span>Tần số lấy mẫu</span>
            <b>{(audio.sampleRate / 1000).toFixed(1)} kHz</b>
          </div>
        )}

        {latency?.mic && (
          <div className="status-box latency-box">
            <span>Độ trễ giọng (đo thật)</span>
            <b className={latency.totalMs > 40 ? "err" : ""}>{Math.round(latency.totalMs)} ms</b>
            <span>Micro → app</span>
            <b>
              {latency.inputMs.toFixed(1)} ms <small>(mỗi gói {latency.inBlockMs.toFixed(1)} ms)</small>
            </b>
            <span>Chờ giữa hai luồng</span>
            <b>{latency.queueMs.toFixed(1)} ms</b>
            <span>Autotune / xử lý</span>
            <b>{latency.chainMs.toFixed(1)} ms</b>
            <span>App → tai nghe</span>
            <b>
              {latency.outputMs.toFixed(1)} ms <small>(mỗi gói {latency.outBlockMs.toFixed(1)} ms)</small>
            </b>
          </div>
        )}
        {latency?.mic && (
          <p className="help">
            Dưới 20 ms gần như không nhận ra, 20–40 ms nghe hơi vọng, trên 40 ms thấy rõ trễ. Chưa tính độ trễ bên trong tai nghe/micro USB (thường thêm vài ms).
            {audio && audio.buffer === null && " Windows đang dùng bộ đệm mặc định của thiết bị, nên mục Kích thước bộ đệm chưa có tác dụng."}
          </p>
        )}

        <div className="row" style={{ justifyContent: "flex-end", marginTop: 20 }}>
          <button className="btn" disabled={busy} onClick={() => apply({})}>
            Kết nối lại
          </button>
          <button className="btn primary" onClick={() => set({ settingsOpen: false })}>
            Xong
          </button>
        </div>
      </div>
    </div>
  );
}
