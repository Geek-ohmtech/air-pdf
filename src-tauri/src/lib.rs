//! Air PDF 데스크톱 셸.
//! PDF 처리는 모두 웹 화면 안의 PDFium(WebAssembly)이 하고, 여기서는 파일 읽기/쓰기,
//! "연결 프로그램으로 열기"·탐색기 오른쪽 단추 메뉴로 넘어온 파일 경로, 글꼴 목록, 기본 프로그램 지정만 다룬다.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{ipc::Request, ipc::Response, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use std::collections::HashMap;

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
fn initial_files(app: tauri::AppHandle, window: tauri::WebviewWindow, pending: State<Pending>) -> Batch {
    let mut p = pending.0.lock().unwrap();
    p.ready = true;
    let mut list = std::mem::take(&mut p.batches);
    let first = if list.is_empty() { Batch::default() } else { list.remove(0) };
    for b in list {
        let _ = app.emit_to(window.label(), "open-files", b); // 나머지 종류는 이벤트로 (화면은 이미 받을 준비가 됐다)
    }
    first
}

/// 넘어온 파일을 받을 창: 지금 쓰고 있는(초점이 있는) 창, 없으면 처음 창
fn target_window(app: &tauri::AppHandle) -> String {
    let wins = app.webview_windows();
    if let Some((l, _)) = wins.iter().find(|(_, w)| w.is_focused().unwrap_or(false)) {
        return l.clone();
    }
    if wins.contains_key("main") {
        return "main".into();
    }
    wins.keys().next().cloned().unwrap_or_else(|| "main".into())
}

/* ───────────── 탭을 다른 창으로 (떼어 내기·합치기) ───────────── */

/// 옮기는 중인 문서 (번호 → 내용, 설명). 받는 창이 한 번 꺼내 가면 지운다
#[derive(Default)]
struct Transfers(Mutex<(u64, HashMap<u64, (Vec<u8>, String)>)>);

