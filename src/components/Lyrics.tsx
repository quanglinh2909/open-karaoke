import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deleteLine, fixWord, hasFixes, lyricIssues, lyricsBusy, lyricsFitted, refitWithFixes, songSingers, startLyrics } from "../lib/loader";
import { lineAt, type Line } from "../lib/lrc";
import { SINGER_LABEL } from "../lib/parts";
import {
  ANCHOR,
  clamp01,
  cueAt,
  linePitch,
  phraseStarts,
  type PitchSeg,
  entryRing,
  focusAt,
  holdLength,
  isHeld,
  lineJoin,
  restAfter,
  wordProgress,
  wipeEdge,
  litAlong,
  restAt,
  breath,
  wavyTail,
} from "../lib/lyricCues";
import { songTime, useStore } from "../lib/store";

/** Song time (seconds in the original recording's timeline, where lyric stamps live). */
function lyricClock(): number {
  const s = useStore.getState().song;
  const tempo = s?.info?.tempo ?? 1;
  const offset = s?.userOffset ?? 0;
  return songTime() * tempo - offset;
}

/** Progress while the lyrics are fitted to the singer, or the button to start it. */
function AlignNote() {
  const aligning = useStore((s) => s.song?.aligning ?? null);
  const song = useStore((s) => s.song);
  if (aligning === null) {
    const ready =
      song?.sourceId &&
      song.info &&
      !song.info.separating &&
      !song.info.vocalRemoved &&
      song.lyrics.status !== "loading";
    if (!ready || lyricsFitted(song.meta.id)) return null;
    return (
      <div className="align-note align-choice">
        <button className="align-start" onClick={() => startLyrics(song.meta.id, "fast")} title="Canh lời theo giọng ca sĩ bằng MMS (khoảng 1 phút). Dòng nghi sai sẽ được đánh dấu ⚠ để bạn sửa.">
          ▶ Khớp nhanh
        </button>
        <button className="align-start" onClick={() => startLyrics(song.meta.id, "whisper")} title="Whisper nghe cả bài rồi mới canh (khoảng 6–7 phút): sửa được chỗ ca sĩ hát khác lời, bỏ dòng, thêm dòng.">
          ▶ Khớp kỹ (Whisper)
        </button>
      </div>
    );
  }
  if (aligning.stage === "queue")
    return (
      <div className="align-note">Lời: đang chờ các bài khác xử lý xong…</div>
    );
  const label =
    aligning.stage === "listen"
      ? "Đang nghe giọng ca sĩ"
      : "Đang canh lời theo giọng hát";
  return (
    <div className="align-note">
      {label}… {Math.round(aligning.fraction * 100)}%
    </div>
  );
}

/** On the stage: open the lyrics editor, and fit again after corrections. */
function LyricsActions() {
  const song = useStore((s) => s.song);
  // Re-render when lines change (a word fixed, a line deleted).
  useStore((s) => s.song?.lyrics);
  const aligning = useStore((s) => !!s.song?.aligning);
  const set = useStore((s) => s.set);
  if (!song || song.lyrics.status === "loading") return null;
  const has = !!(song.lyrics.lines || song.lyrics.plain);
  const fixed = hasFixes() && !!song.sourceId && !!song.info && !song.info.separating;
  return (
    <div className="lyrics-actions">
      {fixed && (
        <button
          className="hot"
          disabled={aligning || lyricsBusy()}
          onClick={() => refitWithFixes()}
          title="Canh lại thời gian theo các chữ bạn đã sửa và các dòng đã xoá"
        >
          ↻ Canh lại theo chữ đã sửa
        </button>
      )}
      {song.lyrics.lines && song.info && !song.info.vocalRemoved && (
        <button onClick={() => set({ partsEditor: true })} title="Chọn đoạn ca sĩ gốc hát và đoạn có bè">
          ✂ Phân đoạn
        </button>
      )}
      <button onClick={() => set({ lyricsEditor: has ? "edit" : "new" })} title="Mở trang sửa toàn bộ lời">
        ✎ {has ? "Sửa lời" : "Viết lời"}
      </button>
    </div>
  );
}

