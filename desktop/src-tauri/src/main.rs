// Without this the binary links as a console-subsystem app and Windows opens a
// console window behind the GUI. Release builds only, so `cargo tauri dev`
// keeps its console. Nothing else on Windows suppresses this — the sidecar's
// own console is already hidden by tauri-plugin-shell; this one is ours.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

// Mirrors RDFCraft's main.py: pick a free local port, spawn the backend
// (there: FastAPI in a background thread; here: the pkg-compiled API as a
// sidecar process), wait for it to come up, then open a native webview
// window pointed at its URL. The sidecar is killed on app exit — hooked at
// the app (RunEvent) level, not just the window's CloseRequested, since
// quitting via Cmd+Q/Dock/menu-quit never fires a window close event but
// still has to take the sidecar down with it.

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarHandle(Mutex<Option<CommandChild>>);

/// Per-user app-data directory holding the log, and — written by the sidecar
/// rather than here — sulo.db and robot.jar.
///
/// Must stay in step with `appDataDir()` in api/src/config.ts: the sidecar is a
/// separate process and computes this independently, so the two rules have to
/// agree or the log lands somewhere other than the data it describes.
fn app_data_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(|appdata| PathBuf::from(appdata).join("sulo-schema-builder"))
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".sulo-schema-builder"))
    }
}

/// Truncate the log at startup and hand back an appending handle.
///
/// Truncating rather than appending across runs keeps the file bounded without
/// a rotation scheme: one launch's output is what a bug report needs, and an
/// ever-growing file in someone's app-data directory is its own defect.
fn open_log() -> Option<File> {
    let dir = app_data_dir()?;
    create_dir_all(&dir).ok()?;
    let path = dir.join("sulo-schema-builder.log");
    File::create(&path).ok()?;
    OpenOptions::new().append(true).open(&path).ok()
}

fn find_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("failed to bind an ephemeral port")
        .local_addr()
        .unwrap()
        .port()
}

fn wait_for_port(port: u16) {
    loop {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = find_free_port();

            let (mut rx, child) = app
                .shell()
                .sidecar("sulo-schema-builder-api")
                .expect("failed to create sidecar command")
                .env("PORT", port.to_string())
                .env("NODE_ENV", "production")
                .spawn()
                .expect("failed to spawn api sidecar");

            app.manage(SidecarHandle(Mutex::new(Some(child))));

            // Drain the sidecar's stdout/stderr so it never blocks on a full
            // pipe buffer, and keep its logs somewhere retrievable.
            //
            // The print! calls alone were enough until this binary became a
            // windows-subsystem app, which has no stdout — so on a Windows
            // release build they now go nowhere. That stream is the only
            // diagnostic trail for the Java discovery, ROBOT download and SULO
            // refresh that all run at startup and can all fail, so it also goes
            // to a file. The prints stay for the platforms that do have a
            // console.
            let mut log = open_log();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    let (text, is_err) = match event {
                        CommandEvent::Stdout(line) => (String::from_utf8_lossy(&line).into_owned(), false),
                        CommandEvent::Stderr(line) => (String::from_utf8_lossy(&line).into_owned(), true),
                        _ => continue,
                    };
                    if is_err {
                        eprint!("{text}");
                    } else {
                        print!("{text}");
                    }
                    if let Some(file) = log.as_mut() {
                        // A failed write must not kill the drain — the pipe
                        // still has to be read or the sidecar blocks on it.
                        let _ = file.write_all(text.as_bytes());
                        let _ = file.flush();
                    }
                }
            });

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tauri::async_runtime::spawn_blocking(move || wait_for_port(port))
                    .await
                    .expect("waiting for the api to come up panicked");

                let url = format!("http://127.0.0.1:{port}/")
                    .parse()
                    .expect("invalid sidecar URL");

                WebviewWindowBuilder::new(&app_handle, "main", WebviewUrl::External(url))
                    .title("SULO Schema Builder")
                    .inner_size(1280.0, 860.0)
                    .build()
                    .expect("failed to create main window");
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(handle) = app_handle.try_state::<SidecarHandle>() {
                if let Some(child) = handle.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
