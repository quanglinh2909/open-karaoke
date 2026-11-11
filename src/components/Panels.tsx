import { useEffect, useRef, useState } from "react";
import { api, errorText, type BackingStyle, type LyricCandidate } from "../lib/api";
import { backingChoice, hasFixes, lyricIssues, loadVideo, startLyrics, onBackingChange, setBacking, songParts, lyricsBusy, lyricsPick, refitWithFixes, lyricsSearch, rememberLyricsSearch, rememberTransform, replaceLyrics, switchSource, switchToVocalRemover, transform } from "../lib/loader";
import { formatTime, HARMONIES, keyName, NOTE_NAMES, SCALES } from "../lib/music";
import { FX_PRESETS, SOUND_KEYS, TUNE_PRESETS, type Preset } from "../lib/presets";
import { useStore, type Tab } from "../lib/store";
import { songFromVideo } from "../lib/sources";
import { cancelExport, startExport } from "../lib/exportJob";
import type { Backdrop, LyricStyle, Orientation } from "../lib/videoExport";
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
  const patchSong = useStore((s) => s.patchSong);
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

  const nudge = (d: number) => patchSong({ userOffset: Math.round((song.userOffset + d) * 100) / 100 });
  const busyLoading = song.phase === "searching" || song.phase === "downloading";

  return (
    <div className="panel">
      <Group
        title="Tông nhạc"
        extra={song.busy ? <span className="badge muted">{song.busy}</span> : separating && <span className="badge muted">Sau khi tách</span>}
      >
        <div className="stepper" style={separating ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
          <button onClick={() => commit(Math.max(-6, semi - 1), tempo)}>−</button>
          <div className="val">{semis(semi)}</div>
          <button onClick={() => commit(Math.min(6, semi + 1), tempo)}>+</button>
        </div>
        <p className="help">
          {info?.key ? `Tông gốc: ${keyName(info.key.tonic, info.key.minor ? 2 : 1)}. ` : ""}Dời tông bài về tầm giọng của bạn. Tông
          autotune tự đổi theo.
          {separating && " Dùng được ngay khi AI tách xong bài này."}
        </p>
      </Group>

      <Group title="Nhịp độ">
        <div style={separating ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
          <Slider label="Tốc độ" value={tempo} min={0.7} max={1.3} step={0.05} format={pct} reset={1} onChange={(v) => commit(semi, v)} left="Chậm hơn" right="Nhanh hơn" />
        </div>
      </Group>

      <VideoGroup />

      <TrimGroup />

      <LyricsGroup />

      <Group title="Canh lời" extra={!info?.vocalRemoved && info && <span className="badge">Khớp bản gốc</span>}>
        <div className="stepper">
          <button onClick={() => nudge(-0.1)} title="Lời sớm hơn ( [ )">−</button>
          <div className="val">{`${song.userOffset >= 0 ? "+" : ""}${song.userOffset.toFixed(2)} s`}</div>
          <button onClick={() => nudge(0.1)} title="Lời muộn hơn ( ] )">+</button>
        </div>
        <p className="help">
          Nhạc được tách từ chính bản thu mà lời được canh theo, nên thường tự khớp. Dùng{" "}
          <span className="kbd">[</span> và <span className="kbd">]</span> để chỉnh tinh.
          {song.userOffset !== 0 && (
            <>
              {" "}
              <button style={{ color: "var(--accent)", fontWeight: 600 }} onClick={() => nudge(-song.userOffset)}>
                Đặt lại
              </button>
            </>
          )}
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
            <div>
              <div className="st">Lọc giọng cơ bản</div>
              <div className="sc">Tức thì, chất lượng thấp hơn. Dùng khi AI không chạy được.</div>
            </div>
          </button>
        )}
        {!song.originals.length && <p className="help">Đang tìm bản thu gốc…</p>}
        <p className="help">AI tách giọng từ bản thu bạn chọn. Chọn bản khác nếu bản này có đoạn dạo dài hoặc là bản live.</p>
      </Group>

      <ExportVideo />
    </div>
  );
}