export function Lyrics() {
  const song = useStore((s) => s.song);
  const lyrics = song?.lyrics;

  if (!song) return null;
  if (lyrics?.lines) return <SyncedLyrics lines={lyrics.lines} />;

  return (
    <div className="lyrics">
      <AlignNote />
      <LyricsActions />
      <div className="intro-title">{song.meta.title}</div>
      <div className="intro-artist">{song.meta.artist}</div>
      {lyrics?.status === "loading" && (
        <div className="note">Đang tìm lời bài hát…</div>
      )}
      {lyrics?.status === "ready" && lyrics.instrumental && (
        <div className="note">Bài này chỉ có nhạc, không có lời.</div>
      )}
      {lyrics?.status === "ready" && !lyrics.instrumental && lyrics.plain && (
        <PlainLyrics text={lyrics.plain} />
      )}
      {lyrics?.status === "missing" && (
        <div className="note">
          Không tìm thấy lời cho bài này, nhưng sân khấu vẫn là của bạn.
        </div>
      )}
    </div>
  );
}

/** Where `el` sits inside `root` (layout offsets: unaffected by the scale transitions). */
function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== root) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return n === root ? { x, y } : null;
}

/**
 * The melody ribbon under the line being sung (as in exported videos): a
 * thin line rising and falling with the original melody under the words,
 * lit up to where the singing is, a dot there. Drawn as SVG over the line
 * from the words' laid-out positions; lit each frame.
 */
