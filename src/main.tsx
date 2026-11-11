import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/bricolage-grotesque";
import "./styles.css";
import { loadSharedStore } from "./lib/sharedStore";

// Linux (WebKitGTK, with its DMA-BUF renderer off to avoid compositor
// crashes) paints blurs over moving content on the CPU every frame: "lite"
// swaps them for solid backgrounds.
if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent))
  document.documentElement.classList.add("lite");

/** A UI error shown instead of a blank window, with a way back. */
function Crash({ error }: { error: string }) {
  return (
    <div style={{ padding: 32, color: "#f5f2fb", fontFamily: "Inter Variable, sans-serif", background: "#0b0a10", minHeight: "100vh" }}>
      <h2 style={{ marginTop: 0 }}>Giao diện gặp lỗi</h2>
      <p style={{ color: "#a9a3b8" }}>Gửi nội dung dưới đây để sửa. Bài hát và thiết lập đã lưu không bị mất.</p>
      <pre style={{ whiteSpace: "pre-wrap", background: "#16131f", padding: 16, borderRadius: 12, fontSize: 12, userSelect: "text" }}>{error}</pre>
      <button style={{ padding: "8px 16px", borderRadius: 10, cursor: "pointer" }} onClick={() => location.reload()}>
        Tải lại giao diện
      </button>
    </div>
  );
}

class Boundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e) };
  }
  render() {
    return this.state.error ? <Crash error={this.state.error} /> : this.props.children;
  }
}

// Errors outside rendering (event handlers, promises) are shown too, as a
// banner, rather than failing silently.
function banner(text: string) {
  const el = document.createElement("div");
  el.textContent = `Lỗi giao diện: ${text}`;
  el.style.cssText =
    "position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;padding:10px 14px;border-radius:10px;background:#3a1020;color:#fff;font:12px Inter Variable,sans-serif;white-space:pre-wrap;user-select:text";
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}
window.addEventListener("error", (e) => banner(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  // Backend calls reject with plain strings, which the app reports itself;
  // only real script errors are bugs to show.
  if (r instanceof Error) banner(`${r.message}\n${r.stack ?? ""}`);
});

// The saved state (shared with the other build) goes into localStorage
// before the app's modules read it: App is imported only then.
void loadSharedStore()
  .catch(() => undefined)
  .then(() => import("./App"))
  .then(({ default: App }) =>
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <Boundary>
          <App />
        </Boundary>
      </React.StrictMode>,
    ),
  );
