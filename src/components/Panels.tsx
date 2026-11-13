import { useEffect, useRef, useState } from "react";
import { api, errorText, onBackingProgress, type BackingStyle, type LyricCandidate } from "../lib/api";
import { backingChoice, hasFixes, lyricIssues, loadVideo, startLyrics, onBackingChange, setBacking, songParts, lyricsBusy, lyricsPick, refitWithFixes, lyricsSearch, rememberLyricsSearch, rememberTransform, replaceLyrics, switchSource, switchToVocalRemover, transform } from "../lib/loader";
import { formatTime, HARMONIES, keyName, NOTE_NAMES, SCALES } from "../lib/music";
import { FX_PRESETS, SOUND_KEYS, TUNE_PRESETS, type Preset } from "../lib/presets";
import { useStore, type MelodyLook, type Tab } from "../lib/store";
import { songFromVideo } from "../lib/sources";
import { cancelExport, startExport } from "../lib/exportJob";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyText, geminiPrompt } from "../lib/imagePrompt";
import type { Backdrop, LyricStyle, Orientation } from "../lib/videoExport";
import { exportPrefs, saveExportPrefs } from "../lib/exportPrefs";
import type { ExportPrefs } from "../lib/library";
import { db, Group, ms, ParamSlider, ParamToggle, pct, Segmented, Select, semis, Slider, Toggle } from "./Controls";

function matches(values: Record<string, number>, params: Record<string, number>) {
  return Object.entries(values).every(([k, v]) => Math.abs((params[k] ?? 0) - v) < 1e-3);
}

function PresetRow({ presets }: { presets: Preset[] }) {
  const params = useStore((s) => s.params);
  const setParams = useStore((s) => s.setParams);
  return (
    <div className="presets">
      {presets.map((p) => (
        <button key={p.name} title={p.hint} className={`preset ${matches(p.values, params) ? "on" : ""}`} onClick={() => setParams(p.values)}>
          {p.name}
        </button>
      ))}
    </div>
  );
}