function Ribbon({
  mode,
  line,
  segs,
  lineEl,
  wordEls,
}: {
  /** "ribbon": a line under the words; "dots": a dot per note over them. */
  mode: "ribbon" | "dots";
  line: Line;
  segs: PitchSeg[][];
  lineEl: HTMLElement | null;
  wordEls: (HTMLSpanElement | null)[];
}) {
  type Row = {
    d: string;
    x0: number;
    x1: number;
    pts: [number, number][];
    words: { k: number; x: number; w: number }[];
    /** Held notes' trails (where the light runs on while the note is held). */
    tails: { k: number; x: number; w: number }[];
    /** Dots mode: each note's dot and when it is sung. */
    dots: { x: number; y: number; at: number }[];
  };
  const dotRefs = useRef<(SVGCircleElement | null)[][]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const clipEls = useRef<(SVGRectElement | null)[]>([]);
  const dotEls = useRef<(SVGCircleElement | null)[]>([]);
  /** A small ring round the dot that fills during a rest, until the next word. */
  const ringEls = useRef<(SVGGElement | null)[]>([]);
  const id = useRef(`rb${Math.random().toString(36).slice(2, 8)}`).current;

  useLayoutEffect(() => {
    if (!lineEl) return;
    const measure = () => {
      const fs = parseFloat(getComputedStyle(lineEl).fontSize) || 40;
      const byRow = new Map<number, Row>();
      line.words.forEach((_, k) => {
        const ws = segs[k];
        const el = wordEls[k]?.querySelector<HTMLElement>(".w");
        if (!ws?.length || !el) return;
        const at = offsetIn(el, lineEl);
        if (!at) return;
        const key = Math.round(at.y / 4);
        const row = byRow.get(key) ?? { d: "", x0: Infinity, x1: -Infinity, pts: [], words: [], tails: [], dots: [] };
        const bottom = at.y + el.offsetHeight;
        const w = el.offsetWidth;
        const word = line.words[k];
        const dur = Math.max(0.08, word.end - word.start);
        for (const sg of ws) row.dots.push({ x: at.x + ((sg.from + sg.to) / 2) * w, y: at.y + fs * 0.02 - sg.h * fs * 0.3, at: word.start + sg.from * dur });
        for (const sg of ws) {
          const prev = row.pts.length ? row.pts[row.pts.length - 1][0] : -Infinity;
          const a = Math.max(prev + fs * 0.02, at.x + sg.from * w + fs * 0.05);
          const b = Math.max(a + fs * 0.04, at.x + sg.to * w - fs * 0.05);
          const y = bottom + fs * 0.06 + (1 - sg.h) * fs * 0.32;
          row.pts.push([a, y], [b, y]);
        }
        row.words.push({ k, x: at.x, w });
        // A held note: the ribbon runs on under its trail, gently waving.
        const hold = wordEls[k]?.querySelector<HTMLElement>(".hold");
        const tail = hold ? offsetIn(hold, lineEl) : null;
        if (hold && tail && row.pts.length) {
          const y = row.pts[row.pts.length - 1][1];
          row.pts.push(...wavyTail(row.pts[row.pts.length - 1][0], tail.x + hold.offsetWidth, y, fs * 0.035, fs * 0.16));
          row.tails.push({ k, x: tail.x, w: hold.offsetWidth });
        }
        byRow.set(key, row);
      });
      const out = [...byRow.values()].filter((r) => r.pts.length >= 2);
      for (const r of out) {
        if (mode === "dots") {
          r.d = r.dots.map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
          continue;
        }
        const P = r.pts;
        r.x0 = P[0][0];
        r.x1 = P[P.length - 1][0];
        r.d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}` + P.slice(1).map((p, k) => {
          const [px, py] = P[k];
          const mx = ((px + p[0]) / 2).toFixed(1);
          return ` C${mx},${py.toFixed(1)} ${mx},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        }).join("");
      }
      setRows(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(lineEl);
    void document.fonts.ready.then(measure);
    return () => ro.disconnect();
  }, [line, segs, lineEl, wordEls, mode]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = lyricClock();
      if (mode === "dots") {
        rows.forEach((r, n) => r.dots.forEach((d, k) => dotRefs.current[n]?.[k]?.classList.toggle("on", t >= d.at)));
        raf = requestAnimationFrame(loop);
        return;
      }
      rows.forEach((r, n) => {
        // With the text's wipe, crossing the spaces too, and on along a held note's trail.
        let lit = litAlong(line, r.words, t);
        for (const tl of r.tails) {
          const { hold } = wordProgress(line.words[tl.k], t, tl.k === line.words.length - 1, line, tl.k);
          if (hold > 0) lit = Math.max(lit, tl.x + hold * tl.w);
        }
        const to = Math.min(Math.max(lit, r.x0), r.x1);
        clipEls.current[n]?.setAttribute("width", Math.max(0, to - r.x0 + 2).toFixed(1));
        const dot = dotEls.current[n];
        if (dot) {
          const on = lit > r.x0 && lit < r.x1;
          dot.style.opacity = on ? "1" : "0";
          // Resting: the dot breathes, so stillness reads as a rest, not a stop.
          const rest = restAt(line, t);
          const restLen = rest ? line.words[rest.k + 1].start - line.words[rest.k].end : 0;
          dot.style.transform = rest ? `scale(${breath(rest.f, restLen).toFixed(3)})` : "";
          const ring = ringEls.current[n];
          if (ring) {
            ring.style.opacity = on && rest ? "1" : "0";
            ring.style.setProperty("--r", rest ? rest.f.toFixed(3) : "0");
          }
          if (on) {
            const P = r.pts;
            let y = P[0][1];
            for (let k = 1; k < P.length; k++) {
              if (P[k][0] >= to) {
                const u = clamp01((to - P[k - 1][0]) / Math.max(1, P[k][0] - P[k - 1][0]));
                y = P[k - 1][1] + (P[k][1] - P[k - 1][1]) * (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));
                break;
              }
            }
            dot.setAttribute("cx", to.toFixed(1));
            dot.setAttribute("cy", y.toFixed(1));
            ringEls.current[n]?.setAttribute("transform", `translate(${to.toFixed(1)} ${y.toFixed(1)}) rotate(-90)`);
          }
        }
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rows, line, mode]);

  if (mode === "dots")
    return (
      <svg className="ribbon dots" aria-hidden>
        {rows.map((r, n) => (
          <g key={n}>
            <path className="rb-base" d={r.d} />
            {r.dots.map((d, k) => (
              <circle
                key={k}
                className="rb-note"
                cx={d.x}
                cy={d.y}
                r={3}
                ref={(el) => {
                  (dotRefs.current[n] ??= [])[k] = el;
                }}
              />
            ))}
          </g>
        ))}
      </svg>
    );
  return (
    <svg className="ribbon" aria-hidden>
      <defs>
        {rows.map((r, n) => (
          <clipPath key={n} id={`${id}-${n}`}>
            <rect
              ref={(el) => {
                clipEls.current[n] = el;
              }}
              x={r.x0 - 1}
              y={-9999}
              width={0}
              height={99999}
            />
          </clipPath>
        ))}
      </defs>
      {rows.map((r, n) => (
        <g key={n}>
          <path className="rb-base" d={r.d} />
          <path className="rb-lit" d={r.d} clipPath={`url(#${id}-${n})`} />
          <circle
            className="rb-dot"
            r={3.5}
            ref={(el) => {
              dotEls.current[n] = el;
            }}
          />
          <g
            className="rb-ring"
            ref={(el) => {
              ringEls.current[n] = el;
            }}
          >
            <circle className="rb-ring-bg" r={8} />
            <circle className="rb-ring-fill" r={8} pathLength={1} />
          </g>
        </g>
      ))}
    </svg>
  );
}