/// 문서를 맡긴다: 본문은 PDF 바이트, x-meta 머리글은 이름·경로 등(JSON, 퍼센트 인코딩)
#[tauri::command]
fn put_transfer(request: Request<'_>, t: State<Transfers>) -> Result<u64, String> {
    let meta = request
        .headers()
        .get("x-meta")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("옮길 문서가 없습니다".into()) };
    let mut g = t.0.lock().unwrap();
    g.0 += 1;
    let id = g.0;
    g.1.insert(id, (data.clone(), meta));
    Ok(id)
}
#[tauri::command]
fn transfer_meta(id: u64, t: State<Transfers>) -> Option<String> {
    t.0.lock().unwrap().1.get(&id).map(|x| x.1.clone())
}
#[tauri::command]
fn take_transfer(id: u64, t: State<Transfers>) -> Result<Response, String> {
    t.0.lock().unwrap().1.remove(&id).map(|x| Response::new(x.0)).ok_or_else(|| "옮길 문서를 찾지 못했습니다".into())
}
/// 화면 좌표(물리 픽셀) 밑에 있는 다른 Air PDF 창
#[tauri::command]
fn window_at(app: tauri::AppHandle, x: f64, y: f64, exclude: String) -> Option<String> {
    for (label, w) in app.webview_windows() {
        if label == exclude || w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
            continue;
        }
        let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) else { continue };
        if x >= p.x as f64 && x < (p.x + s.width as i32) as f64 && y >= p.y as f64 && y < (p.y + s.height as i32) as f64 {
            return Some(label);
        }
    }
    None
}
/// 맡긴 문서를 다른 창에 탭으로 보낸다
#[tauri::command]
fn send_transfer(app: tauri::AppHandle, label: String, id: u64) -> Result<(), String> {
    let w = app.get_webview_window(&label).ok_or("그 창이 없습니다")?;
    let _ = w.unminimize();
    let _ = w.set_focus();
    app.emit_to(label.as_str(), "take-doc", id).map_err(|e| e.to_string())
}
/// 맡긴 문서로 새 창을 연다 (x, y: 창을 놓을 화면 위치, 논리 픽셀)
#[tauri::command]
async fn new_window(app: tauri::AppHandle, id: u64, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let label = format!("doc-{}", N.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .initialization_script(&format!("window.__AIRPDF_TRANSFER__ = {id};"))
        .title("Air PDF")
        .inner_size(w.max(640.0), h.max(480.0))
        .min_inner_size(520.0, 400.0)
        .position(x, y)
        .decorations(false)
        .shadow(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 다른 실행(또는 macOS Finder)에서 넘어온 파일: 화면이 준비됐으면 바로 보내고, 아니면 모아 둔다
fn deliver(app: &tauri::AppHandle, b: Batch) {
    if b.files.is_empty() {
        return;
    }
    let Some(p) = app.try_state::<Pending>() else { return };
    let mut p = p.0.lock().unwrap();
    if p.ready {
        let _ = app.emit_to(target_window(app).as_str(), "open-files", b);
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
    const THUMB_IF: &str = "{e357fccd-a995-4576-b01f-234630154e96}"; // 미리보기 그림 (IThumbnailProvider)
    const PREVIEW_IF: &str = "{8895b1c6-b41f-4c1c-a562-0d564250836f}"; // 미리보기 창 (IPreviewHandler)
    const CLSID_THUMB: &str = "{30dd72b6-7cfd-4770-8d95-ab22c7254d79}";
    const CLSID_PREVIEW: &str = "{20e51188-78a0-4aee-8fd1-f5f0d37f0c55}";
    /// 미리보기 창을 띄워 주는 Windows 대리 프로그램(prevhost.exe)
    const PREVHOST_APPID: &str = "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}";
    /// PDF가 붙는 곳들: 확장자, Air PDF 파일 형식, 모든 PDF 공통
    const TARGETS: [&str; 3] = [r"Software\Classes\.pdf", r"Software\Classes\AirPDF.Document", r"Software\Classes\SystemFileAssociations\.pdf"];

    /// 설치 폴더의 셸 확장 DLL (판마다 새 이름: 탐색기가 쓰는 중이면 덮어쓸 수 없어서)
    pub fn shell_dll() -> Option<std::path::PathBuf> {
        let dir = std::env::current_exe().ok()?.parent()?.join("shell");
        let mut v: Vec<_> = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path())
            .filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("dll")).unwrap_or(false)).collect();
        v.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
        v.pop()
    }
    /// 탐색기 미리보기 창·미리보기 그림을 Air PDF 확장으로 등록 (사용자 범위, 관리자 권한 필요 없음)
    pub fn register_shell(dll: &std::path::Path) -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = dll.to_string_lossy().into_owned();
        for (clsid, name) in [(CLSID_THUMB, "Air PDF 미리보기 그림"), (CLSID_PREVIEW, "Air PDF 미리보기")] {
            let (k, _) = hkcu.create_subkey(format!(r"Software\Classes\CLSID\{clsid}"))?;
            k.set_value("", &name)?;
            k.set_value("DisplayName", &name)?;
            if clsid == CLSID_PREVIEW { k.set_value("AppID", &PREVHOST_APPID)?; }
            let (ip, _) = k.create_subkey("InprocServer32")?;
            ip.set_value("", &path)?;
            ip.set_value("ThreadingModel", &"Apartment")?;
        }
        let (ph, _) = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers")?;
        ph.set_value(CLSID_PREVIEW, &"Air PDF 미리보기")?;
        for t in TARGETS {
            let (a, _) = hkcu.create_subkey(format!(r"{t}\ShellEx\{THUMB_IF}"))?;
            a.set_value("", &CLSID_THUMB)?;
            let (b, _) = hkcu.create_subkey(format!(r"{t}\ShellEx\{PREVIEW_IF}"))?;
            b.set_value("", &CLSID_PREVIEW)?;
        }
        // 미리보기 그림 귀퉁이에 프로그램 아이콘을 겹쳐 그리지 않게
        if let Ok((k, _)) = hkcu.create_subkey(r"Software\Classes\AirPDF.Document") { let _ = k.set_value("TypeOverlay", &""); }
        unsafe { super::SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null()) };
        Ok(())
    }
    pub fn unregister_shell() {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for c in [CLSID_THUMB, CLSID_PREVIEW] { let _ = hkcu.delete_subkey_all(format!(r"Software\Classes\CLSID\{c}")); }
        if let Ok(k) = hkcu.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers", KEY_SET_VALUE) { let _ = k.delete_value(CLSID_PREVIEW); }
        for t in TARGETS {
            for (i, c) in [(THUMB_IF, CLSID_THUMB), (PREVIEW_IF, CLSID_PREVIEW)] {
                let key = format!(r"{t}\ShellEx\{i}");
                // 우리 것일 때만 지운다
                if hkcu.open_subkey(&key).and_then(|k| k.get_value::<String, _>("")).map(|v| v.eq_ignore_ascii_case(c)).unwrap_or(false) { let _ = hkcu.delete_subkey_all(&key); }
            }
        }
        unsafe { super::SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null()) };
    }
    /// 켤 때마다: 등록이 빠졌거나 옛 DLL을 가리키면 바로잡는다
    pub fn ensure_preview() {
        let Some(dll) = shell_dll() else { return };
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let cur = hkcu.open_subkey(format!(r"Software\Classes\CLSID\{CLSID_PREVIEW}\InprocServer32")).and_then(|k| k.get_value::<String, _>("")).unwrap_or_default();
        let linked = TARGETS.iter().all(|t| hkcu.open_subkey(format!(r"{t}\ShellEx\{THUMB_IF}")).and_then(|k| k.get_value::<String, _>("")).map(|v| v.eq_ignore_ascii_case(CLSID_THUMB)).unwrap_or(false));
        if !linked || !std::path::Path::new(&cur).eq(dll.as_path()) { let _ = register_shell(&dll); }
    }
    pub fn is_default() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice")
            .and_then(|k| k.get_value::<String, _>("ProgId"))
            .map(|p| p.eq_ignore_ascii_case(PROGID) || p.to_lowercase().contains("airpdf"))
            .unwrap_or(false)
    }
}