/** Save the current autotune + effects combination under a name. */
function MyPresets() {
  const myPresets = useStore((s) => s.myPresets);
  const params = useStore((s) => s.params);
  const setParams = useStore((s) => s.setParams);
  const savePreset = useStore((s) => s.savePreset);
  const deletePreset = useStore((s) => s.deletePreset);
  const toast = useStore((s) => s.toast);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const save = () => {
    const n = name.trim();
    if (!n) return;
    const values: Record<string, number> = {};
    for (const k of SOUND_KEYS) values[k] = params[k];
    savePreset(n, values);
    setNaming(false);
    setName("");
    toast(`Đã lưu "${n}"`, "success");
  };

  return (
    <Group
      title="Mẫu của tôi"
      extra={
        !naming && (
          <button className="badge muted" style={{ cursor: "pointer" }} onClick={() => setNaming(true)}>
            + Lưu hiện tại
          </button>
        )
      }
    >
      {naming && (
        <div className="name-row">
          <input
            autoFocus
            className="text-input"
            placeholder="Đặt tên cho âm thanh này…"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <button className="btn small primary" onClick={save} disabled={!name.trim()}>
            Lưu
          </button>
        </div>
      )}
      {myPresets.length ? (
        <div className="presets">
          {myPresets.map((p) => (
            <span key={p.name} className={`preset my ${matches(p.values, params) ? "on" : ""}`}>
              <button onClick={() => setParams(p.values)} title="Áp dụng">
                {p.name}
              </button>
              <button className="x" title="Xóa" onClick={() => deletePreset(p.name)}>
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        !naming && <p className="help" style={{ marginTop: 0 }}>Chỉnh autotune và hiệu ứng rồi lưu bộ cài đặt ở đây.</p>
      )}
    </Group>
  );
}

export function TunePanel() {
  const params = useStore((s) => s.params);
  const setParam = useStore((s) => s.setParam);
  const setParams = useStore((s) => s.setParams);
  const song = useStore((s) => s.song);
  const detected = song?.info?.key;
  const keyAuto = song?.keyAuto ?? true;
  const patchSong = useStore((s) => s.patchSong);

  const setKey = (p: Record<string, number>) => {
    patchSong({ keyAuto: false });
    setParams(p);
  };

  return (
    <div className="panel">
      <Group title="Autotune">
        <ParamToggle name="tune_enabled" label="Chỉnh cao độ" hint="Kéo giọng bạn về đúng tông bài hát" />
        <PresetRow presets={TUNE_PRESETS} />
      </Group>
      <MyPresets />

      <Group
        title="Tông"
        extra={
          detected && (
            <span className={`badge ${keyAuto ? "" : "muted"}`} title={`Nhận diện với độ tin cậy ${Math.round(detected.confidence * 100)}%`}>
              {keyAuto ? "Tự động" : "Thủ công"}
            </span>
          )
        }
      >
        <div className="two">
          <Select value={Math.round(params.tune_key)} options={NOTE_NAMES.map((n, i) => ({ label: n, value: i }))} onChange={(v) => setKey({ tune_key: v })} />
          <Select value={Math.round(params.tune_scale)} options={SCALES.map((s, i) => ({ label: s.name, value: i }))} onChange={(v) => setKey({ tune_scale: v })} />
        </div>
        {detected && !keyAuto && (
          <p className="help">
            Tông nhận diện của bài: {keyName(detected.tonic + Math.round(song?.info?.semitones ?? 0), detected.minor ? 2 : 1)}.{" "}
            <button
              style={{ color: "var(--accent)", fontWeight: 600 }}
              onClick={() => {
                patchSong({ keyAuto: true });
                setParams({ tune_key: ((detected.tonic + Math.round(song?.info?.semitones ?? 0)) % 12 + 12) % 12, tune_scale: detected.minor ? 2 : 1 });
              }}
            >
              Dùng tông này
            </button>
          </p>
        )}
      </Group>

      <Group title="Hiệu chỉnh">
        <ParamSlider name="tune_retune_ms" label="Tốc độ chỉnh" min={0} max={400} step={1} format={(v) => (v < 1 ? "Tức thì" : ms(v))} left="Máy móc" right="Tự nhiên" reset={40} />
        <ParamSlider name="tune_amount" label="Mức độ" min={0} max={1} format={pct} reset={1} />
        <ParamSlider name="tune_humanize" label="Tự nhiên hóa" min={0} max={1} format={pct} reset={0.3} left="Chặt" right="Thả lỏng nốt ngân" />
        <ParamSlider name="tune_flex" label="Flex-tune" min={0} max={50} step={1} format={(v) => (v < 1 ? "Tắt" : `${Math.round(v)}¢`)} left="Chỉnh hết" right="Giữ biểu cảm" reset={0} />
        <ParamSlider name="tune_sensitivity" label="Ngưỡng nhận diện" min={0.5} max={0.95} format={pct} reset={0.8} />
      </Group>

      <Group title="Vibrato">
        <ParamSlider name="tune_vibrato_depth" label="Độ sâu" min={0} max={80} step={1} format={(v) => (v < 1 ? "Tắt" : `${Math.round(v)}¢`)} reset={0} />
        <ParamSlider name="tune_vibrato_rate" label="Tốc độ" min={3} max={8} step={0.1} format={(v) => `${v.toFixed(1)} Hz`} reset={5.5} />
      </Group>

      <Group title="Chất giọng">
        <ParamSlider name="tune_transpose" label="Dịch cao độ" min={-12} max={12} step={1} format={semis} reset={0} />
        <ParamSlider name="tune_formant" label="Formant" min={-8} max={8} step={0.5} format={semis} left="Trầm hơn" right="Sáng hơn" reset={0} />
        <ParamSlider name="tune_mix" label="Tỉ lệ xử lý / gốc" min={0} max={1} format={pct} reset={1} />
      </Group>

      <Group title="Bè">
        <div className="two" style={{ marginBottom: 14 }}>
          <Select value={Math.round(params.harmony_a)} options={HARMONIES} onChange={(v) => setParam("harmony_a", v)} />
          <Select value={Math.round(params.harmony_b)} options={HARMONIES} onChange={(v) => setParam("harmony_b", v)} />
        </div>
        <ParamSlider name="harmony_level" label="Mức bè" min={0} max={1} format={pct} reset={0.5} />
        <ParamSlider name="harmony_spread" label="Độ rộng stereo" min={0} max={1} format={pct} reset={0.7} />
        <ParamSlider name="doubler" label="Nhân đôi giọng" min={0} max={1} format={(v) => (v < 0.01 ? "Tắt" : pct(v))} reset={0} />
        <p className="help">Bè đi theo thang âm, nên "quãng 3 trên" luôn là nốt thuộc tông.</p>
      </Group>
    </div>
  );
}

export function VoicePanel() {
  return (
    <div className="panel">
      <Group title="Hiệu ứng giọng">
        <PresetRow presets={FX_PRESETS} />
      </Group>
      <MyPresets />
      <Group title="Đầu vào">
        <ParamSlider name="vocal_gain_db" label="Độ lợi mic" min={-12} max={24} step={0.5} format={db} reset={0} />
        <ParamSlider name="gate_db" label="Cổng lọc ồn" min={-80} max={-20} step={1} format={(v) => (v <= -79 ? "Tắt" : `${Math.round(v)} dB`)} reset={-50} />
        <ParamSlider name="hpf_hz" label="Cắt trầm" min={20} max={400} step={1} format={(v) => `${Math.round(v)} Hz`} reset={90} />
      </Group>
      <Group title="Âm sắc">
        <ParamSlider name="eq_low_db" label="Độ ấm" min={-12} max={12} step={0.5} format={db} reset={0} />
        <ParamSlider name="eq_presence_db" label="Độ rõ" min={-12} max={12} step={0.5} format={db} reset={2} />
        <ParamSlider name="eq_air_db" label="Độ thoáng" min={-12} max={12} step={0.5} format={db} reset={2} />
        <ParamSlider name="deesser" label="Giảm âm xì" min={0} max={1} format={pct} reset={0.4} />
        <ParamSlider name="comp" label="Nén" min={0} max={1} format={pct} reset={0.5} />
      </Group>
      <Group title="Tiếng vọng">
        <ParamSlider name="delay_mix" label="Mức" min={0} max={0.8} format={pct} reset={0} />
        <ParamSlider name="delay_ms" label="Thời gian" min={60} max={1200} step={5} format={ms} reset={320} />
        <ParamSlider name="delay_feedback" label="Số lần lặp" min={0} max={0.9} format={pct} reset={0.3} />
      </Group>
      <Group title="Vang">
        <ParamSlider name="reverb_mix" label="Mức" min={0} max={0.8} format={pct} reset={0.18} />
        <ParamSlider name="reverb_size" label="Kích thước phòng" min={0} max={1} format={pct} reset={0.7} />
        <ParamSlider name="reverb_damp" label="Độ tắt dần" min={0} max={1} format={pct} reset={0.4} />
      </Group>
    </div>
  );
}

export function MixPanel() {
  const hasGuide = useStore((s) => s.song?.info?.hasGuide ?? false);
  const vocalRemoved = useStore((s) => s.song?.info?.vocalRemoved ?? false);
  const latency = useStore((s) => s.params.record_latency_ms);
  const setParam = useStore((s) => s.setParam);
  return (
    <div className="panel">
      <Group title="Âm lượng">
        <ParamSlider name="instrumental" label="Nhạc nền" min={0} max={1.2} format={pct} reset={0.85} />
        <ParamSlider name="vocal" label="Giọng bạn" min={0} max={1.5} format={pct} reset={0.9} />
        {hasGuide && !vocalRemoved && (
          <ParamSlider name="guide" label="Giọng ca sĩ gốc (hát mẫu)" min={0} max={1} format={(v) => (v < 0.01 ? "Tắt" : pct(v))} reset={0} />
        )}
        <ParamSlider name="master" label="Tổng" min={0} max={1.2} format={pct} reset={0.9} />
      </Group>
      {hasGuide && !vocalRemoved && <PartsGroup />}
      {hasGuide && !vocalRemoved && <BackingGroup />}
      <Group title="Nghe lại">
        <ParamToggle name="monitor" label="Nghe giọng mình" hint="Dùng tai nghe để tránh bị hú qua loa" />
      </Group>
      <Group title="Thu âm">
        <Toggle
          on={latency < 0}
          onChange={(auto) => setParam("record_latency_ms", auto ? -1 : 40)}
          label="Tự bù độ trễ"
          hint="Căn giọng thu cho khớp với nhạc"
        />
        {latency >= 0 && <ParamSlider name="record_latency_ms" label="Độ lệch thủ công" min={0} max={300} step={1} format={ms} />}
      </Group>
    </div>
  );
}

export function SongPanel() {
  const song = useStore((s) => s.song);
  const info = song?.info;
  const [semi, setSemi] = useState(0);
  const [tempo, setTempo] = useState(1);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setSemi(info?.semitones ?? 0);
    setTempo(info?.tempo ?? 1);
  }, [info?.semitones, info?.tempo]);

  if (!song) return null;

  const separating = !!info?.separating;
  const commit = (s: number, t: number) => {
    setSemi(s);
    setTempo(t);
    // Saved for this song right away; rendering waits for a pause in clicks.
    rememberTransform(s, t);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => transform(s, t), 450);
  };

  const busyLoading = song.phase === "searching" || song.phase === "downloading";

  const dim = separating ? { opacity: 0.45, pointerEvents: "none" as const } : undefined;
  return (
    <div className="panel">
      <Group
        title="Tông và nhịp độ"
        extra={song.busy ? <span className="badge muted">{song.busy}</span> : separating && <span className="badge muted">Sau khi tách</span>}
      >
        <div className="kv-row" style={dim}>
          <span className="kv-label">Tông</span>
          <div className="stepper small">
            <button onClick={() => commit(Math.max(-6, semi - 1), tempo)}>−</button>
            <div className="val">{semis(semi)}</div>
            <button onClick={() => commit(Math.min(6, semi + 1), tempo)}>+</button>
          </div>
          <span className="kv-note">{info?.key ? `gốc ${keyName(info.key.tonic, info.key.minor ? 2 : 1)}` : ""}</span>
        </div>
        <div style={dim}>
          <Slider label="Tốc độ" value={tempo} min={0.7} max={1.3} step={0.05} format={pct} reset={1} onChange={(v) => commit(semi, v)} left="Chậm hơn" right="Nhanh hơn" />
        </div>
        <p className="help">
          Dời tông về tầm giọng của bạn; autotune tự đổi theo.{separating && " Dùng được khi AI tách xong."}
        </p>
      </Group>

      <Group title="Bản thu">
        {song.originals
          .filter((r, i) => i === 0 || r.score >= 0)
          .slice(0, 6)
          .map((r) => (
            <button
              key={r.video.id}
              className={`source ${song.sourceId === r.video.id && !info?.vocalRemoved ? "on" : ""}`}
              onClick={() => (song.sourceId !== r.video.id || info?.vocalRemoved) && switchSource(r)}
              disabled={busyLoading}
            >
              <img className="thumb" src={`https://i.ytimg.com/vi/${r.video.id}/mqdefault.jpg`} alt="" loading="lazy" />
              <div style={{ minWidth: 0 }}>
                <div className="st">{r.video.title}</div>
                <div className="sc">
                  {r.video.channel} · {formatTime(r.video.duration ?? 0)}
                </div>
              </div>
            </button>
          ))}
        {song.sourcePath && (
          <button className={`source ${info?.vocalRemoved ? "on" : ""}`} onClick={() => !info?.vocalRemoved && switchToVocalRemover()} disabled={busyLoading}>
            <div className="thumb" style={{ display: "grid", placeItems: "center", fontSize: 16 }}>
              ✂︎
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="st">Lọc giọng cơ bản</div>
              <div className="sc">Tức thì, chất lượng thấp hơn</div>
            </div>
          </button>
        )}
        {!song.originals.length && <p className="help">Đang tìm bản thu gốc…</p>}
        <p className="help">Chọn bản khác nếu bản này có đoạn dạo dài hoặc là bản live.</p>
      </Group>

      <LyricsGroup />

      <AidsGroup />

      <TrimGroup />

      <VideoGroup />

      <ExportVideo />
    </div>
  );
}