/** A line's words grouped into its phrases (word indexes), split at its breaths and pauses. */
function phrasesOf(line: Line): number[][] {
  const starts = phraseStarts(line);
  const out: number[][] = [];
  line.words.forEach((_, k) => (starts[k] || !out.length ? out.push([k]) : out[out.length - 1].push(k)));
  return out;
}

function SyncedLyrics({ lines }: { lines: Line[] }) {
  const meta = useStore((s) => s.song?.meta);
  // Lines the last fit could hardly place: marked ⚠ for the user to check.
  const issues = meta ? lyricIssues(meta.id) : [];
  const doubtful = (l: Line) => issues.some((i) => i.text === l.text && Math.abs(i.start - l.start) < 1.5);
  // Duets: who sings each line (marked on the parts page; re-read when it closes).
  useStore((s) => s.partsEditor);
  const singers = songSingers();
  // Singing aids: pitch marks over the words and countdowns on the beat.
  // The melody on the words (ribbon under / dots over); the lane is the note graph below.
  const look = useStore((s) => s.aids.look);
  const notes = useStore((s) => (s.aids.pitch && s.aids.look !== "lane" ? s.song?.melody : null));
  const beatTimes = useStore((s) => (s.aids.beat ? s.song?.beats?.times : null));
  const offset = useStore((s) => s.song?.userOffset ?? 0);
  const pitches = useMemo(() => lines.map((l) => linePitch(l, notes, offset)), [lines, notes, offset]);
  const pitchOn = pitches.some(Boolean);
  // Beats in lyric time, read by the frame loop.
  const beatsRef = useRef<number[] | null>(null);
  beatsRef.current = useMemo(() => beatTimes?.map((b) => b - offset) ?? null, [beatTimes, offset]);
  const [focus, setFocus] = useState(-1);
  /** The word being corrected (double-click), if any. */
  const [editing, setEditing] = useState<{ li: number; k: number } | null>(
    null,
  );
  const [cue, setCue] = useState({
    count: 0,
    dots: 3,
    breakLeft: 0,
    intro: true,
  });
  const idxRef = useRef(-2);
  const focusRef = useRef(-1);
  const cueRef = useRef(cue);
  const boxEl = useRef<HTMLDivElement | null>(null);
  const trackEl = useRef<HTMLDivElement | null>(null);
  /** The intro, then one element per line. */
  const itemEls = useRef<(HTMLDivElement | null)[]>([]);
  const wordEls = useRef<(HTMLSpanElement | null)[][]>([]);
  const restEls = useRef<(HTMLSpanElement | null)[][]>([]);
  /** The entry ring before each line's first word. */
  const entryEls = useRef<(HTMLSpanElement | null)[]>([]);
  const barEl = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    /** Set a line's wipe, hold bars, rest marks and entry ring for time `t`. */
    const paint = (li: number, t: number) => {
      const line = lines[li];
      const els = wordEls.current[li];
      if (!line || !els) return;
      const last = line.words.length - 1;
      line.words.forEach((w, k) => {
        const el = els[k];
        if (!el) return;
        // A held note lights up quickly, then its bar shows how long to hold.
        const { hold, held } = wordProgress(w, t, k === last, line, k);
        // The soft edge of the wipe, sliding through the whole line.
        const edge = wipeEdge(line, k, t);
        el.style.setProperty("--p", `${(edge.from * 100).toFixed(1)}%`);
        el.style.setProperty("--q", `${(edge.to * 100).toFixed(1)}%`);
        if (held) el.style.setProperty("--h", `${(hold * 100).toFixed(1)}%`);
        el.classList.toggle("sung", t >= w.end);
        // Rest marks (and the line-end mark) light up while it is time to rest.
        const rest = restEls.current[li]?.[k];
        const until = k < last ? line.words[k + 1].start : lines[li + 1]?.start;
        if (rest && until !== undefined) rest.classList.toggle("on", t >= w.end && t < until);
      });
      const ring = entryEls.current[li];
      if (ring) {
        const e = entryRing(lines, li, t);
        ring.classList.toggle("show", e !== null);
        if (e !== null) ring.style.setProperty("--e", e.toFixed(3));
      }
    };

    let raf = 0;
    const loop = () => {
      const t = lyricClock();
      const i = lineAt(lines, t);
      if (i !== idxRef.current) {
        // A new line (or a seek): bring every line up to date once, so lines
        // passed or rewound over don't keep a stale wipe.
        idxRef.current = i;
        lines.forEach((_, li) => paint(li, t));
      } else {
        // The line being sung, and the next one for its entry ring.
        paint(i, t);
        paint(i + 1, t);
      }
      const f = focusAt(lines, i, t);
      if (f !== focusRef.current) {
        focusRef.current = f;
        setFocus(f);
      }

      // One moving cue at a time: the wipe while singing, the countdown
      // before a line; nothing animates on the line that is still to come.
      const { count, dots, breakLeft, bar, intro } = cueAt(lines, i, t, beatsRef.current);
      if (breakLeft && barEl.current)
        barEl.current.style.width = `${(bar * 100).toFixed(1)}%`;
      const c = cueRef.current;
      if (
        c.count !== count ||
        c.breakLeft !== breakLeft ||
        c.intro !== intro ||
        (count && c.dots !== dots)
      ) {
        cueRef.current = {
          count,
          dots: count ? dots : c.dots,
          breakLeft,
          intro,
        };
        setCue(cueRef.current);
      }
      raf = requestAnimationFrame(loop);
    };
    idxRef.current = -2;
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [lines]);

  // Glide the track so the focused line sits at the anchor. Only `transform`
  // changes, so the browser animates it without re-laying out the text.
  useLayoutEffect(() => {
    const place = () => {
      const box = boxEl.current;
      const track = trackEl.current;
      const el = itemEls.current[focus + 1];
      if (!box || !track || !el) return;
      track.style.transform = `translateY(${(box.clientHeight * ANCHOR - el.offsetTop).toFixed(1)}px)`;
    };
    place();
    const ro = new ResizeObserver(place);
    if (boxEl.current) ro.observe(boxEl.current);
    if (trackEl.current) ro.observe(trackEl.current);
    return () => ro.disconnect();
  }, [focus, lines]);

  /** How far an item is from the focused line: 0 in place, 1–2 coming up. */
  const place = (k: number) => {
    const d = k - focus;
    return d === 0
      ? "d0"
      : d === 1
        ? "d1"
        : d === 2
          ? "d2"
          : d < 0
            ? "past"
            : "far";
  };

  return (
    <div className={`lyrics synced ${pitchOn ? "pitch-on" : ""}`} ref={boxEl}>
      <AlignNote />
      <LyricsActions />
      <div className="lyric-track" ref={trackEl}>
        <div
          className={`lyric-line tl intro ${place(-1)}`}
          ref={(el) => {
            itemEls.current[0] = el;
          }}
        >
          <div className="intro-title">{meta?.title}</div>
          <div className="intro-artist">{meta?.artist}</div>
          <div className="legend">
            <span>
              <b>’</b>lấy hơi
            </span>
            <span>
              <b>//</b>nghỉ
            </span>
            <span>
              <b>‿</b>hát liền câu sau
            </span>
            <span>
              <i />
              ngân dài
            </span>
            <span>
              <b>●</b>sáng rõ là vào câu
            </span>
            {pitchOn && (
              <span>
                <b>{look === "dots" ? "•" : "∿"}</b>
                {look === "dots" ? "giai điệu (chấm trên chữ)" : "giai điệu (đường dưới câu)"}
              </span>
            )}
          </div>
        </div>
        {lines.map((line, li) => (
          <div
            key={li}
            className={`lyric-line tl ${place(li)} ${doubtful(line) ? "doubt" : ""} ${singers[li] ? `sing-${singers[li]}` : ""}`}
            ref={(el) => {
              itemEls.current[li + 1] = el;
            }}
          >
            <button
              className="line-del"
              title="Xóa cả dòng này (vd. tiếng khán giả hét)"
              onClick={() => deleteLine(li)}
            >
              ✕
            </button>
            {singers[li] && <span className="singer-tag">{SINGER_LABEL[singers[li]!]}</span>}
            {li === focus && pitches[li] && (
              <Ribbon mode={look === "dots" ? "dots" : "ribbon"} line={line} segs={pitches[li]!} lineEl={itemEls.current[li + 1]} wordEls={wordEls.current[li] ?? []} />
            )}
            {doubtful(line) && (
              <span className="doubt-mark" title="Dòng này canh có thể sai: kiểm tra ở tab Bài hát → Dòng cần kiểm tra">
                ⚠
              </span>
            )}
            {phrasesOf(line).map((ks) => (
              <Fragment key={ks[0]}>
              <span className="phrase">
            {ks.map((k) => {
              const w = line.words[k];
              const last = k === line.words.length - 1;
              const held = isHeld(w, last);
              // After the last word: how the line leads into the next.
              const rest = last ? lineJoin(lines, li) : restAfter(line, k);
              const gap = last
                ? (lines[li + 1]?.start ?? 0) - line.end
                : (line.words[k + 1]?.start ?? 0) - w.end;
              const restTitle =
                rest === "link"
                  ? "Vào liền câu sau, không nghỉ"
                  : rest === "short"
                    ? "Lấy hơi nhanh"
                    : `Nghỉ ${gap.toFixed(1)} giây`;
              return (
                <span
                  key={k}
                  className={`word${held && !line.hum ? " held" : ""}${w.unsure ? " unsure" : ""}${line.hum && w.unsure ? " hum" : ""}`}
                  ref={(el) => {
                    (wordEls.current[li] ??= [])[k] = el;
                  }}
                  title={
                    line.hum && w.unsure
                      ? "Có hát nhưng chưa nghe ra lời: nhấp đúp để gõ lời vào (để trống để xóa dòng này)"
                      : w.unsure
                        ? "Chữ này nghe chưa rõ: nhấp đúp để sửa (gõ thêm chữ để chèn, để trống để xóa)"
                        : "Nhấp đúp để sửa chữ này (gõ thêm chữ để chèn, để trống để xóa)"
                  }
                  onDoubleClick={() => setEditing({ li, k })}
                >
                  {k === 0 && (
                    <span
                      className="entry"
                      ref={(el) => {
                        entryEls.current[li] = el;
                      }}
                    />
                  )}
                  {editing?.li === li && editing.k === k ? (
                    <input
                      className="word-edit"
                      autoFocus
                      defaultValue={w.text}
                      size={Math.max(2, w.text.length + 1)}
                      onFocus={(e) => e.currentTarget.select()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          e.currentTarget.value = w.text;
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={(e) => {
                        fixWord(li, k, e.currentTarget.value);
                        setEditing(null);
                      }}
                    />
                  ) : (
                    <span className="w">{w.text}</span>
                  )}
                  {held && !line.hum && (
                    <span
                      className="hold"
                      style={{ width: `${holdLength(w).toFixed(2)}em` }}
                    />
                  )}
                  {rest && (
                    <span
                      className={`rest ${rest}`}
                      title={restTitle}
                      ref={(el) => {
                        (restEls.current[li] ??= [])[k] = el;
                      }}
                    />
                  )}{" "}
                </span>
              );
            })}
              </span>{" "}
              </Fragment>
            ))}
          </div>
        ))}
      </div>
      <div className="lyric-cue">
        {cue.breakLeft > 0 && (
          <div className="break-panel">
            <div>
              ♪ {cue.intro ? "Dạo đầu" : "Nhạc dạo"} · {cue.breakLeft}s
            </div>
            <div className="bar">
              <span ref={barEl} />
            </div>
          </div>
        )}
        <div
          className="countdown"
          style={{ visibility: cue.count > 0 ? "visible" : "hidden" }}
        >
          {Array.from({ length: cue.dots }, (_, j) => cue.dots - j).map((n) => (
            <span
              key={n}
              className={cue.count > 0 && cue.count <= n ? "on" : ""}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Unsynced lyrics scroll in proportion to the song's progress. */
function PlainLyrics({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      const { duration } = useStore.getState();
      if (el && duration > 0) {
        const target =
          (songTime() / duration) * (el.scrollHeight - el.clientHeight * 0.6);
        el.scrollTop += (target - el.scrollTop) * 0.05;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="plain-lyrics" ref={ref}>
      {text}
    </div>
  );
}
