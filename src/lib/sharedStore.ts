import { invoke } from "@tauri-apps/api/core";

/*
 * The app's saved state (library, settings: every `openkaraoke.*` key of
 * localStorage) lives in files in the app data dir, so the dev build and the
 * installed app share it: their webviews have separate localStorage (another
 * origin each). localStorage stays the working copy the code reads and
 * writes; this loads the files into it before the app starts and writes each
 * change back.
 */

const PREFIX = "openkaraoke.";
const pending = new Set<string>();
let timer: number | undefined;

function flush() {
  clearTimeout(timer);
  timer = undefined;
  for (const key of pending) {
    let value: string | null = null;
    try {
      value = localStorage.getItem(key);
    } catch {
      continue;
    }
    invoke("store_set", { key, value }).catch((e) => console.warn("Saving", key, "failed:", e));
  }
  pending.clear();
}

function changed(key: string) {
  pending.add(key);
  // Bursts (a slider dragged) are written once.
  if (timer === undefined) timer = window.setTimeout(flush, 400);
}

/** Load the shared state into localStorage, then keep the files up to date. Call before the app starts. */
export async function loadSharedStore() {
  let saved: Record<string, string>;
  try {
    saved = await invoke<Record<string, string>>("store_load");
  } catch {
    return; // Not running in the app (or an older backend): localStorage alone.
  }
  try {
    const local = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
    if (Object.keys(saved).length === 0) {
      // First run with shared state: it starts from this webview's own.
      local.forEach(changed);
    } else {
      // The shared state wins over this webview's copy.
      for (const k of local) if (!(k in saved)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v);
    }
  } catch {
    return; // Storage unavailable.
  }
  const proto = Storage.prototype;
  const setItem = proto.setItem;
  const removeItem = proto.removeItem;
  proto.setItem = function (key: string, value: string) {
    setItem.call(this, key, value);
    if (this === localStorage && key.startsWith(PREFIX)) changed(key);
  };
  proto.removeItem = function (key: string) {
    removeItem.call(this, key);
    if (this === localStorage && key.startsWith(PREFIX)) changed(key);
  };
  window.addEventListener("pagehide", flush);
}
