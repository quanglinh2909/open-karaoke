import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { setParts, songParts } from "../lib/loader";
import { formatTime } from "../lib/music";
import { applyAdjust, fromParts, leadParts, lineSingers, segKey, SINGER_LABEL, span, toSegments, toSingers, type Adjust, type LapMode, type Laps, type Segment, type Singer } from "../lib/parts";
import { useStore } from "../lib/store";

type Kind = "original" | "backing";

/** The singer button cycles: none → female → male → both. */
const NEXT_SINGER: Record<string, Singer | undefined> = { none: "female", female: "male", male: "both", both: undefined };

/** How far (seconds) a part's edge can be dragged from where the lines put it. */
const RANGE = 1.5;

const fmt = (t: number) => `${formatTime(t)}.${String(Math.floor((t % 1) * 100)).padStart(2, "0")}`;

/**
 * A full page for choosing, line by line, where the original singer sings
 * (a duet: leave the other voice to them) and where the automatic harmony
 * plays; then each part's start and end can be dragged and heard. Shift-click
 * picks a run of lines.
 */
export function PartsEditor() {
  const open = useStore((s) => s.partsEditor);
  const song = useStore((s) => s.song);
  const set = useStore((s) => s.set);
  const [orig, setOrig] = useState<Set<number>>(new Set());
  const [harm, setHarm] = useState<Set<number>>(new Set());
  const [adj, setAdj] = useState<{ original: Adjust; backing: Adjust }>({ original: {}, backing: {} });
  const [laps, setLaps] = useState<Laps>({});
  const [who, setWho] = useState<(Singer | undefined)[]>([]);
  const [trial, setTrial] = useState(false);
  const last = useRef<{ kind: Kind | "singer"; i: number } | null>(null);
  const stopTimer = useRef<number | undefined>(undefined);
  const lines = song?.lyrics.lines ?? [];
  const offset = song?.userOffset ?? 0;

  useEffect(() => {
    if (!open || !song) return;
    const p = songParts(song.meta.id);
    setOrig(fromParts(lines, p.original, offset));
    setHarm(fromParts(lines, p.backing, offset));
    setAdj({ original: { ...(p.adjust?.original ?? {}) }, backing: { ...(p.adjust?.backing ?? {}) } });
    setLaps({ ...(p.laps ?? {}) });
    setWho(lineSingers(lines, p.singers, offset));
    setTrial(false);
    last.current = null;
    // Load the saved choice each time the page opens.
  }, [open]);

  if (!open || !song) return null;
  const segs: Record<Kind, Segment[]> = {
    original: toSegments(lines, orig, offset),
    backing: toSegments(lines, harm, offset),
  };
  const current = () => ({
    original: applyAdjust(segs.original, adj.original),
    backing: applyAdjust(segs.backing, adj.backing),
    lead: leadParts(segs.original, adj.original, laps),
  });

  const close = (saved: boolean) => {
    clearTimeout(stopTimer.current);
    if (trial) {
      void api.pause();
      // Heard but not kept: back to what is saved.
      if (!saved) {
        const p = songParts(song.meta.id);
        const saved = leadParts(toSegments(lines, fromParts(lines, p.original, offset, 0.4), offset), p.adjust?.original, p.laps);
        void api.songParts(p.backing, saved).catch(() => undefined);
      }
    }
    set({ partsEditor: false });
  };

  /** Next singer for line `i` (Shift: the same for the run since the last line clicked). */
  const cycleSinger = (i: number, shift: boolean) => {
    const value = NEXT_SINGER[who[i] ?? "none"];
    const ranged = shift && last.current?.kind === "singer";
    const from = ranged ? Math.min(last.current!.i, i) : i;
    const to = ranged ? Math.max(last.current!.i, i) : i;
    // A run takes the singer the clicked-from line already has.
    const put = ranged ? who[last.current!.i] : value;
    const next = lines.map((_, k) => who[k]);
    for (let k = from; k <= to; k++) next[k] = put;
    setWho(next);
    last.current = { kind: "singer", i };
  };

  const toggle = (kind: Kind, i: number, shift: boolean) => {
    const [cur, put] = kind === "original" ? [orig, setOrig] : [harm, setHarm];
    const next = new Set(cur);
    const on = !cur.has(i);
    const from = shift && last.current?.kind === kind ? Math.min(last.current.i, i) : i;
    const to = shift && last.current?.kind === kind ? Math.max(last.current.i, i) : i;
    for (let k = from; k <= to; k++) {
      if (on) next.add(k);
      else next.delete(k);
    }
    put(next);
    last.current = { kind, i };
  };

  const nudge = (kind: Kind, s: Segment, edge: 0 | 1, value: number) =>
    setAdj((a) => {
      const k = segKey(s);
      const cur = a[kind][k] ?? [0, 0];
      const next: [number, number] = edge === 0 ? [value, cur[1]] : [cur[0], value];
      return { ...a, [kind]: { ...a[kind], [k]: next.map((x) => Math.max(-RANGE, Math.min(RANGE, Math.round(x * 100) / 100))) } };
    });

  /** Play a few seconds around an edge with the parts as they are on this page. */
  const listen = async (at: number) => {
    const p = current();
    await api.songParts(p.backing, p.lead).catch(() => undefined);
    setTrial(true);
    const tempo = song.info?.tempo ?? 1;
    clearTimeout(stopTimer.current);
    await api.seek(Math.max(0, (at - 2) / tempo));
    await api.play();
    stopTimer.current = window.setTimeout(() => void api.pause(), (3.5 / tempo) * 1000);
  };

  const save = () => {
    const p = current();
    void setParts({ original: p.original, backing: p.backing, adjust: { original: adj.original, backing: adj.backing }, laps, singers: toSingers(lines, who, offset) }, p.lead);
    close(true);
  };

  const tuning = (kind: Kind) =>
    segs[kind].map((s, n) => {
      const [da, db] = adj[kind][segKey(s)] ?? [0, 0];
      const [a, b] = [Math.max(0, s.from + da), s.to + db];
      const edgeRow = (edge: 0 | 1, d: number, t: number) => (
        <div className="tune-edge">
          <span className="tl">{edge === 0 ? "Đầu" : "Cuối"}</span>
          <button className="mini" onClick={() => nudge(kind, s, edge, d - 0.02)} title="Sớm hơn 0,02 s">
            −
          </button>
          <input
            type="range"
            min={-RANGE}
            max={RANGE}
            step={0.01}
            value={d}
            onChange={(e) => nudge(kind, s, edge, Number(e.target.value))}
            title="Kéo để kết thúc / bắt đầu sớm hơn hoặc muộn hơn"
          />
          <button className="mini" onClick={() => nudge(kind, s, edge, d + 0.02)} title="Muộn hơn 0,02 s">
            +
          </button>
          <span className="tv">
            {fmt(t)} <em>{d === 0 ? "" : `${d > 0 ? "+" : ""}${d.toFixed(2)}s`}</em>
          </span>
          <button className="mini play" onClick={() => void listen(t)} title="Nghe quanh điểm này">
            ▶
          </button>
          {kind === "original" && (edge === 1 ? t > s.limitTo + 0.02 : t < s.limitFrom - 0.02) && (
            <select
              className="lap-mode"
              value={(laps[segKey(s)] ?? ["auto", "auto"])[edge]}
              onChange={(e) => {
                const k = segKey(s);
                const cur = laps[k] ?? ["auto", "auto"];
                const next: [LapMode, LapMode] = edge === 0 ? [e.target.value as LapMode, cur[1]] : [cur[0], e.target.value as LapMode];
                setLaps({ ...laps, [k]: next });
              }}
              title="Phần lấn vào dòng bạn hát: AI tách hai giọng và giữ giọng bạn chọn"
            >
              <option value="auto">Lấn: tách AI, tự nhận giọng</option>
              <option value="female">Lấn: tách AI, giữ giọng nữ</option>
              <option value="male">Lấn: tách AI, giữ giọng nam</option>
              <option value="none">Lấn: không lọc</option>
            </select>
          )}
        </div>
      );
      return (
        <div key={`${kind}${segKey(s)}`} className="tune-seg">
          <div className="th">
            <b>{kind === "original" ? "Giọng gốc" : "Bè"}</b> đoạn {n + 1} · dòng {s.first + 1}
            {s.last > s.first ? `–${s.last + 1}` : ""}
          </div>
          {edgeRow(0, da, a)}
          {edgeRow(1, db, b)}
        </div>
      );
    });

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => e.target === e.currentTarget && close(false)}
      onKeyDown={(e) => e.key === "Escape" && close(false)}
      tabIndex={-1}
    >
      <div className="lyrics-editor parts-editor">
        <div className="le-head">
          <div>
            <h3>Phân đoạn: giọng gốc, bè và ai hát</h3>
            <div className="sub">
              {song.meta.title} · {song.meta.artist}
            </div>
          </div>
          <span className="badge muted">
            {orig.size} dòng giọng gốc · {harm.size ? `${harm.size} dòng có bè` : "bè cả bài"}
          </span>
        </div>
        <p className="help" style={{ margin: 0 }}>
          <b>Giọng gốc</b>: ca sĩ gốc hát những dòng này (bài song ca: chọn phần của giọng kia). <b>Bè</b>: chỉ có bè ở
          những dòng này; không chọn dòng nào thì bè có cả bài. Giữ Shift khi bấm để chọn cả dải. Bên phải: kéo đầu/cuối
          từng đoạn nếu dư hoặc thiếu, bấm ▶ để nghe thử. <b>Ai hát?</b>: bài song ca, đánh dấu dòng của giọng nữ, nam hay cả
          hai; lời trên màn hình và video xuất sẽ tô màu và ghi rõ.
        </p>
        <div className="parts-cols">
          {lines.length ? (
            <div className="parts-list">
              {lines.map((l, i) => (
                <div key={i} className={`parts-row ${orig.has(i) ? "orig" : ""}`}>
                  <span className="pt">{formatTime(span(l, offset)[0])}</span>
                  <span className="px">
                    <span className="pn">{i + 1}</span>
                    {l.text}
                  </span>
                  <button className={`chip ${orig.has(i) ? "on" : ""}`} onClick={(e) => toggle("original", i, e.shiftKey)}>
                    Giọng gốc
                  </button>
                  <button className={`chip ${harm.has(i) ? "on" : ""}`} onClick={(e) => toggle("backing", i, e.shiftKey)}>
                    Bè
                  </button>
                  <button
                    className={`chip singer ${who[i] ?? ""}`}
                    onClick={(e) => cycleSinger(i, e.shiftKey)}
                    title="Ai hát dòng này (bài song ca): bấm để đổi Nữ → Nam → Cả hai → bỏ. Shift: áp cho cả dải từ dòng bấm trước."
                  >
                    {who[i] ? SINGER_LABEL[who[i]!] : "Ai hát?"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="parts-list" style={{ display: "grid", placeItems: "center" }}>
              <p className="help">Bài này chưa có lời theo thời gian. Khớp lời trước rồi chọn đoạn theo từng dòng.</p>
            </div>
          )}
          <div className="parts-tune">
            {segs.original.length + segs.backing.length ? (
              <>
                {tuning("original")}
                {tuning("backing")}
              </>
            ) : (
              <p className="help">Chọn dòng bên trái; các đoạn sẽ hiện ở đây để tinh chỉnh đầu và cuối.</p>
            )}
          </div>
        </div>
        <div className="le-foot">
          <button
            className="btn small"
            onClick={() => {
              setOrig(new Set());
              setHarm(new Set());
              setWho([]);
            }}
          >
            Bỏ chọn tất cả
          </button>
          <span className="help" />
          <button className="btn small" onClick={() => close(false)}>
            Huỷ
          </button>
          <button className="btn small primary" onClick={save} disabled={!lines.length}>
            Lưu
          </button>
        </div>
      </div>
    </div>
  );
}
