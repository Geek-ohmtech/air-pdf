//! Air PDF 데스크톱 셸.
//! PDF 처리는 모두 웹 화면 안의 PDFium(WebAssembly)이 하고, 여기서는 파일 읽기/쓰기와
//! "연결 프로그램으로 열기"로 넘어온 파일 경로만 다룬다.
use std::sync::Mutex;
use tauri::{ipc::Request, ipc::Response, Emitter, Manager, State};

#[derive(Default)]
struct Pending(Mutex<Vec<String>>);

/// 명령줄로 받은 PDF 경로 (탐색기에서 더블클릭, "연결 프로그램", 끌어다 놓기로 실행)
#[tauri::command]
fn initial_files(pending: State<Pending>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

/// 파일을 그대로 바이트로 돌려준다 (JSON으로 바꾸지 않아 큰 PDF도 빠르다)
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    let bytes = tokio_read(&path).await.map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(bytes))
}

async fn tokio_read(path: &str) -> std::io::Result<Vec<u8>> {
    let p = path.to_owned();
    tauri::async_runtime::spawn_blocking(move || std::fs::read(p)).await.map_err(std::io::Error::other)?
}

/// 본문은 저장할 바이트, 경로는 x-path 머리글. 임시 파일에 쓴 뒤 바꿔치기해서 도중에 실패해도 원본이 깨지지 않는다.
#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
        .ok_or("저장할 경로가 없습니다")?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("저장할 내용이 없습니다".into());
    };
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
        let target = std::path::PathBuf::from(&path);
        let tmp = target.with_extension("pdf.airpdf-tmp");
        std::fs::write(&tmp, &data)?;
        match std::fs::rename(&tmp, &target) {
            Ok(()) => Ok(()),
            Err(_) => {
                // 다른 드라이브 등으로 이름 바꾸기가 안 되면 직접 쓴다
                std::fs::write(&target, &data)?;
                let _ = std::fs::remove_file(&tmp);
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

fn pdf_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| a.to_lowercase().ends_with(".pdf"))
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 이미 켜져 있으면 새 창을 띄우지 않고 그 창에 탭으로 연다
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = pdf_args(argv.into_iter().skip(1));
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Pending(Mutex::new(pdf_args(std::env::args().skip(1)))))
        .invoke_handler(tauri::generate_handler![initial_files, read_file, write_file])
        .build(tauri::generate_context!())
        .expect("Air PDF를 시작하지 못했습니다");

    app.run(|handle, event| {
        // macOS: Finder에서 PDF를 열면 경로가 이벤트로 온다
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if let Some(p) = handle.try_state::<Pending>() {
                p.0.lock().unwrap().extend(paths.clone());
            }
            let _ = handle.emit("open-files", paths);
        }
        let _ = (&handle, &event);
    });
}
