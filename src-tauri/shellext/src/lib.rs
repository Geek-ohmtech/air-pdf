//! Air PDF 탐색기 확장: PDF 미리보기 그림(IThumbnailProvider)과 미리보기 창(IPreviewHandler).
//! PDF는 Windows에 들어 있는 Windows.Data.Pdf로 그린다 (Windows 10/11 어디에나 있다).
//! 그리기는 따로 만든 스레드(MTA)에서 한다: 탐색기 쪽 스레드(STA)에서 비동기 작업을 기다리면 멈출 수 있어서.
#![allow(non_snake_case)]

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::sync::atomic::{AtomicI32, AtomicIsize, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use windows::core::{implement, w, IUnknown, Interface, Ref, BOOL, GUID, HRESULT, PCWSTR};
use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat};
use windows::Storage::Streams::{Buffer, DataReader, DataWriter, InMemoryRandomAccessStream};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Ole::{IObjectWithSite, IObjectWithSite_Impl, IOleWindow, IOleWindow_Impl};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::UI::Shell::PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl};
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// 미리보기 그림 (썸네일)
pub const CLSID_THUMB: GUID = GUID::from_u128(0x30dd72b6_7cfd_4770_8d95_ab22c7254d79);
/// 미리보기 창
pub const CLSID_PREVIEW: GUID = GUID::from_u128(0x20e51188_78a0_4aee_8fd1_f5f0d37f0c55);

static LOCKS: AtomicI32 = AtomicI32::new(0);
static MODULE: AtomicIsize = AtomicIsize::new(0);
const MAX_BYTES: usize = 400 << 20;

#[no_mangle]
extern "system" fn DllMain(h: HINSTANCE, reason: u32, _: *mut c_void) -> BOOL {
    if reason == 1 {
        MODULE.store(h.0 as isize, Ordering::Relaxed);
    }
    TRUE
}

#[no_mangle]
unsafe extern "system" fn DllGetClassObject(rclsid: *const GUID, riid: *const GUID, ppv: *mut *mut c_void) -> HRESULT {
    if ppv.is_null() || rclsid.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();
    let kind = match *rclsid {
        c if c == CLSID_THUMB => 0,
        c if c == CLSID_PREVIEW => 1,
        _ => return CLASS_E_CLASSNOTAVAILABLE,
    };
    let f: IClassFactory = Factory(kind).into();
    f.query(riid, ppv)
}

#[no_mangle]
extern "system" fn DllCanUnloadNow() -> HRESULT {
    if LOCKS.load(Ordering::SeqCst) == 0 { S_OK } else { S_FALSE }
}

#[implement(IClassFactory)]
struct Factory(u8);

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<IUnknown>, riid: *const GUID, ppv: *mut *mut c_void) -> windows::core::Result<()> {
        unsafe {
            if ppv.is_null() {
                return Err(E_POINTER.into());
            }
            *ppv = std::ptr::null_mut();
            if !outer.is_null() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            let unk: IUnknown = if self.0 == 0 { Thumb::default().into() } else { Preview::default().into() };
            unk.query(riid, ppv).ok()
        }
    }
    fn LockServer(&self, lock: BOOL) -> windows::core::Result<()> {
        if lock.as_bool() { LOCKS.fetch_add(1, Ordering::SeqCst); } else { LOCKS.fetch_sub(1, Ordering::SeqCst); }
        Ok(())
    }
}

/* ───────────── PDF 그리기 ───────────── */

fn read_stream(s: &IStream) -> windows::core::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let mut n = 0u32;
        unsafe { s.Read(buf.as_mut_ptr() as *mut c_void, buf.len() as u32, Some(&mut n)).ok()? };
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n as usize]);
        if out.len() > MAX_BYTES {
            return Err(E_OUTOFMEMORY.into());
        }
    }
    Ok(out)
}

fn load_pdf(bytes: &[u8]) -> windows::core::Result<PdfDocument> {
    let ms = InMemoryRandomAccessStream::new()?;
    let w = DataWriter::CreateDataWriter(&ms)?;
    w.WriteBytes(bytes)?;
    w.StoreAsync()?.join()?;
    w.FlushAsync()?.join()?;
    w.DetachStream()?;
    ms.Seek(0)?;
    PdfDocument::LoadFromStreamAsync(&ms)?.join()
}