/** Render the song as a karaoke video (instrumental + lyrics) to MP4. */
function ExportVideo() {
  const song = useStore((s) => s.song);
  const job = useStore((s) => s.exportJob);
  const songId = song?.meta.id;
  // Each song keeps its own choices (shape, lyric style, background, frame rate, picture).
  const [prefs, setPrefs] = useState<ExportPrefs>(() => exportPrefs(songId));
  useEffect(() => setPrefs(exportPrefs(songId)), [songId]);
  const change = (patch: Partial<ExportPrefs>) => songId && setPrefs(saveExportPrefs(songId, patch));
  const { orientation, style, backdrop } = prefs as { orientation: Orientation; style: LyricStyle; backdrop: Backdrop };
  const image = prefs.image ?? null;
  const setOrientation = (v: Orientation) => change({ orientation: v });
  const setStyle = (v: LyricStyle) => change({ style: v });
  const setBackdrop = (v: Backdrop) => change({ backdrop: v });
  // This song's own picture: a copy kept in the cache, chosen from any file.
  const picker = useRef<HTMLInputElement>(null);
  const pickImage = async (file: File) => {
    if (!songId) return;
    try {
      const ext = (file.name.split(".").pop() ?? "").toLowerCase();
      const path = await invoke<string>("export_image_save", new Uint8Array(await file.arrayBuffer()), {
        headers: { "x-ext": ext === "jpeg" ? "jpg" : ext, "x-song": songId },
      });
      change({ image: path, backdrop: "image" });
    } catch (e) {
      useStore.getState().toast(`Không dùng được hình này: ${errorText(e)}`, "error");
    }
  };
  const ready = !!song?.info && !song.info.separating && song.phase === "ready";
  const progress = job?.progress ?? null;

  return (
    <Group title="Xuất video karaoke">
      <div className="ex-field">
        <span className="ex-label">Khung hình</span>
        <Segmented
          value={orientation}
          onChange={setOrientation}
          options={[
            { label: "Ngang 16:9", value: "landscape" },
            { label: "Dọc 9:16", value: "portrait" },
          ]}
        />
      </div>
      <div className="ex-field">
        <span className="ex-label">Kiểu chữ</span>
        <Segmented
          value={style}
          onChange={setStyle}
          options={[
            { label: "Cuộn giữa", value: "scroll" },
            { label: "Cổ điển", value: "classic" },
            { label: "Phụ đề", value: "subtitle" },
          ]}
        />
        <p className="help ex-help">
          {style === "scroll"
            ? "Lời cuộn ở giữa, câu đang hát to rõ (như màn hình hát)."
            : style === "classic"
              ? "Hai dòng ở dưới, trên trái dưới phải, luân phiên như đầu karaoke."
              : "Câu đang hát ở đáy màn hình, chừa trọn khung hình cho nền."}
        </p>
      </div>
      <div className="ex-field">
        <span className="ex-label">Nền</span>
        <div className="ex-tiles">
          {(
            [
              ["video", "▶", "Video gốc", song?.video?.status === "ready" ? "Video của bản thu" : "Tải về khi xuất"],
              ["artwork", "◐", "Ảnh bìa", "Làm mờ nhẹ"],
              ["plain", "✦", "Nền động", "Ánh sáng trôi"],
              ["image", "▣", "Hình riêng", image ? "Đã chọn" : "Chọn hoặc tạo"],
            ] as [Backdrop, string, string, string][]
          ).map(([v, icon, label, sub]) => (
            <button key={v} className={`ex-tile ${backdrop === v ? "on" : ""}`} onClick={() => setBackdrop(v)}>
              {v === "image" && image ? (
                <img src={convertFileSrc(image)} alt="" />
              ) : (
                <span className="ex-icon">{icon}</span>
              )}
              <span className="ex-name">{label}</span>
              <span className="ex-sub">{sub}</span>
            </button>
          ))}
        </div>
        {backdrop === "image" && (
          <div className="ex-own">
            <div className="ex-own-row">
              <button className={`btn small ${image ? "" : "primary"}`} onClick={() => picker.current?.click()} title="Chọn một hình trong máy làm nền">
                {image ? "Đổi hình…" : "Chọn hình…"}
              </button>
              <button
                className="btn small"
                onClick={() =>
                  void copyText(geminiPrompt(orientation, style))
                    .then(() =>
                      useStore
                        .getState()
                        .toast("Đã chép mô tả. Dán vào Gemini (Ctrl+V), tải ảnh về rồi chọn nó ở đây.", "success", {
                          label: "Mở Gemini",
                          run: () => void openUrl("https://gemini.google.com/app"),
                        }),
                    )
                    .catch((e) => useStore.getState().toast(errorText(e), "error"))
                }
                title="Chép sẵn lời bài hát, tên bài, khung ngang/dọc và yêu cầu nền karaoke: dán vào Gemini để tạo ảnh nền hợp bài này"
              >
                ✨ Chép mô tả
              </button>
            </div>
            <p className="help ex-help">
              {image
                ? "Hình phủ kín khung (cắt cho vừa), tối nhẹ phía dưới cho dễ đọc lời."
                : "Chọn hình trong máy, hoặc \"Chép mô tả\" rồi dán vào Gemini để tạo hình hợp bài này."}
            </p>
          </div>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pickImage(f);
          }}
        />
      </div>
      {progress === null ? (
        <button className="btn primary" style={{ width: "100%", marginTop: 4 }} disabled={!ready || (backdrop === "image" && !image)} onClick={() => void startExport(orientation, style, backdrop)}>
          Xuất video
        </button>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="progress">
            <div style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 8, alignItems: "center" }}>
            <span className="help" style={{ margin: 0 }}>
              Đang dựng video{job && job.title !== song?.meta.title ? ` "${job.title}"` : ""}… {Math.round(progress * 100)}%
            </span>
            <button className="btn small" onClick={cancelExport}>
              Hủy
            </button>
          </div>
        </div>
      )}
      <p className="help">
        Full HD MP4: nhạc nền đúng tông và nhịp độ đang chỉnh, lời chạy chữ; lưu trong thư mục bản thu.
        {!ready && " Dùng được khi bài đã tách giọng xong."}
      </p>
    </Group>
  );
}