/* ───────────── 'Air PDF' 프린터 (Windows) ───────────── */

#[cfg(windows)]
mod printer {
    use winreg::{enums::*, RegKey};
    pub const NAME: &str = "Air PDF";
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_NAME: &str = "AirPDF Print";
    /// 인쇄 결과가 써지는 곳 (프린터 포트). 인쇄 담당(시스템)도 쓸 수 있어야 해서 ProgramData에 둔다
    pub fn port() -> String {
        let pd = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
        format!(r"{pd}\AirPDF\print\job.pdf")
    }
    pub fn installed() -> bool {
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(format!(r"SYSTEM\CurrentControlSet\Control\Print\Printers\{NAME}")).is_ok()
    }
    /// 관리자 권한으로 PowerShell 스크립트를 돌린다 (사용자 계정 컨트롤 창이 한 번 뜬다). 끝날 때까지 기다린다
    fn elevated(script: &str) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        let dir = std::env::temp_dir().join("airpdf-setup");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("printer-{}.ps1", std::process::id()));
        // PowerShell 5는 BOM이 있어야 한글을 바르게 읽는다
        let mut body = vec![0xEF, 0xBB, 0xBF];
        body.extend_from_slice(script.as_bytes());
        std::fs::write(&file, body).map_err(|e| e.to_string())?;
        let f = file.to_string_lossy().replace('\'', "''");
        let cmd = format!("try {{ $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"{f}\"'; exit $p.ExitCode }} catch {{ exit 1223 }}");
        let st = std::process::Command::new("powershell.exe").args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &cmd])
            .creation_flags(0x0800_0000).status().map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&file);
        match st.code() {
            Some(0) => Ok(()),
            Some(1223) => Err("cancelled".into()),
            Some(c) => Err(format!("프린터 설정이 끝나지 않았습니다 (코드 {c})")),
            None => Err("프린터 설정이 중단되었습니다".into()),
        }
    }
    pub fn install() -> Result<(), String> {
        let port = port();
        let dir = std::path::Path::new(&port).parent().unwrap().to_string_lossy().into_owned();
        let script = format!(r#"$ErrorActionPreference = 'Stop'
$name = '{NAME}'; $drv = 'Microsoft Print To PDF'; $port = '{port}'; $dir = '{dir}'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# 모든 사용자(Users)가 인쇄 결과를 옮길 수 있게
icacls $dir /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
if (-not (Get-PrinterDriver -Name $drv -ErrorAction SilentlyContinue)) {{
  try {{ Enable-WindowsOptionalFeature -Online -FeatureName 'Printing-PrintToPDFServices-Features' -NoRestart -All | Out-Null }} catch {{}}
  Add-PrinterDriver -Name $drv
}}
if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) {{ Add-PrinterPort -Name $port }}
if (Get-Printer -Name $name -ErrorAction SilentlyContinue) {{ Remove-Printer -Name $name }}
Add-Printer -Name $name -DriverName $drv -PortName $port -Comment 'Air PDF로 PDF 만들기 (글자 인식 가능)'
exit 0
"#);
        elevated(&script)?;
        start_watch();
        Ok(())
    }
    pub fn remove() -> Result<(), String> {
        let port = port();
        let script = format!(r#"$name = '{NAME}'; $port = '{port}'
if (Get-Printer -Name $name -ErrorAction SilentlyContinue) {{ Remove-Printer -Name $name }}
Start-Sleep -Milliseconds 500
if (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue) {{ Remove-PrinterPort -Name $port -ErrorAction SilentlyContinue }}
exit 0
"#);
        elevated(&script)?;
        if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN, KEY_SET_VALUE) { let _ = k.delete_value(RUN_NAME); }
        Ok(())
    }
    /// 인쇄 감시: 로그인할 때 켜지게 등록하고 지금 켠다 (이미 돌고 있으면 그쪽이 계속한다)
    pub fn start_watch() {
        use std::os::windows::process::CommandExt;
        let Some(dll) = super::winassoc::shell_dll() else { return };
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let rundll = format!(r"{sys}\System32\rundll32.exe");
        let arg = format!("{},PrintWatch", dll.to_string_lossy());
        if let Ok((k, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN) { let _ = k.set_value(RUN_NAME, &format!("\"{rundll}\" \"{}\",PrintWatch", dll.to_string_lossy())); }
        let _ = std::process::Command::new(rundll).arg(arg).creation_flags(0x0800_0000).spawn();
    }
}