/// 그린 페이지: 위에서 아래로, BGRA (흰 바탕에 합쳐 불투명)
struct Frame {
    page: u32,
    w: u32,
    h: u32,
    px: Vec<u8>,
}

/// 페이지 크기 (pt 비율만 쓴다)
fn page_size(doc: &PdfDocument, i: u32) -> windows::core::Result<(f32, f32)> {
    let p = doc.GetPage(i)?;
    let s = p.Size()?;
    Ok((s.Width.max(1.0), s.Height.max(1.0)))
}

fn render(doc: &PdfDocument, i: u32, width: u32) -> windows::core::Result<Frame> {
    let page = doc.GetPage(i)?;
    let out = InMemoryRandomAccessStream::new()?;
    let opt = PdfPageRenderOptions::new()?;
    opt.SetDestinationWidth(width.clamp(16, 4000))?;
    page.RenderWithOptionsToStreamAsync(&out, &opt)?.join()?;
    out.Seek(0)?;
    let dec = BitmapDecoder::CreateAsync(&out)?.join()?;
    let sb = dec.GetSoftwareBitmapConvertedAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)?.join()?;
    let (w, h) = (sb.PixelWidth()? as u32, sb.PixelHeight()? as u32);
    let buf = Buffer::Create(w * h * 4)?;
    sb.CopyToBuffer(&buf)?;
    let rd = DataReader::FromBuffer(&buf)?;
    let mut px = vec![0u8; (w * h * 4) as usize];
    rd.ReadBytes(&mut px)?;
    // 투명한 곳은 흰 종이로
    for p in px.chunks_exact_mut(4) {
        let a = 255 - p[3];
        p[0] = p[0].saturating_add(a);
        p[1] = p[1].saturating_add(a);
        p[2] = p[2].saturating_add(a);
        p[3] = 255;
    }
    Ok(Frame { page: i, w, h, px })
}

/// MTA 스레드에서 f를 돌린다
fn in_mta<T: Send + 'static>(f: impl FnOnce() -> windows::core::Result<T> + Send + 'static) -> windows::core::Result<T> {
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let r = f();
        CoUninitialize();
        r
    })
    .join()
    .unwrap_or_else(|_| Err(E_FAIL.into()))
}

fn dib(w: u32, h: u32) -> (BITMAPINFO, i32, i32) {
    let bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    (bi, w as i32, h as i32)
}

/* ───────────── 미리보기 그림 ───────────── */

#[implement(IThumbnailProvider, IInitializeWithStream)]
#[derive(Default)]
struct Thumb {
    bytes: RefCell<Option<Vec<u8>>>,
}

impl IInitializeWithStream_Impl for Thumb_Impl {
    fn Initialize(&self, stream: Ref<IStream>, _mode: u32) -> windows::core::Result<()> {
        if self.bytes.borrow().is_some() {
            return Err(HRESULT::from_win32(ERROR_ALREADY_INITIALIZED.0).into());
        }
        *self.bytes.borrow_mut() = Some(read_stream(stream.ok()?)?);
        Ok(())
    }
}

impl IThumbnailProvider_Impl for Thumb_Impl {
    fn GetThumbnail(&self, cx: u32, phbmp: *mut HBITMAP, palpha: *mut WTS_ALPHATYPE) -> windows::core::Result<()> {
        let bytes = self.bytes.borrow_mut().take().ok_or(windows::core::Error::from(E_UNEXPECTED))?;
        let cx = cx.clamp(16, 2560);
        let f = in_mta(move || {
            let doc = load_pdf(&bytes)?;
            let (pw, ph) = page_size(&doc, 0)?;
            let width = if pw >= ph { cx } else { ((cx as f32) * pw / ph).round().max(8.0) as u32 };
            render(&doc, 0, width)
        })?;
        unsafe {
            let (bi, w, h) = dib(f.w, f.h);
            let mut bits: *mut c_void = std::ptr::null_mut();
            let hb = CreateDIBSection(None, &bi, DIB_RGB_COLORS, &mut bits, None, 0)?;
            std::ptr::copy_nonoverlapping(f.px.as_ptr(), bits as *mut u8, (w * h * 4) as usize);
            *phbmp = hb;
            *palpha = WTSAT_RGB;
        }
        Ok(())
    }
}

/* ───────────── 미리보기 창 ───────────── */

