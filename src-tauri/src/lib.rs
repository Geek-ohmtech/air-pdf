//! Air PDF 데스크톱 셸.
//! PDF 처리는 모두 웹 화면 안의 PDFium(WebAssembly)이 하고, 여기서는 파일 읽기/쓰기,
//! "연결 프로그램으로 열기"·탐색기 오른쪽 단추 메뉴로 넘어온 파일 경로, 글꼴 목록, 기본 프로그램 지정만 다룬다.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{ipc::Request, ipc::Response, Emitter, Manager, State};

/// 탐색기에서 넘어온 일: mode 없음 = 열기, 있으면 merge / split / to-images / to-pdf
#[derive(Clone, Serialize, Default)]
struct Batch {
    mode: Option<String>,
    files: Vec<String>,
}

/// 화면이 준비되기 전에 들어온 파일은 여기 모아 둔다.
/// 프로그램이 꺼진 상태에서 파일 여러 개로 "합치기"를 누르면 파일마다 실행되는데,
/// 화면이 아직 이벤트를 받을 수 없는 동안 넘어온 파일을 놓치지 않기 위해서다.
#[derive(Default)]
struct Inbox {
    ready: bool,
    /// 일의 종류(열기·합치기…)가 다르면 따로 모은다
    batches: Vec<Batch>,
}
#[derive(Default)]
struct Pending(Mutex<Inbox>);

impl Inbox {
    fn add(&mut self, b: Batch) {
        if b.files.is_empty() {
            return;
        }
        match self.batches.iter_mut().find(|x| x.mode == b.mode) {
            Some(x) => {
                for f in b.files {
                    if !x.files.contains(&f) {
                        x.files.push(f);
                    }
                }
            }
            None => self.batches.push(b),
        }
    }
}

/// 화면이 이벤트를 받을 준비가 된 뒤 한 번 부른다: 그동안 모인 파일을 돌려주고, 다음부터는 "open-files" 이벤트로 보낸다
#[tauri::command]
fn initial_files(app: tauri::AppHandle, pending: State<Pending>) -> Batch {
    let mut p = pending.0.lock().unwrap();
    p.ready = true;
    let mut list = std::mem::take(&mut p.batches);
    let first = if list.is_empty() { Batch::default() } else { list.remove(0) };
    for b in list {
        let _ = app.emit("open-files", b); // 나머지 종류는 이벤트로 (화면은 이미 받을 준비가 됐다)
    }
    first
}

/// 다른 실행(또는 macOS Finder)에서 넘어온 파일: 화면이 준비됐으면 바로 보내고, 아니면 모아 둔다
fn deliver(app: &tauri::AppHandle, b: Batch) {
    if b.files.is_empty() {
        return;
    }
    let Some(p) = app.try_state::<Pending>() else { return };
    let mut p = p.0.lock().unwrap();
    if p.ready {
        let _ = app.emit("open-files", b);
    } else {
        p.add(b);
    }
}

/// 파일을 그대로 바이트로 돌려준다 (JSON으로 바꾸지 않아 큰 PDF도 빠르다)
#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    let p = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(bytes))
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
        if let Some(dir) = target.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)?;
            }
        }
        let mut tmp = target.clone().into_os_string();
        tmp.push(".airpdf-tmp");
        let tmp = std::path::PathBuf::from(tmp);
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

/* ───────────── 글꼴 ───────────── */

#[derive(Serialize)]
struct FontInfo {
    family: String,
    path: String,
    index: u32,
    korean: bool,
}

/// 이 컴퓨터에 설치된 글꼴 중 PDF에 넣을 수 있는 것 (TrueType 윤곽, 넣기 허락된 것)만, 글꼴 가족마다 보통 굵기 하나
#[tauri::command]
async fn list_fonts() -> Vec<FontInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        // 가족 이름 → (보통 굵기에서 먼 정도, 정보)
        let mut best: std::collections::HashMap<String, (u32, FontInfo)> = Default::default();
        for face in db.faces() {
            let (fontdb::Source::File(path) | fontdb::Source::SharedFile(path, _)) = &face.source else { continue };
            let family = face
                .families
                .iter()
                .find(|(_, l)| *l == fontdb::Language::Korean_Korea)
                .or_else(|| face.families.first())
                .map(|(n, _)| n.clone());
            let Some(family) = family else { continue };
            let off = (face.weight.0 as i32 - 400).unsigned_abs() + if face.style == fontdb::Style::Normal { 0 } else { 1000 };
            if best.get(&family).is_some_and(|(o, _)| *o <= off) {
                continue;
            }
            let Some((ok, korean)) = db.with_face_data(face.id, |data, index| {
                let Ok(f) = ttf_parser::Face::parse(data, index) else { return (false, false) };
                let embeddable = !matches!(f.permissions(), Some(ttf_parser::Permissions::Restricted));
                let ok = f.tables().glyf.is_some() && embeddable;
                (ok, f.glyph_index('한').is_some() && f.glyph_index('글').is_some())
            }) else { continue };
            if !ok {
                continue;
            }
            best.insert(
                family.clone(),
                (off, FontInfo { family, path: path.to_string_lossy().into_owned(), index: face.index, korean }),
            );
        }
        best.into_values().map(|(_, f)| f).collect()
    })
    .await
    .unwrap_or_default()
}

