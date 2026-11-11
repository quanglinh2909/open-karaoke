// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer crashes its compositor on some GPU/driver
    // setups (Intel iGPU on X11 with WebKitGTK 2.50: "invalid opcode" in
    // ThreadedCompositor), leaving a frozen or black window. Shared-memory
    // rendering is stable. Set before the webview starts; an explicit value wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    open_karaoke_lib::run()
}
