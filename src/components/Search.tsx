import { useEffect, useRef, useState } from "react";
import { api, errorText, type LyricJob, type SongMeta } from "../lib/api";
import { libraryEntry, librarySources, removeFromLibrary } from "../lib/library";
import { closeSong, lyricsFitted, openSong, startLyrics, stopLyrics } from "../lib/loader";
import { formatTime } from "../lib/music";
import { songFromVideo } from "../lib/sources";
import { useStore } from "../lib/store";
import { Mic, Play, Search as SearchIcon } from "./Icons";

/** The video id in a pasted YouTube link (watch, youtu.be, shorts, live, embed, music.youtube). */
function videoIdFromLink(text: string): string | null {
  const m = text.match(/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

interface Status {
  text: string;
  done: boolean;
  action?: { label: string; title: string; run: () => void };
}

/** How far a sung song's lyric fitting has got, and what can be done about it. */
function songStatus(m: SongMeta, instant: boolean, jobs: Map<string, LyricJob>): Status | null {
  const source = libraryEntry(m.id)?.sourceId;
  if (!source) return null;
  const job = jobs.get(source);
  const stop = { label: "■ Dừng", title: "Dừng khớp lời bài này để ưu tiên bài khác", run: () => stopLyrics(m.id) };
  // Separating in the background (the song was closed while it ran).
  if (job?.stage === "separate") return { text: `Đang tách giọng ${Math.round(job.fraction * 100)}%`, done: false };
  if (job?.stage === "queued") return { text: "Lời: đang chờ", done: false, action: stop };
  if (job) return { text: `${job.stage === "listen" ? "Đang nghe giọng" : "Đang canh lời"} ${Math.round(job.fraction * 100)}%`, done: false, action: stop };
  if (lyricsFitted(m.id)) return { text: "✓ Lời đã khớp", done: true };
  // Fitting needs the separated vocal on disk.
  if (!instant) return null;
  return {
    text: "Lời chưa khớp",
    done: false,
    action: { label: "▶ Khớp lời", title: "Nghe giọng ca sĩ và khớp lời từng chữ (vài phút, chạy nền)", run: () => startLyrics(m.id) },
  };
}

function Card({ m, instant = false, status, onDelete }: { m: SongMeta; instant?: boolean; status?: Status | null; onDelete?: () => void }) {
  // Deleting takes a second click, so a stray one can't lose a song.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      onClick={() => openSong(m)}
      onKeyDown={(e) => e.key === "Enter" && openSong(m)}
      title={`${m.title} — ${m.artist}`}
    >
      <div className="art">
        {m.artwork && <img src={m.artwork.replace("600x600", "300x300")} alt="" loading="lazy" />}
        {instant && (
          <span className="instant" title="Đã tách giọng: mở là hát ngay">
            ⚡ Sẵn sàng
          </span>
        )}
        {onDelete && (
          <button
            className={`del-btn ${confirming ? "confirm" : ""}`}
            title="Xóa bài này cùng nhạc đã tách và lời"
            onClick={(e) => {
              e.stopPropagation();
              if (confirming) onDelete();
              else setConfirming(true);
            }}
          >
            {confirming ? "Xóa?" : "✕"}
          </button>
        )}
        <div className="play-badge">
          <Play />
        </div>
      </div>
      <div className="title">{m.title}</div>
      <div className="sub">
        {m.explicit && <span className="tag">E</span>}
        {m.artist} · {formatTime(m.duration)}
      </div>
      {status && (
        <div className={`status ${status.done ? "done" : ""}`}>
          <span>{status.text}</span>
          {status.action && (
            <button
              className="status-action"
              title={status.action.title}
              onClick={(e) => {
                e.stopPropagation();
                status.action!.run();
              }}
            >
              {status.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Search() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SongMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = useStore((s) => s.history);
  const [instant, setInstant] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<Map<string, LyricJob>>(new Map());
  const separatingCount = [...jobs.values()].filter((j) => j.stage === "separate").length;
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Mark songs whose separation is already on disk.
  useEffect(() => {
    const sources = librarySources([...history.map((h) => h.id), ...(results ?? []).map((r) => r.id)]);
    if (!sources.size) return;
    api
      .stemsCached([...sources.keys()])
      .then((ready) => setInstant(new Set(ready.map((id) => sources.get(id)!))))
      .catch(() => {});
    // Re-checked as background separations finish.
  }, [history, results, separatingCount]);

  // Lyrics still being prepared (they go on after a song is closed).
  useEffect(() => {
    const sources = [...librarySources(history.map((h) => h.id)).keys()];
    if (!sources.length) return;
    let alive = true;
    const poll = () =>
      api
        .lyricJobs(sources)
        .then((list) => alive && setJobs(new Map(list.map((j) => [j.source, j]))))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [history]);

  const remove = async (m: SongMeta) => {
    const source = libraryEntry(m.id)?.sourceId;
    if (useStore.getState().song?.meta.id === m.id) closeSong();
    try {
      if (source) await api.deleteSource(source);
    } catch (e) {
      useStore.getState().toast(`Không xóa được tệp của bài: ${errorText(e)}`, "error");
      return;
    }
    removeFromLibrary(m.id);
    useStore.getState().removeHistory(m.id);
    setInstant((s) => new Set([...s].filter((id) => id !== m.id)));
    useStore.getState().toast(`Đã xóa “${m.title}”.`);
  };

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    const id = ++seq.current;
    const linked = videoIdFromLink(q);
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        let r: SongMeta[];
        if (linked) {
          // A pasted link: searching YouTube for the video id finds exactly
          // that video, with its title, channel and length.
          const videos = await api.ytSearch(linked, 5);
          const v = videos.find((v) => v.id === linked);
          if (!v) throw new Error("Không tìm thấy video từ link này. Kiểm tra lại link hoặc video có bị ẩn không.");
          r = [songFromVideo(v)];
        } else {
          // Songs straight from YouTube; skip live streams (no length) and
          // hour-long compilations.
          const videos = await api.ytSearch(q, 20);
          r = videos.filter((v) => v.duration && v.duration >= 60 && v.duration <= 900).map(songFromVideo);
        }
        if (id === seq.current) {
          setResults(r);
          setError(null);
        }
      } catch (e) {
        if (id === seq.current) setError(errorText(e));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, linked ? 0 : 700); // each search runs yt-dlp, so wait for a pause in typing
    return () => clearTimeout(t);
  }, [query]);

  const compact = query.trim().length >= 2;

  return (
    <div className="search-view">
      <div className={`search-hero ${compact ? "compact" : ""}`}>
        <h1>
          Tối nay mình
          <br />
          <em>hát</em> gì nhỉ?
        </h1>
        <div className="searchbox">
          <SearchIcon />
          <input
            ref={input}
            value={query}
            placeholder="Tìm bài hát trên YouTube, hoặc dán link video…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results?.[0]) openSong(results[0]);
              if (e.key === "Escape") setQuery("");
            }}
            spellCheck={false}
          />
          {loading && <div className="spinner" style={{ marginRight: 10 }} />}
        </div>
      </div>

      {error && <div className="empty err">{error}</div>}

      {compact && results && !results.length && !loading && <div className="empty">Không tìm thấy bài nào cho “{query.trim()}”.</div>}

      {compact && results && results.length > 0 && (
        <>
          <div className="section-title">Bài hát</div>
          <div className="results">
            {results.map((m) => (
              <Card key={m.id} m={m} instant={instant.has(m.id)} />
            ))}
          </div>
        </>
      )}

      {compact && !results && loading && (
        <div className="results" style={{ marginTop: 50 }}>
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="card">
              <div className="art skeleton" />
              <div className="skeleton" style={{ height: 12, borderRadius: 6, marginTop: 12, width: "80%" }} />
              <div className="skeleton" style={{ height: 10, borderRadius: 6, marginTop: 8, width: "50%" }} />
            </div>
          ))}
        </div>
      )}

      {!compact && (
        <button className="lab-cta" onClick={() => useStore.setState({ view: "lab" })}>
          <div className="lab-cta-icon">
            <Mic />
          </div>
          <div>
            <b>Phòng thử giọng</b>
            <span>Thử mic, thu thử một đoạn và chỉnh autotune cho vừa ý trước khi hát.</span>
          </div>
          <span className="lab-cta-go">Mở →</span>
        </button>
      )}

      {!compact && history.length > 0 && (
        <>
          <div className="section-title">Hát gần đây</div>
          <div className="results">
            {history.map((m) => (
              <Card key={m.id} m={m} instant={instant.has(m.id)} status={songStatus(m, instant.has(m.id), jobs)} onDelete={() => void remove(m)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