/// 그리는 스레드와 창이 함께 보는 것
struct Shared {
    hwnd: AtomicIsize,
    pages: AtomicU32,
    cur: AtomicU32,
    sizes: Mutex<Vec<(f32, f32)>>,
    frame: Mutex<Option<Frame>>,
    error: Mutex<Option<String>>,
}

const WM_FRAME: u32 = WM_APP + 1;

#[implement(IPreviewHandler, IInitializeWithStream, IObjectWithSite, IOleWindow)]
#[derive(Default)]
struct Preview {
    bytes: RefCell<Option<Vec<u8>>>,
    parent: Cell<HWND>,
    rect: Cell<RECT>,
    hwnd: Cell<HWND>,
    site: RefCell<Option<IUnknown>>,
    shared: RefCell<Option<Arc<Shared>>>,
    tx: RefCell<Option<mpsc::Sender<(u32, u32)>>>,
}

impl IInitializeWithStream_Impl for Preview_Impl {
    fn Initialize(&self, stream: Ref<IStream>, _mode: u32) -> windows::core::Result<()> {
        *self.bytes.borrow_mut() = Some(read_stream(stream.ok()?)?);
        Ok(())
    }
}

impl IObjectWithSite_Impl for Preview_Impl {
    fn SetSite(&self, site: Ref<IUnknown>) -> windows::core::Result<()> {
        *self.site.borrow_mut() = site.cloned();
        Ok(())
    }
    fn GetSite(&self, riid: *const GUID, ppv: *mut *mut c_void) -> windows::core::Result<()> {
        unsafe {
            *ppv = std::ptr::null_mut();
            match &*self.site.borrow() {
                Some(s) => s.query(riid, ppv).ok(),
                None => Err(E_FAIL.into()),
            }
        }
    }
}

impl IOleWindow_Impl for Preview_Impl {
    fn GetWindow(&self) -> windows::core::Result<HWND> { Ok(self.hwnd.get()) }
    fn ContextSensitiveHelp(&self, _: BOOL) -> windows::core::Result<()> { Err(E_NOTIMPL.into()) }
}

fn class_name() -> PCWSTR { w!("AirPdfPreviewWnd") }

fn ensure_class() {
    unsafe {
        let hinst = HINSTANCE(MODULE.load(Ordering::Relaxed) as *mut c_void);
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            hInstance: hinst,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: class_name(),
            ..Default::default()
        };
        RegisterClassW(&wc); // 이미 있으면 실패해도 괜찮다
    }
}

impl Preview_Impl {
    fn shared(&self) -> Option<Arc<Shared>> { self.shared.borrow().clone() }
    fn layout(&self) {
        let r = self.rect.get();
        unsafe { let _ = SetWindowPos(self.hwnd.get(), None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE); }
    }
}