#[derive(serde::Serialize)]
struct PrinterInfo { supported: bool, installed: bool }

#[tauri::command]
fn printer_status() -> PrinterInfo {
    #[cfg(windows)]
    return PrinterInfo { supported: winassoc::shell_dll().is_some(), installed: printer::installed() };
    #[cfg(not(windows))]
    PrinterInfo { supported: false, installed: false }
}

/// 'Air PDF' 프린터 추가(on=true)·빼기. 관리자 확인 창이 뜬다. 사용자가 취소하면 "cancelled"
#[tauri::command]
async fn printer_set(on: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            if on { printer::install()?; } else { printer::remove()?; }
            Ok(printer::installed())
        }).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    { let _ = on; Err("Windows에서만 됩니다".into()) }
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
            if ["merge", "split", "to-images", "to-pdf", "batch", "printed"].contains(&m) {
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

/// 설치·제거 프로그램이 부르는 일: 화면 없이 하고 바로 끝낸다. 했으면 true
pub fn run_setup_task() -> bool {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        #[cfg(windows)]
        Some("--register-shell") => {
            let dll = args.get(2).map(std::path::PathBuf::from).or_else(winassoc::shell_dll);
            if let Some(d) = dll { let _ = winassoc::register_shell(&d); }
            true
        }
        #[cfg(windows)]
        Some("--unregister-shell") => { winassoc::unregister_shell(); true }
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 이미 켜져 있으면 새 창을 띄우지 않고 그 창에 탭으로 연다.
        // 탐색기에서 여러 파일을 골라 메뉴를 누르면 파일마다 실행되므로, 화면 쪽에서 잠깐 모아서 한 번에 처리한다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            deliver(app, parse_args(argv.into_iter().skip(1)));
            if let Some(w) = app.get_webview_window(&target_window(app)) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Transfers::default())
        .manage(Pending(Mutex::new({
            let mut i = Inbox::default();
            i.add(parse_args(std::env::args().skip(1)));
            i
        })))
        .setup(|_app| {
            // 탐색기 미리보기 연결은 켤 때마다 확인한다 (빠르고, 이미 있으면 건드리지 않음)
            #[cfg(windows)]
            std::thread::spawn(|| {
                winassoc::ensure_preview();
                // 프린터가 있으면 인쇄 감시가 돌고 있게
                if printer::installed() { printer::start_watch(); }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_files,
            read_file,
            write_file,
            list_fonts,
            default_app_status,
            make_default_app,
            put_transfer,
            transfer_meta,
            take_transfer,
            window_at,
            send_transfer,
            new_window,
            printer_status,
            printer_set
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
