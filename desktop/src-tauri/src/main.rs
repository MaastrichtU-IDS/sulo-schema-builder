// Mirrors RDFCraft's main.py: pick a free local port, spawn the backend
// (there: FastAPI in a background thread; here: the pkg-compiled API as a
// sidecar process), wait for it to come up, then open a native webview
// window pointed at its URL. The sidecar is killed on app exit — hooked at
// the app (RunEvent) level, not just the window's CloseRequested, since
// quitting via Cmd+Q/Dock/menu-quit never fires a window close event but
// still has to take the sidecar down with it.

use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarHandle(Mutex<Option<CommandChild>>);

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
            // pipe buffer, and surface its logs in this process's own output.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
                        CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                        _ => {}
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