impl IPreviewHandler_Impl for Preview_Impl {
    fn SetWindow(&self, hwnd: HWND, prc: *const RECT) -> windows::core::Result<()> {
        self.parent.set(hwnd);
        if !prc.is_null() { self.rect.set(unsafe { *prc }); }
        if !self.hwnd.get().is_invalid() {
            unsafe { let _ = SetParent(self.hwnd.get(), Some(hwnd)); }
            self.layout();
        }
        Ok(())
    }
    fn SetRect(&self, prc: *const RECT) -> windows::core::Result<()> {
        if prc.is_null() { return Err(E_INVALIDARG.into()); }
        self.rect.set(unsafe { *prc });
        if !self.hwnd.get().is_invalid() { self.layout(); }
        Ok(())
    }
    fn DoPreview(&self) -> windows::core::Result<()> {
        let bytes = self.bytes.borrow_mut().take().ok_or(windows::core::Error::from(E_UNEXPECTED))?;
        ensure_class();
        let sh = Arc::new(Shared { hwnd: AtomicIsize::new(0), pages: AtomicU32::new(0), cur: AtomicU32::new(0), sizes: Mutex::new(vec![]), frame: Mutex::new(None), error: Mutex::new(None) });
        let r = self.rect.get();
        let hwnd = unsafe {
            CreateWindowExW(WINDOW_EX_STYLE(0), class_name(), w!(""), WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                r.left, r.top, r.right - r.left, r.bottom - r.top, Some(self.parent.get()), None,
                Some(HINSTANCE(MODULE.load(Ordering::Relaxed) as *mut c_void)), None)?
        };
        sh.hwnd.store(hwnd.0 as isize, Ordering::SeqCst);
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, Arc::into_raw(sh.clone()) as isize); }
        self.hwnd.set(hwnd);
        // 그리는 스레드: 문서를 한 번 열어 두고, (페이지, 폭) 요청이 오면 가장 마지막 것만 그린다
        let (tx, rx) = mpsc::channel::<(u32, u32)>();
        let s2 = sh.clone();
        std::thread::spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let post = |s: &Shared| { let h = HWND(s.hwnd.load(Ordering::SeqCst) as *mut c_void); if !h.is_invalid() { let _ = PostMessageW(Some(h), WM_FRAME, WPARAM(0), LPARAM(0)); } };
            match load_pdf(&bytes) {
                Ok(doc) => {
                    let n = doc.PageCount().unwrap_or(0);
                    let sizes: Vec<(f32, f32)> = (0..n).map(|i| page_size(&doc, i).unwrap_or((612.0, 792.0))).collect();
                    *s2.sizes.lock().unwrap() = sizes;
                    s2.pages.store(n, Ordering::SeqCst);
                    post(&s2);
                    while let Ok(mut req) = rx.recv() {
                        while let Ok(r) = rx.try_recv() { req = r; }
                        if req.0 >= n { continue; }
                        if let Ok(f) = render(&doc, req.0, req.1) { *s2.frame.lock().unwrap() = Some(f); post(&s2); }
                    }
                }
                Err(e) => { *s2.error.lock().unwrap() = Some(format!("이 PDF를 미리 볼 수 없습니다 ({:#x})", e.code().0)); post(&s2); }
            }
            CoUninitialize();
        });
        *self.tx.borrow_mut() = Some(tx.clone());
        unsafe { SetPropW(hwnd, w!("airpdf.tx"), Some(HANDLE(Box::into_raw(Box::new(tx)) as *mut c_void))).ok(); }
        *self.shared.borrow_mut() = Some(sh);
        Ok(())
    }
    fn Unload(&self) -> windows::core::Result<()> {
        *self.tx.borrow_mut() = None;
        let h = self.hwnd.replace(HWND::default());
        if !h.is_invalid() {
            if let Some(s) = self.shared() { s.hwnd.store(0, Ordering::SeqCst); }
            unsafe { let _ = DestroyWindow(h); }
        }
        *self.shared.borrow_mut() = None;
        *self.bytes.borrow_mut() = None;
        Ok(())
    }
    fn SetFocus(&self) -> windows::core::Result<()> {
        unsafe { let _ = SetFocus(Some(self.hwnd.get())); }
        Ok(())
    }
    fn QueryFocus(&self) -> windows::core::Result<HWND> {
        let h = unsafe { GetFocus() };
        if h.is_invalid() { Err(E_FAIL.into()) } else { Ok(h) }
    }
    fn TranslateAccelerator(&self, msg: *const MSG) -> windows::core::Result<()> {
        // 미리보기 창 주인(탐색기)에게 넘긴다
        if let Some(site) = &*self.site.borrow() {
            if let Ok(frame) = site.cast::<IPreviewHandlerFrame>() {
                return unsafe { frame.TranslateAccelerator(msg) };
            }
        }
        Err(S_FALSE.into())
    }
}

unsafe fn shared_of(hwnd: HWND) -> Option<&'static Shared> {
    let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Shared;
    if p.is_null() { None } else { Some(&*p) }
}