/* ───────────── 기본 PDF 프로그램 (Windows) ───────────── */

#[cfg(windows)]
mod winassoc {
    use winreg::{enums::*, RegKey};
    pub const PROGID: &str = "AirPDF.Document";
    /// "기본 앱" 설정 화면에 Air PDF가 나오도록 등록 (설치 프로그램도 하지만 옮겨 쓰는 경우를 위해 한 번 더)
    pub fn register() -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        let (pk, _) = hkcu.create_subkey(format!(r"Software\Classes\{PROGID}"))?;
        pk.set_value("", &"PDF 문서")?;
        let (ic, _) = pk.create_subkey("DefaultIcon")?;
        ic.set_value("", &format!("\"{exe}\",0"))?;
        let (cmd, _) = pk.create_subkey(r"shell\open\command")?;
        cmd.set_value("", &format!("\"{exe}\" \"%1\""))?;
        let (ow, _) = hkcu.create_subkey(r"Software\Classes\.pdf\OpenWithProgids")?;
        ow.set_value(PROGID, &"")?;
        let (cap, _) = hkcu.create_subkey(r"Software\AirPDF\Capabilities")?;
        cap.set_value("ApplicationName", &"Air PDF")?;
        cap.set_value("ApplicationDescription", &"문서는 가볍게, 작업은 자유롭게")?;
        let (fa, _) = cap.create_subkey("FileAssociations")?;
        fa.set_value(".pdf", &PROGID)?;
        let (ra, _) = hkcu.create_subkey(r"Software\RegisteredApplications")?;
        ra.set_value("AirPDF", &r"Software\AirPDF\Capabilities")?;
        Ok(())
    }
    /// 탐색기 미리보기 창·미리보기 그림: 이 컴퓨터에 있는 PDF 미리보기(보통 Edge)를 Air PDF 파일 형식에도 붙인다.
    /// 기본 프로그램을 Air PDF로 바꾸면 Windows가 Air PDF 쪽 등록만 보고 미리보기를 못 찾는 일을 막는다.
    pub fn ensure_preview() {
        const HANDLERS: [&str; 2] = [
            "{8895b1c6-b41f-4c1c-a562-0d564250836f}", // 미리보기 창 (IPreviewHandler)
            "{e357fccd-a995-4576-b01f-234630154e96}", // 미리보기 그림 (IThumbnailProvider)
        ];
        let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // 찾아볼 곳: 확장자, Edge, 아크로뱃, 그리고 .pdf를 열 수 있다고 등록한 다른 프로그램들
        let mut sources: Vec<String> = vec![".pdf".into(), "SystemFileAssociations\\.pdf".into(), "MSEdgePDF".into(), "AcroExch.Document.DC".into(), "AcroExch.Document".into()];
        if let Ok(k) = hkcr.open_subkey(".pdf\\OpenWithProgids") {
            for (name, _) in k.enum_values().flatten() { if name != PROGID { sources.push(name); } }
        }
        if let Ok(pid) = hkcr.open_subkey(".pdf").and_then(|k| k.get_value::<String, _>("")) { if pid != PROGID { sources.push(pid); } }
        for h in HANDLERS {
            let target = format!(r"Software\Classes\{PROGID}\shellex\{h}");
            if hkcu.open_subkey(&target).and_then(|k| k.get_value::<String, _>("")).map(|v| !v.is_empty()).unwrap_or(false) { continue; }
            let found = sources.iter().find_map(|src| hkcr.open_subkey(format!(r"{src}\shellex\{h}")).and_then(|k| k.get_value::<String, _>("")).ok().filter(|v| !v.is_empty()));
            if let Some(clsid) = found {
                if let Ok((k, _)) = hkcu.create_subkey(&target) { let _ = k.set_value("", &clsid); }
            }
        }
    }
    pub fn is_default() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice")
            .and_then(|k| k.get_value::<String, _>("ProgId"))
            .map(|p| p.eq_ignore_ascii_case(PROGID) || p.to_lowercase().contains("airpdf"))
            .unwrap_or(false)
    }
}