/**
 * Pick the right lyrics by hand: search LRCLIB under the real title and
 * artist (the automatic lookup guesses them from the video title), or paste
 * lyrics. Choosing them fits them to the singer again.
 */
function LyricsGroup() {
  const song = useStore((s) => s.song);
  const aligning = useStore((s) => !!s.song?.aligning);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [results, setResults] = useState<LyricCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const songId = song?.meta.id;

  useEffect(() => {
    // What the user searched for last time, else the song's own names.
    // Songs saved before the title parsing improved: parse their video again.
    const meta = song?.meta.video ? songFromVideo(song.meta.video) : song?.meta;
    const q = songId ? lyricsSearch(songId) : null;
    setTitle(q?.title ?? meta?.title ?? "");
    setArtist(q?.artist ?? meta?.artist ?? "");
    setResults(null);
    setError(null);
    // Reset only when another song opens.
  }, [songId]);

  if (!song) return null;
  const recording = song.originals.find((r) => r.video.id === song.sourceId)?.video.duration ?? song.meta.duration;
  const busy = aligning || lyricsBusy();
  const ly = song.lyrics;
  const picked = lyricsPick(song.meta.id);
  const current = ly.status === "loading" ? "Đang tìm…" : ly.lines ? `${ly.lines.length} dòng, có mốc thời gian` : ly.plain ? "Lời thường (chưa có mốc thời gian)" : ly.instrumental ? "Nhạc không lời" : "Chưa có lời";

  const search = async () => {
    if (!title.trim()) return;
    rememberLyricsSearch(song.meta.id, title, artist);
    setSearching(true);
    setError(null);
    try {
      setResults(await api.searchLyrics(title, artist, recording ?? 0));
    } catch (e) {
      setError(errorText(e));
      setResults(null);
    } finally {
      setSearching(false);
    }
  };
  const openEditor = (mode: "edit" | "new") => useStore.getState().set({ lyricsEditor: mode });
  const use = (l: LyricCandidate["lyrics"], label: string) => {
    if (!replaceLyrics(l, { label, title: title.trim(), artist: artist.trim() })) return;
    setResults(null);
  };


  const nudge = (d: number) => useStore.getState().patchSong({ userOffset: Math.round((song.userOffset + d) * 100) / 100 });
  const has = !!(ly.lines || ly.plain);

  return (
    <Group title="Lời bài hát" extra={<span className="badge muted">{current}</span>}>
      <p className="help" style={{ margin: "0 0 8px" }}>
        Đang dùng: {picked ? <b>{picked.label}</b> : "lời app tự tìm"}
      </p>
      <span className="ex-label">Tìm lời khác</span>
      <input className="text-input wide" placeholder="Tên bài đúng" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
      <div className="name-row" style={{ marginTop: 6 }}>
        <input className="text-input" placeholder="Ca sĩ (không bắt buộc)" value={artist} onChange={(e) => setArtist(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        <button className="btn small primary" onClick={search} disabled={searching || !title.trim()}>
          {searching ? "Đang tìm…" : "Tìm"}
        </button>
      </div>
      {error && <p className="help err">Không tìm được: {error}</p>}
      {results && !results.length && <p className="help">Không có kết quả. Thử bỏ tên ca sĩ, viết tên bài khác đi, hoặc dán lời.</p>}
      {results && results.length > 0 && (
        <div style={{ marginBottom: 10, maxHeight: 280, overflowY: "auto" }}>
          {results.map((c, i) => {
            const off = recording && c.duration ? Math.round(c.duration - recording) : null;
            return (
              <button key={i} className="source" disabled={busy} onClick={() => use(c.lyrics, `${c.track} – ${c.artist} (${formatTime(c.duration)})`)} title={(c.lyrics.synced ?? c.lyrics.plain ?? "").slice(0, 400)}>
                <div style={{ minWidth: 0 }}>
                  <div className="st">{c.track}</div>
                  <div className="sc">
                    {c.artist}
                    {c.album ? ` · ${c.album}` : ""} · {formatTime(c.duration)}
                    {off !== null && off !== 0 ? ` (${off > 0 ? "+" : ""}${off}s)` : ""} · {c.lyrics.synced ? "có mốc thời gian" : "lời thường"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <span className="ex-label">Sửa lời</span>
      <div className="btn-grid">
        <button className="btn small" onClick={() => openEditor(has ? "edit" : "new")}>
          ✎ {has ? "Sửa toàn bộ" : "Viết lời"}
        </button>
        <button className="btn small" onClick={() => openEditor("new")} disabled={!has}>
          ＋ Dán lời mới
        </button>
        {hasFixes() && (
          <button className="btn small span2" disabled={busy} onClick={() => refitWithFixes()}>
            ↻ Canh lại theo chữ đã sửa
          </button>
        )}
      </div>

      <FitGroup />

      <span className="ex-label">Lệch lời</span>
      <div className="kv-row">
        <div className="stepper small">
          <button onClick={() => nudge(-0.1)} title="Lời sớm hơn ( [ )">−</button>
          <div className="val">{`${song.userOffset >= 0 ? "+" : ""}${song.userOffset.toFixed(2)} s`}</div>
          <button onClick={() => nudge(0.1)} title="Lời muộn hơn ( ] )">+</button>
        </div>
        {song.userOffset !== 0 ? (
          <button className="btn small" onClick={() => nudge(-song.userOffset)}>
            Đặt lại
          </button>
        ) : (
          <span className="kv-note">
            phím <span className="kbd">[</span> <span className="kbd">]</span>
          </span>
        )}
      </div>
      {busy && <p className="help">Đang khớp lời; đổi lời sau khi xong.</p>}
    </Group>
  );
}

/** Where the original singer sings (a duet's other voice) and where the harmony plays. */
function PartsGroup() {
  const song = useStore((s) => s.song);
  const set = useStore((s) => s.set);
  // Re-read after the editor saves.
  useStore((s) => s.partsEditor);
  if (!song) return null;
  const parts = songParts(song.meta.id);
  const canPick = !!song.lyrics.lines && !song.info?.separating;
  return (
    <Group title="Giọng gốc theo đoạn">
      <button className="btn small" style={{ width: "100%", marginBottom: 10 }} disabled={!canPick} onClick={() => set({ partsEditor: true })}>
        ✂ Chọn đoạn theo dòng lời…
      </button>
      {parts.original.length > 0 && (
        <ParamSlider name="lead" label="Giọng gốc ở đoạn đã chọn" min={0} max={1.2} format={pct} reset={0.85} />
      )}
      <p className="help">
        {parts.original.length
          ? `Ca sĩ gốc hát ${parts.original.length} đoạn; bạn hát phần còn lại. `
          : "Bài song ca: chọn phần của giọng kia để ca sĩ gốc tự hát, bạn hát phần mình. "}
        {parts.backing.length ? `Bè chỉ có ở ${parts.backing.length} đoạn đã chọn.` : "Bè (nếu bật) có cả bài."}
        {!song.lyrics.lines && " Cần lời theo thời gian để chọn đoạn."}
      </p>
    </Group>
  );
}

/** Fit again (fast, or heard by Whisper), and the lines the last fit could hardly place. */
function FitGroup() {
  const song = useStore((s) => s.song);
  const aligning = useStore((s) => !!s.song?.aligning);
  if (!song) return null;
  const ready = !!song.sourceId && !!song.info && !song.info.separating && !song.info.vocalRemoved;
  const issues = lyricIssues(song.meta.id);
  const tempo = song.info?.tempo ?? 1;
  return (
    <div style={{ marginBottom: 12 }}>
      <span className="ex-label">Khớp lời theo giọng ca sĩ</span>
      <div className="btn-grid">
        <button className="btn small" disabled={!ready || aligning} onClick={() => startLyrics(song.meta.id, "fast")} title="Canh theo giọng ca sĩ bằng MMS, khoảng 1 phút">
          ⚡ Khớp nhanh
        </button>
        <button className="btn small" disabled={!ready || aligning} onClick={() => startLyrics(song.meta.id, "whisper")} title="Whisper nghe cả bài rồi mới canh, khoảng 6–7 phút: sửa được chỗ ca sĩ hát khác lời">
          🎧 Khớp kỹ
        </button>
      </div>
      {issues.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="help" style={{ marginBottom: 4 }}>
            <b>Dòng cần kiểm tra</b> ({issues.length}): canh có thể sai. Bấm để nghe; sửa bằng ✎ Sửa lời hoặc thử Khớp kỹ.
          </div>
          {issues.map((it, k) => (
            <button
              key={k}
              className="source"
              onClick={() => void api.seek(Math.max(0, (it.start + song.userOffset - 1) / tempo))}
              title={`Điểm canh ${it.score}`}
            >
              <div style={{ minWidth: 0 }}>
                <div className="st">⚠ {it.text}</div>
                <div className="sc">{formatTime(it.start)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Kinds of harmony; "" = off. The record's own backing has no interval to choose. */
const BACKING_KINDS: { label: string; value: "" | BackingStyle }[] = [
  { label: "Tắt", value: "" },
  { label: "Bè gốc của bài", value: "original" },
  { label: "Hợp xướng “ooh” (tự tạo)", value: "choir" },
  { label: "Giọng ca sĩ (tự tạo)", value: "voice" },
];

const BACKINGS: { label: string; value: string }[] = [
  { label: "Quãng 3 trên", value: "2" },
  { label: "Quãng 3 dưới", value: "-2" },
  { label: "Quãng 3 trên + quãng 3 dưới", value: "2,-2" },
  { label: "Quãng 5 dưới", value: "-4" },
];

/** A harmony made from the original singer's separated vocal, on stage and in exported videos. */
function BackingGroup() {
  const busy = useStore((s) => s.song?.busy ?? null);
  const separating = useStore((s) => !!s.song?.info?.separating);
  const [choice, setChoice] = useState(() => backingChoice().degrees.join(","));
  const [style, setStyle] = useState<BackingStyle>(() => backingChoice().style);
  const apply = (c: string, st: BackingStyle) => void setBacking(c ? c.split(",").map(Number) : [], st);
  // Splitting the record's own backing: minutes the first time.
  const sourceId = useStore((s) => s.song?.sourceId);
  const [splitting, setSplitting] = useState<{ fraction: number; left: number | null } | null>(null);
  useEffect(() => {
    setSplitting(null);
    // Time left from the pace since this panel first heard of it.
    let first: { at: number; fraction: number } | null = null;
    const off = onBackingProgress((p) => {
      if (p.source !== sourceId) return;
      if (p.fraction >= 1) {
        setSplitting(null);
        return;
      }
      const now = performance.now();
      first ??= { at: now, fraction: p.fraction };
      const done = p.fraction - first.fraction;
      const left = done > 0.02 ? ((now - first.at) / done) * (1 - p.fraction) : null;
      setSplitting({ fraction: p.fraction, left });
    });
    return () => void off.then((f) => f());
  }, [sourceId]);
  // Each song has its own: show this one's when another song opens.
  const songId = useStore((s) => s.song?.meta.id);
  useEffect(() => {
    setChoice(backingChoice().degrees.join(","));
    setStyle(backingChoice().style);
  }, [songId]);
  // Turned on from the parts page: show it.
  useEffect(
    () =>
      onBackingChange(() => {
        setChoice(backingChoice().degrees.join(","));
        setStyle(backingChoice().style);
      }),
    [],
  );
  return (
    <Group title="Bè">
      <div style={{ marginBottom: 12, opacity: separating ? 0.45 : 1, pointerEvents: separating ? "none" : undefined }}>
        <Select
          value={choice ? style : ""}
          options={BACKING_KINDS}
          onChange={(v) => {
            if (!v) {
              setChoice("");
              apply("", style);
              return;
            }
            // The interval stays as chosen before (a third above at first).
            const c = choice || "2";
            setChoice(c);
            setStyle(v);
            apply(c, v);
          }}
        />
      </div>
      {choice && style !== "original" && (
        <div style={{ marginBottom: 12 }}>
          <Select
            value={choice}
            options={BACKINGS}
            onChange={(v) => {
              setChoice(v);
              apply(v, style);
            }}
          />
        </div>
      )}
      {splitting && (
        <div style={{ marginBottom: 12 }}>
          <div className="progress">
            <div style={{ width: `${splitting.fraction * 100}%` }} />
          </div>
          <p className="help" style={{ marginTop: 6 }}>
            Đang tách bè gốc… {Math.round(splitting.fraction * 100)}%
            {splitting.left !== null && ` · còn khoảng ${Math.max(1, Math.round(splitting.left / 60000))} phút`}. Chỉ lần đầu; bè vang lên khi xong.
          </p>
        </div>
      )}
      {/* The record's own backing is as loud as on the record (it follows the music). */}
      {choice && style !== "original" && <ParamSlider name="backing" label="Mức bè" min={0} max={1} format={pct} reset={0.35} />}
      <p className="help">
        {style === "choir"
          ? "Một nhóm giọng tổng hợp ngân “ooh” theo giai điệu, đúng thang âm của bài: sạch, không vỡ tiếng."
          : style === "voice"
            ? "Giọng ca sĩ gốc được dịch thành bè, có lời nhưng có thể rè ở chỗ giọng tách chưa sạch."
            : "Bè có sẵn trong bản thu (ca sĩ hoặc dàn bè hát), AI tách khỏi giọng chính: vang lên đúng những chỗ và đúng độ to như trong bài (theo nhạc nền). Lần đầu mất vài phút, sau đó có ngay."}{" "}
        Không cần micro; bè được trộn vào nhạc nền khi hát và có trong video xuất ra.
        {separating && " Dùng được khi AI tách giọng xong."}
        {busy === "Đang tạo bè…" && " Đang tạo bè…"}

      </p>
    </Group>
  );
}

/** The recording's own video behind the lyrics, on stage and in exports. */
function VideoGroup() {
  const videoBg = useStore((s) => s.videoBg);
  const setVideoBg = useStore((s) => s.setVideoBg);
  const video = useStore((s) => s.song?.video);
  return (
    <Group title="Video gốc">
      <Toggle
        on={videoBg}
        onChange={(on) => {
          setVideoBg(on);
          if (on) void loadVideo();
        }}
        label="Dùng video gốc làm nền (HD)"
        hint="Tải video của bài (tối đa 1080p) để chạy sau lời khi hát và khi xuất video karaoke."
      />
      {videoBg && video && (
        <p className={`help ${video.status === "error" ? "err" : ""}`} style={{ marginTop: 6 }}>
          {video.status === "loading"
            ? `Đang tải video HD… ${Math.round(video.progress * 100)}%`
            : video.status === "ready"
              ? "Video HD đã sẵn sàng."
              : `Không tải được video: ${video.message ?? ""}`}
        </p>
      )}
    </Group>
  );
}

/** Singing aids on the lyrics, on stage and in exported videos. */
function AidsGroup() {
  const aids = useStore((s) => s.aids);
  const setAids = useStore((s) => s.setAids);
  const hasMelody = useStore((s) => !!s.song?.melody?.length);
  const bpm = useStore((s) => s.song?.beats?.bpm);
  return (
    <Group title="Gợi ý khi hát">
      <div className="ex-field">
        <span className="ex-label">Giai điệu gốc trên lời</span>
        <Select
          value={aids.pitch ? aids.look : "off"}
          options={[
            { label: "Đường dưới câu", value: "ribbon" },
            { label: "Chấm trên chữ", value: "dots" },
            { label: "Làn nốt (kiểu SingStar)", value: "lane" },
            { label: "Tắt", value: "off" },
          ]}
          onChange={(v) => (v === "off" ? setAids({ pitch: false }) : setAids({ pitch: true, look: v as MelodyLook }))}
        />
        <p className="help ex-help">
          {!aids.pitch
            ? "Không hiện giai điệu trên lời."
            : aids.look === "ribbon"
              ? "Đường mảnh dưới câu đang hát, lên xuống theo giai điệu, sáng dần theo lúc hát."
              : aids.look === "dots"
                ? "Mỗi nốt một chấm trên chữ, cao là lên giọng; sáng lên khi hát tới."
                : "Dải nốt trôi qua vạch “bây giờ” trong video xuất; trên màn hình hát là khung giai điệu bên dưới."}
          {!hasMelody && " Có sau khi AI tách giọng và dò giai điệu xong."}
        </p>
      </div>
      <Toggle
        on={aids.beat}
        onChange={(on) => setAids({ beat: on })}
        label="Đếm vào câu theo nhịp"
        hint={bpm ? `Chấm đếm sáng theo từng phách của bài (${Math.round(bpm)} BPM).` : "Chấm đếm theo phách của bài: có sau khi AI tách giọng xong."}
      />
      <p className="help">Hiện cả khi hát và trong video xuất ra. Câu dài tự xuống dòng ở chỗ lấy hơi.</p>
    </Group>
  );
}

/** Skip an ad or talk at the start and end of this song's recording. */
function TrimGroup() {
  const song = useStore((s) => s.song);
  const pos = useStore((s) => s.pos);
  const duration = useStore((s) => s.duration);
  const patchSong = useStore((s) => s.patchSong);
  if (!song?.info) return null;
  const tempo = song.info.tempo || 1;
  const trim = song.trim ?? { start: 0, end: 0 };
  // Recording seconds (the trim is kept in the original recording's time).
  const length = duration * tempo;
  const set = (t: Partial<typeof trim>) => {
    const next = { ...trim, ...t };
    next.start = Math.max(0, Math.min(length - 5, Math.round(next.start)));
    next.end = Math.max(0, Math.min(length - next.start - 5, Math.round(next.end)));
    patchSong({ trim: next });
  };
  const row = (label: string, value: number, change: (v: number) => void, here: () => void) => (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <div className="stepper small">
        <button onClick={() => change(value - 1)}>−</button>
        <div className="val">{value ? formatTime(value) : "Không"}</div>
        <button onClick={() => change(value + 1)}>+</button>
      </div>
      <button className="btn small" onClick={here} title="Lấy đúng chỗ đang phát">
        Tại đây
      </button>
    </div>
  );
  return (
    <Group title="Bỏ quảng cáo">
      {row(
        "Đầu bài",
        trim.start,
        (v) => set({ start: v }),
        () => set({ start: pos * tempo }),
      )}
      {row(
        "Cuối bài",
        trim.end,
        (v) => set({ end: v }),
        () => set({ end: (duration - pos) * tempo }),
      )}
      <p className="help">
        Nghe tới chỗ hết quảng cáo đầu bài (hoặc chỗ quảng cáo cuối bài bắt đầu) rồi bấm <b>Tại đây</b>. Áp dụng cả khi xuất video.
      </p>
    </Group>
  );
}

export function SidebarTabs({ lab = false }: { lab?: boolean }) {
  const tab = useStore((s) => s.tab);
  const set = useStore((s) => s.set);
  const options: { label: string; value: Tab }[] = [
    { label: "Chỉnh", value: "tune" },
    { label: "Giọng", value: "voice" },
    { label: "Trộn", value: "mix" },
  ];
  if (!lab) options.push({ label: "Bài hát", value: "song" });
  return <Segmented value={tab} onChange={(t) => set({ tab: t })} options={options} />;
}
