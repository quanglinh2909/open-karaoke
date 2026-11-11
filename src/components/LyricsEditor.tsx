import { useEffect, useRef, useState } from "react";
import { editedLyrics, lyricsBusy, lyricsSearch, lyricsText, replaceLyrics } from "../lib/loader";
import { useStore } from "../lib/store";

/**
 * A full page for the lyrics: edit them all (drop lines the singer skips,
 * fix words to what a cover sings, add missing lines) or write lyrics for a
 * song that has none. Saving fits them to the singer again.
 */
export function LyricsEditor() {
  const mode = useStore((s) => s.lyricsEditor);
  const song = useStore((s) => s.song);
  const set = useStore((s) => s.set);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!mode) return;
    setText(mode === "edit" ? lyricsText() : "");
    requestAnimationFrame(() => box.current?.focus());
  }, [mode]);

  if (!mode || !song) return null;
  const close = () => set({ lyricsEditor: null });
  const lines = text.split(/\r?\n/).filter((l) => /\p{L}/u.test(l)).length;
  const busy = lyricsBusy();

  const save = () => {
    const t = text.trim();
    if (!t) return;
    const q = lyricsSearch(song.meta.id);
    const pick = { title: q?.title ?? song.meta.title, artist: q?.artist ?? song.meta.artist };
    const ok =
      mode === "edit"
        ? replaceLyrics(editedLyrics(t), { label: "lời bạn đã sửa", ...pick }, true)
        : /^\s*\[\d+:\d+/m.test(t)
          ? replaceLyrics({ synced: t, plain: null, instrumental: false }, { label: "lời bạn dán vào", ...pick })
          : replaceLyrics(editedLyrics(t), { label: "lời bạn viết", ...pick }, true);
    if (ok) close();
  };

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
      }}
    >
      <div className="lyrics-editor">
        <div className="le-head">
          <div>
            <h3>{mode === "edit" ? "Sửa lời bài hát" : "Viết lời bài hát"}</h3>
            <div className="sub">
              {song.meta.title} · {song.meta.artist}
            </div>
          </div>
          <span className="badge muted">{lines} dòng</span>
        </div>
        <textarea
          ref={box}
          className="le-text"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            mode === "edit"
              ? "Mỗi dòng một câu."
              : "Viết hoặc dán lời, mỗi dòng một câu. Lời dạng LRC ([00:12.34] …) cũng được."
          }
        />
        <p className="help">
          {mode === "edit"
            ? "Xoá dòng ca sĩ không hát, sửa chữ đúng như ca sĩ hát, thêm dòng còn thiếu. Dòng giữ nguyên giữ mốc thời gian; dòng mới được ước lượng giữa hai dòng bên cạnh."
            : "Mỗi dòng là một câu hiện trên màn hình."}{" "}
          Lưu xong app canh lại theo giọng ca sĩ: vài giây nếu bài đã canh trước đó.
          {busy && " Đang khớp lời: dừng khớp lời trước rồi lưu."}
        </p>
        <div className="le-foot">
          <span className="help">Ctrl+Enter để lưu · Esc để đóng</span>
          <button className="btn small" onClick={close}>
            Huỷ
          </button>
          <button className="btn small primary" onClick={save} disabled={busy || !text.trim()}>
            Lưu & canh lại
          </button>
        </div>
      </div>
    </div>
  );
}
