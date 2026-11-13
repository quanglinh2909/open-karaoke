import { libraryEntry, saveToLibrary, type ExportPrefs } from "./library";

/** Where a song without its own choices starts. */
export const DEFAULT_EXPORT: ExportPrefs = { orientation: "landscape", style: "scroll", backdrop: "video", fps: 30 };

/** Choices made before the song's library entry exists (it is created once a recording is picked). */
const pending = new Map<string, ExportPrefs>();

/** This song's video export choices. */
export function exportPrefs(songId: string | undefined): ExportPrefs {
  if (!songId) return DEFAULT_EXPORT;
  return { ...DEFAULT_EXPORT, ...(libraryEntry(songId)?.exportPrefs ?? pending.get(songId)) };
}

/** Change some of this song's export choices (kept with the song). */
export function saveExportPrefs(songId: string, patch: Partial<ExportPrefs>): ExportPrefs {
  const next = { ...exportPrefs(songId), ...patch };
  pending.set(songId, next);
  saveToLibrary(songId, { exportPrefs: next });
  return next;
}
