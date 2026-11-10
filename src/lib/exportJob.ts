import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { errorText } from "./api";
import { useStore } from "./store";
import { exportKaraokeVideo, type LyricStyle, type Orientation } from "./videoExport";

/** Set to stop the running export at its next frame. */
let stopRequested = false;

/**
 * Export the open song as a karaoke video. It runs on its own, not tied to
 * any panel: switching tabs, going home or opening another song doesn't
 * stop it, and the corner indicator shows its progress throughout.
 */
export async function startExport(orientation: Orientation, style: LyricStyle) {
  const s = useStore.getState();
  if (s.exportJob || !s.song) return;
  stopRequested = false;
  const title = s.song.meta.title;
  useStore.setState({ exportJob: { title, progress: 0 } });
  let shown = 0;
  try {
    const path = await exportKaraokeVideo(
      orientation,
      style,
      (p) => {
        // A store update per percent is plenty.
        if (p - shown >= 0.01 || p >= 0.99) {
          shown = p;
          useStore.setState({ exportJob: { title, progress: p } });
        }
      },
      () => stopRequested,
    );
    useStore.getState().toast(`Đã xuất video karaoke "${title}"`, "success", { label: "Xem", run: () => revealItemInDir(path) });
  } catch (e) {
    if (errorText(e) !== "cancelled") useStore.getState().toast(`Không xuất được video: ${errorText(e)}`, "error");
  } finally {
    useStore.setState({ exportJob: null });
  }
}

export function cancelExport() {
  stopRequested = true;
}