/// 창에 맞는 폭으로 지금 페이지를 그려 달라고 한다
unsafe fn request(hwnd: HWND, s: &Shared) {
    let n = s.pages.load(Ordering::SeqCst);
    if n == 0 { return; }
    let cur = s.cur.load(Ordering::SeqCst).min(n - 1);
    let mut rc = RECT::default();
    let _ = GetClientRect(hwnd, &mut rc);
    let (aw, ah) = ((rc.right - 24).max(16) as f32, (rc.bottom - 24 - if n > 1 { 22 } else { 0 }).max(16) as f32);
    let (pw, ph) = s.sizes.lock().unwrap().get(cur as usize).copied().unwrap_or((612.0, 792.0));
    let width = aw.min(ah * pw / ph).round() as u32;
    let p = GetPropW(hwnd, w!("airpdf.tx"));
    if !p.is_invalid() {
        let tx = &*(p.0 as *const mpsc::Sender<(u32, u32)>);
        let _ = tx.send((cur, width));
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_FRAME | WM_SIZE => {
            if let Some(s) = shared_of(hwnd) {
                // 크기가 바뀌었거나 처음이면 다시 그려 달라고
                let need = s.frame.lock().unwrap().as_ref().map(|f| f.page != s.cur.load(Ordering::SeqCst)).unwrap_or(true) || msg == WM_SIZE;
                if need { request(hwnd, s); }
            }
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_MOUSEWHEEL | WM_KEYDOWN => {
            if let Some(s) = shared_of(hwnd) {
                let n = s.pages.load(Ordering::SeqCst);
                let cur = s.cur.load(Ordering::SeqCst) as i64;
                let step: i64 = if msg == WM_MOUSEWHEEL {
                    if ((wp.0 >> 16) as u16 as i16) < 0 { 1 } else { -1 }
                } else {
                    match wp.0 as u16 {
                        0x22 | 0x28 | 0x27 | 0x20 => 1, // PageDown, ↓, →, Space
                        0x21 | 0x26 | 0x25 => -1,       // PageUp, ↑, ←
                        0x24 => -cur,                   // Home
                        0x23 => n as i64 - 1 - cur,     // End
                        _ => 0,
                    }
                };
                let next = (cur + step).clamp(0, (n as i64 - 1).max(0));
                if next != cur { s.cur.store(next as u32, Ordering::SeqCst); request(hwnd, s); }
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => { let _ = SetFocus(Some(hwnd)); LRESULT(0) }
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            // 겹쳐 그리면 깜빡이므로 메모리에 그린 뒤 한 번에 옮긴다
            let mem = CreateCompatibleDC(Some(dc));
            let bmp = CreateCompatibleBitmap(dc, rc.right.max(1), rc.bottom.max(1));
            let old = SelectObject(mem, bmp.into());
            let bg = CreateSolidBrush(COLORREF(0x00efebe9));
            FillRect(mem, &rc, bg);
            let _ = DeleteObject(bg.into());
            if let Some(s) = shared_of(hwnd) {
                let n = s.pages.load(Ordering::SeqCst);
                let err = s.error.lock().unwrap().clone();
                if let Some(f) = s.frame.lock().unwrap().as_ref() {
                    let avail_h = rc.bottom - if n > 1 { 22 } else { 0 };
                    let x = ((rc.right - f.w as i32) / 2).max(0);
                    let y = ((avail_h - f.h as i32) / 2).max(0);
                    // 종이 그림자
                    let sh = CreateSolidBrush(COLORREF(0x00d4d0cc));
                    FillRect(mem, &RECT { left: x + 2, top: y + 2, right: x + f.w as i32 + 2, bottom: y + f.h as i32 + 2 }, sh);
                    let _ = DeleteObject(sh.into());
                    let (bi, w, h) = dib(f.w, f.h);
                    SetDIBitsToDevice(mem, x, y, w as u32, h as u32, 0, 0, 0, h as u32, f.px.as_ptr() as *const c_void, &bi, DIB_RGB_COLORS);
                }
                let mut label: Vec<u16> = Vec::new();
                if let Some(e) = err { label = e.encode_utf16().collect(); }
                else if n > 1 { label = format!("{} / {}  ·  휠이나 ↑↓로 넘기기", s.cur.load(Ordering::SeqCst) + 1, n).encode_utf16().collect(); }
                if !label.is_empty() {
                    SetBkMode(mem, TRANSPARENT);
                    SetTextColor(mem, COLORREF(0x00605850));
                    let font = CreateFontW(-13, 0, 0, 0, 400, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, 0, w!("Segoe UI"));
                    let of = SelectObject(mem, font.into());
                    let mut tr = RECT { left: 0, top: rc.bottom - 22, right: rc.right, bottom: rc.bottom };
                    DrawTextW(mem, &mut label, &mut tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                    SelectObject(mem, of);
                    let _ = DeleteObject(font.into());
                }
            }
            let _ = BitBlt(dc, 0, 0, rc.right, rc.bottom, Some(mem), 0, 0, SRCCOPY);
            SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        WM_DESTROY => {
            let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Shared;
            if !p.is_null() { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0); drop(Arc::from_raw(p)); }
            let t = RemovePropW(hwnd, w!("airpdf.tx"));
            if let Ok(t) = t { if !t.is_invalid() { drop(Box::from_raw(t.0 as *mut mpsc::Sender<(u32, u32)>)); } }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/* ───────────── 'Air PDF' 프린터로 인쇄한 파일 받기 ─────────────
 * 프린터는 Windows의 "Microsoft Print to PDF" 드라이버에 파일 포트(%ProgramData%\AirPDF\print\job.pdf)를 붙인 것이다.
 * 이 감시는 `rundll32 airpdf_shell_판.dll,PrintWatch`로 로그인할 때 켜져서, 인쇄가 끝난 파일을 옮겨 Air PDF로 연다.
 * 새 판이 설치되어 시작 등록(Run)이 다른 DLL을 가리키면 스스로 끝난다.
 */

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const RUN_NAME: PCWSTR = w!("AirPDF Print");

fn module_path() -> String {
    let mut buf = [0u16; 1024];
    let n = unsafe { windows::Win32::System::LibraryLoader::GetModuleFileNameW(Some(HMODULE(MODULE.load(Ordering::Relaxed) as *mut c_void)), &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..n])
}

fn run_value() -> Option<String> {
    use windows::Win32::System::Registry::*;
    let mut buf = [0u16; 2048];
    let mut len = (buf.len() * 2) as u32;
    let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, RUN_NAME, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut c_void), Some(&mut len)) };
    if r.is_err() { return None; }
    let n = (len as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..n]))
}

fn stamp() -> String {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}{:02}{:02}_{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

/// 다른 곳에서 쓰고 있지 않은가 (인쇄가 끝났는가)
fn free(p: &std::path::Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).write(true).share_mode(0).open(p).is_ok()
}

#[no_mangle]
pub extern "system" fn PrintWatch(_hwnd: HWND, _inst: HINSTANCE, _cmd: *const u8, _show: i32) {
    use windows::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
    let me = module_path().to_lowercase();
    let current = || run_value().map(|v| v.to_lowercase().contains(&me)).unwrap_or(false);
    // 한 사용자에 하나만. 옛 판이 아직 돌면 끝날 때까지 기다린다
    let Ok(m) = (unsafe { CreateMutexW(None, false, w!("Local\\AirPDF.PrintWatch")) }) else { return };
    // 같은 판이 이미 돌고 있으면 곧 끝낸다 (옛 판은 시작 등록이 바뀌면 3초 안에 끝난다)
    let mut tries = 0;
    loop {
        let r = unsafe { WaitForSingleObject(m, 1500) }.0;
        if r == 0 || r == 0x80 { break; }
        tries += 1;
        if !current() || tries > 6 { return; }
    }
    let pd = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    let job = std::path::Path::new(&pd).join("AirPDF").join("print").join("job.pdf");
    let la = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let out_dir = std::path::Path::new(&la).join("AirPDF").join("printed");
    // 설치 폴더\shell\이 DLL → 설치 폴더\air-pdf.exe
    let exe = std::path::Path::new(&module_path()).parent().and_then(|d| d.parent()).map(|d| d.join("air-pdf.exe"));
    let mut last: Option<(u64, std::time::SystemTime)> = None;
    let mut tick = 0u32;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(700));
        tick += 1;
        if tick % 4 == 0 && !current() { break; }
        let Ok(md) = std::fs::metadata(&job) else { last = None; continue };
        let now = (md.len(), md.modified().unwrap_or(std::time::UNIX_EPOCH));
        if md.len() == 0 || last != Some(now) { last = Some(now); continue; }
        if !free(&job) { continue; }
        last = None;
        let _ = std::fs::create_dir_all(&out_dir);
        let mut dest = out_dir.join(format!("인쇄_{}.pdf", stamp()));
        let mut k = 2;
        while dest.exists() { dest = out_dir.join(format!("인쇄_{}_{k}.pdf", stamp())); k += 1; }
        let moved = std::fs::rename(&job, &dest).is_ok() || (std::fs::copy(&job, &dest).is_ok() && std::fs::remove_file(&job).is_ok());
        if !moved { continue; }
        if let Some(exe) = &exe {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new(exe).arg("--printed").arg(&dest).creation_flags(0x0800_0000).spawn();
        }
    }
}