/// 지금 기본 PDF 프로그램인가 (Windows가 아니면 null)
#[tauri::command]
fn default_app_status() -> Option<bool> {
    #[cfg(windows)]
    return Some(winassoc::is_default());
    #[cfg(not(windows))]
    None
}

/// Windows 10/11은 앱이 직접 바꿀 수 없어서, 등록한 뒤 "기본 앱" 설정 화면을 Air PDF 쪽으로 연다
#[tauri::command]
fn make_default_app() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        winassoc::register().map_err(|e| e.to_string())?;
        winassoc::ensure_preview();
        unsafe { SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null()) };
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps?registeredAppUser=AirPDF"])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let ok = std::process::Command::new("xdg-mime")
            .args(["default", "air-pdf.desktop", "application/pdf"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok { Ok(()) } else { Err("xdg-mime으로 바꾸지 못했습니다".into()) }
    }
    #[cfg(target_os = "macos")]
    Err("Finder에서 PDF 파일 정보 가져오기 → 다음으로 열기 → 모두 변경을 눌러 주세요".into())
}

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn SHChangeNotify(event: i32, flags: u32, a: *const std::ffi::c_void, b: *const std::ffi::c_void);
}

/* ───────────── 명령줄 ───────────── */

const IMAGE_EXT: [&str; 6] = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"];

/// `air-pdf.exe [--merge|--split|--to-images|--to-pdf] 파일...`
fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Batch {
    let mut b = Batch::default();
    for a in args {
        if let Some(m) = a.strip_prefix("--") {
            if ["merge", "split", "to-images", "to-pdf"].contains(&m) {
                b.mode = Some(m.to_owned());
            }
            continue;
        }
        let l = a.to_lowercase();
        if l.ends_with(".pdf") || IMAGE_EXT.iter().any(|e| l.ends_with(e)) {
            b.files.push(a);
        }
    }
    // 이미지는 "PDF로 만들기"로만 받는다
    if b.mode.as_deref() != Some("to-pdf") {
        b.files.retain(|f| f.to_lowercase().ends_with(".pdf"));
    }
    b
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 이미 켜져 있으면 새 창을 띄우지 않고 그 창에 탭으로 연다.
        // 탐색기에서 여러 파일을 골라 메뉴를 누르면 파일마다 실행되므로, 화면 쪽에서 잠깐 모아서 한 번에 처리한다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            deliver(app, parse_args(argv.into_iter().skip(1)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Pending(Mutex::new({
            let mut i = Inbox::default();
            i.add(parse_args(std::env::args().skip(1)));
            i
        })))
        .setup(|_app| {
            // 탐색기 미리보기 연결은 켤 때마다 확인한다 (빠르고, 이미 있으면 건드리지 않음)
            #[cfg(windows)]
            std::thread::spawn(winassoc::ensure_preview);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_files,
            read_file,
            write_file,
            list_fonts,
            default_app_status,
            make_default_app
        ])
        .build(tauri::generate_context!())
        .expect("Air PDF를 시작하지 못했습니다");

    app.run(|handle, event| {
        // macOS: Finder에서 PDF를 열면 경로가 이벤트로 온다
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            let files: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            deliver(handle, Batch { mode: None, files });
        }
        let _ = (&handle, &event);
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_args, Batch, Inbox};
    #[test]
    fn inbox_collects_before_ready() {
        let mut i = Inbox::default();
        i.add(Batch { mode: Some("merge".into()), files: vec!["a.pdf".into()] });
        i.add(Batch { mode: Some("merge".into()), files: vec!["b.pdf".into(), "a.pdf".into()] });
        i.add(Batch { mode: None, files: vec!["c.pdf".into()] });
        assert_eq!(i.batches.len(), 2, "열기와 합치기는 따로");
        assert_eq!(i.batches[0].mode.as_deref(), Some("merge"));
        assert_eq!(i.batches[0].files, vec!["a.pdf".to_string(), "b.pdf".to_string()]);
    }
    fn v(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }
    #[test]
    fn modes_and_files() {
        let b = parse_args(v(&["--merge", r"C:\a\x.pdf", r"C:\a\y.PDF", r"C:\a\p.jpg"]));
        assert_eq!(b.mode.as_deref(), Some("merge"));
        assert_eq!(b.files, v(&[r"C:\a\x.pdf", r"C:\a\y.PDF"]));
        let b = parse_args(v(&["--to-pdf", "a.png", "b.JPEG", "c.txt"]));
        assert_eq!(b.files, v(&["a.png", "b.JPEG"]));
        let b = parse_args(v(&["doc.pdf", "--unknown"]));
        assert!(b.mode.is_none());
        assert_eq!(b.files, v(&["doc.pdf"]));
    }
}