/** Render the song as a karaoke video (instrumental + lyrics) to MP4. */
function ExportVideo() {
  const song = useStore((s) => s.song);
  const job = useStore((s) => s.exportJob);
  const [orientation, setOrientation] = useState<Orientation>("landscape");
  // The lyric style is remembered between exports.
  const [style, setStyleState] = useState<LyricStyle>(() => {
    try {
      return (localStorage.getItem("openkaraoke.lyricStyle.v1") as LyricStyle) || "scroll";
    } catch {
      return "scroll";
    }
  });
  const setStyle = (v: LyricStyle) => {
    setStyleState(v);
    try {
      localStorage.setItem("openkaraoke.lyricStyle.v1", v);
    } catch {
      /* storage unavailable */
    }
  };
  // The background too: the recording's own video unless the artwork is chosen.
  const [backdrop, setBackdropState] = useState<Backdrop>(() => {
    try {
      const v = localStorage.getItem("openkaraoke.exportBackdrop.v1");
      return v === "artwork" || v === "plain" ? v : "video";
    } catch {
      return "video";
    }
  });
  const setBackdrop = (v: Backdrop) => {
    setBackdropState(v);
    try {
      localStorage.setItem("openkaraoke.exportBackdrop.v1", v);
    } catch {
      /* storage unavailable */
    }
  };
  const ready = !!song?.info && !song.info.separating && song.phase === "ready";
  const progress = job?.progress ?? null;

  return (
    <Group title="Xuất video karaoke">
      <Segmented
        value={orientation}
        onChange={setOrientation}
        options={[
          { label: "Ngang 16:9", value: "landscape" },
          { label: "Dọc 9:16", value: "portrait" },
        ]}
      />
      <div style={{ marginTop: 10 }}>
        <Segmented
          value={style}
          onChange={setStyle}
          options={[
            { label: "Cuộn giữa", value: "scroll" },
            { label: "Karaoke cổ điển", value: "classic" },
            { label: "Phụ đề", value: "subtitle" },
          ]}
        />
      </div>
      <p className="help" style={{ marginTop: 6 }}>
        {style === "scroll"
          ? "Lời cuộn ở giữa, câu đang hát to rõ (như màn hình hát)."
          : style === "classic"
            ? "Hai dòng ở dưới, trên trái dưới phải, luân phiên như đầu karaoke."
            : "Câu đang hát ở đáy màn hình, chừa trọn khung hình cho video."}
      </p>
      <div style={{ marginTop: 10 }}>
        <Segmented
          value={backdrop}
          onChange={setBackdrop}
          options={[
            { label: "Video gốc", value: "video" },
            { label: "Ảnh bài hát", value: "artwork" },
            { label: "Mặc định", value: "plain" },
          ]}
        />
      </div>
      <p className="help" style={{ marginTop: 6 }}>
        {backdrop === "video"
          ? `Video gốc của bản thu, Full HD${song?.video?.status === "ready" ? "" : " (tải về khi xuất)"}.`
          : backdrop === "artwork"
            ? "Ảnh bìa bài hát làm mờ, Full HD."
            : "Nền tối mặc định của ứng dụng, không dùng hình nào, Full HD."}
      </p>
      {progress === null ? (
        <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={!ready} onClick={() => void startExport(orientation, style, backdrop)}>
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
        Nhạc nền đã tách giọng (đúng tông và nhịp độ đang chỉnh) cùng lời chạy chữ, lưu thành MP4 trong thư mục bản thu.
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


  return (
    <Group title="Lời bài hát" extra={<span className="badge muted">{current}</span>}>
      <div className="name-row">
        <input className="text-input" placeholder="Tên bài đúng" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
      </div>
      <div className="name-row" style={{ marginTop: 6 }}>
        <input className="text-input" placeholder="Ca sĩ (không bắt buộc)" value={artist} onChange={(e) => setArtist(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        <button className="btn small primary" onClick={search} disabled={searching || !title.trim()}>
          {searching ? "Đang tìm…" : "Tìm lời"}
        </button>
      </div>
      <p className="help" style={{ marginTop: 6 }}>
        Đang dùng: {picked ? <b>{picked.label}</b> : "lời app tự tìm"}.
      </p>
      {error && <p className="help err">Không tìm được: {error}</p>}
      {results && !results.length && <p className="help">Không có kết quả. Thử bỏ tên ca sĩ, viết tên bài khác đi, hoặc dán lời.</p>}
      {results && results.length > 0 && (
        <div style={{ marginTop: 8, maxHeight: 280, overflowY: "auto" }}>
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
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        <button className="badge muted" style={{ cursor: "pointer" }} onClick={() => openEditor(ly.lines || ly.plain ? "edit" : "new")}>
          ✎ {ly.lines || ly.plain ? "Sửa toàn bộ lời" : "Viết lời cho bài này"}
        </button>
        {(ly.lines || ly.plain) && (
          <button className="badge muted" style={{ cursor: "pointer" }} onClick={() => openEditor("new")}>
            + Dán lời mới
          </button>
        )}
        {hasFixes() && (
          <button className="badge muted" style={{ cursor: "pointer" }} disabled={busy} onClick={() => refitWithFixes()}>
            ↻ Canh lại theo chữ đã sửa
          </button>
        )}
      </div>
      <FitGroup />
      <p className="help">
        Lời đúng bài là điều quan trọng nhất để khớp chính xác: AI nghe giọng ca sĩ rồi ghép với lời này, giữ chính tả của lời và sửa chỗ ca sĩ hát khác.
        {busy ? " Đang khớp lời, đổi lời sau khi xong." : " Chọn lời xong, app khớp lại theo giọng ca sĩ."}
      </p>
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
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="badge muted" style={{ cursor: "pointer" }} disabled={!ready || aligning} onClick={() => startLyrics(song.meta.id, "fast")} title="Canh theo giọng ca sĩ bằng MMS, khoảng 1 phút">
          ▶ Khớp nhanh
        </button>
        <button className="badge muted" style={{ cursor: "pointer" }} disabled={!ready || aligning} onClick={() => startLyrics(song.meta.id, "whisper")} title="Whisper nghe cả bài rồi mới canh, khoảng 6–7 phút">
          ▶ Khớp kỹ (Whisper)
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

const BACKINGS: { label: string; value: string }[] = [
  { label: "Tắt", value: "" },
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
    <Group title="Bè tự động">
      <div style={{ marginBottom: 12, opacity: separating ? 0.45 : 1, pointerEvents: separating ? "none" : undefined }}>
        <Select
          value={choice}
          options={BACKINGS}
          onChange={(v) => {
            setChoice(v);
            apply(v, style);
          }}
        />
      </div>
      {choice && (
        <div style={{ marginBottom: 12 }}>
          <Segmented
            value={style}
            options={[
              { label: "Hợp xướng “ooh”", value: "choir" },
              { label: "Giọng ca sĩ", value: "voice" },
            ]}
            onChange={(v) => {
              setStyle(v);
              apply(choice, v);
            }}
          />
        </div>
      )}
      {choice && <ParamSlider name="backing" label="Mức bè" min={0} max={1} format={pct} reset={0.35} />}
      <p className="help">
        {style === "choir"
          ? "Một nhóm giọng tổng hợp ngân “ooh” theo giai điệu, đúng thang âm của bài: sạch, không vỡ tiếng."
          : "Giọng ca sĩ gốc được dịch thành bè, có lời nhưng có thể rè ở chỗ giọng tách chưa sạch."}{" "}
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
    <div className="trim-row">
      <span className="trim-label">{label}</span>
      <div className="stepper small">
        <button onClick={() => change(value - 1)}>−</button>
        <div className="val">{value ? formatTime(value) : "Không"}</div>
        <button onClick={() => change(value + 1)}>+</button>
      </div>
      <button className="btn small" onClick={here} title="Lấy đúng chỗ đang phát">
        Đặt tại đây
      </button>
    </div>
  );
  return (
    <Group title="Bỏ qua quảng cáo">
      {row(
        "Bỏ đầu bài",
        trim.start,
        (v) => set({ start: v }),
        () => set({ start: pos * tempo }),
      )}
      {row(
        "Bỏ cuối bài",
        trim.end,
        (v) => set({ end: v }),
        () => set({ end: (duration - pos) * tempo }),
      )}
      <p className="help">
        Nghe tới chỗ hết quảng cáo đầu bài (hoặc chỗ bắt đầu quảng cáo cuối bài) rồi bấm <b>Đặt tại đây</b>. Bài sẽ bắt đầu và kết thúc ở đó, kể cả trong video
        xuất ra. Lưu riêng cho bài này.
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
