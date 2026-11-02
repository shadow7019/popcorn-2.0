// PopcornTime desktop shell — a native window around the hosted web app.
// The window loads the remote URL (see tauri.conf.json `app.windows[0].url`),
// so shipping an update is just redeploying the web app — no store update.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running PopcornTime");
}
