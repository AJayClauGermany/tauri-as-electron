//! `webContents.printToPDF()` and `webContents.capturePage()` (roadmap C8),
//! through each platform's webview (`with_webview`):
//!
//! - **Linux (WebKitGTK)**: a `WebKitPrintOperation` printed without a dialog
//!   to GTK's "Print to File" printer (PDF to a temporary file, with a
//!   `GtkPageSetup` for the paper size, orientation and margins); the
//!   snapshot is `webkit_web_view_get_snapshot` of the visible area.
//! - **Windows (WebView2)**: `ICoreWebView2_7::PrintToPdf` with
//!   `ICoreWebView2PrintSettings` (every Electron option has a counterpart)
//!   and `CapturePreview` (PNG).
//! - **macOS (WKWebView)**: `createPDFWithConfiguration:` (one page as tall
//!   as the content: WebKit applies no paper size, margins or orientation)
//!   and `takeSnapshotWithConfiguration:`.
//!
//! Both start on the main thread (where `with_webview` runs) and finish in a
//! completion callback; the async command waits for it on a blocking thread,
//! so the main thread is never blocked.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use serde::Deserialize;
use tauri::{ipc::Response, webview::PlatformWebview, AppHandle, Runtime};

const TIMEOUT: Duration = Duration::from_secs(120);

/// `printToPDF` options, normalized by tauri-electron (src/main/capture.js).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
#[allow(dead_code)]
pub struct PdfOptions {
    pub landscape: bool,
    pub print_background: bool,
    pub scale: f64,
    /// Paper size in inches, portrait (`landscape` turns it).
    pub page_width: f64,
    pub page_height: f64,
    /// Margins in inches.
    pub margin_top: f64,
    pub margin_bottom: f64,
    pub margin_left: f64,
    pub margin_right: f64,
    /// 1-based, inclusive; empty for every page.
    pub page_ranges: Vec<(u32, u32)>,
    pub display_header_footer: bool,
}

impl Default for PdfOptions {
    fn default() -> Self {
        Self {
            landscape: false,
            print_background: false,
            scale: 1.0,
            page_width: 8.5,
            page_height: 11.0,
            margin_top: 0.4,
            margin_bottom: 0.4,
            margin_left: 0.4,
            margin_right: 0.4,
            page_ranges: Vec::new(),
            display_header_footer: false,
        }
    }
}

impl PdfOptions {
    /// `"1-3,5"`: the page ranges as WebView2 takes them.
    #[allow(dead_code)]
    pub fn ranges_string(&self) -> String {
        self.page_ranges
            .iter()
            .map(|&(from, to)| {
                if from == to {
                    from.to_string()
                } else {
                    format!("{from}-{to}")
                }
            })
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// Answers an operation once: from its completion callback, or from the
/// setup that failed before the callback was registered.
pub struct Done<T>(Arc<Mutex<Option<mpsc::Sender<Result<T, String>>>>>);

impl<T> Clone for Done<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> Done<T> {
    pub fn send(&self, result: Result<T, String>) {
        if let Some(sender) = self.0.lock().unwrap().take() {
            let _ = sender.send(result);
        }
    }
}

/// Start `start` with the webview (a window's own, or a view's with
/// `child-webviews`) on the main thread and wait (off the main thread) for
/// the result it sends when the operation completes.
async fn with_platform_webview<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    label: &str,
    start: impl FnOnce(PlatformWebview, Done<T>) + Send + 'static,
) -> Result<T, String> {
    // Not get_webview_window: a window holding views is no longer one to Tauri.
    let window = crate::views::find(app, label).ok_or_else(|| format!("no webview '{label}'"))?;
    let (sender, wait) = mpsc::channel();
    let done = Done(Arc::new(Mutex::new(Some(sender))));
    window
        .with_webview(move |webview| start(webview, done))
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || match wait.recv_timeout(TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err("the webview did not answer in time".into()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("the webview gave no result".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A temporary file for a PDF.
#[allow(dead_code)]
fn temp_pdf() -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    std::env::temp_dir().join(format!(
        "tauri-electron-print-{}-{}.pdf",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Read and delete a finished PDF (on another thread: it can be large).
#[allow(dead_code)]
fn send_file(path: PathBuf, done: Done<Vec<u8>>) {
    std::thread::spawn(move || {
        let result = std::fs::read(&path).map_err(|e| format!("reading the PDF: {e}"));
        let _ = std::fs::remove_file(&path);
        done.send(result.and_then(|bytes| {
            if bytes.is_empty() {
                Err("the webview produced an empty PDF".into())
            } else {
                Ok(bytes)
            }
        }));
    });
}

#[allow(dead_code)]
fn remove_quietly(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// `webContents.printToPDF(options)`: the PDF's bytes.
#[tauri::command]
pub async fn print_to_pdf<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    options: Option<PdfOptions>,
) -> Result<Response, String> {
    let options = options.unwrap_or_default();
    let bytes = with_platform_webview(&app, &label, move |webview, done| {
        platform::print_to_pdf(webview, options, done)
    })
    .await?;
    Ok(Response::new(bytes))
}

/// `webContents.capturePage()`: a PNG of the visible page (empty when the
/// webview has nothing to show, like a hidden window).
#[tauri::command]
pub async fn capture_page<R: Runtime>(
    app: AppHandle<R>,
    label: String,
) -> Result<Response, String> {
    let bytes = with_platform_webview(&app, &label, platform::capture_page).await?;
    Ok(Response::new(bytes))
}

/// RGBA pixels → PNG.
#[allow(dead_code)]
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Premultiplied native-endian ARGB32 (cairo, GDI) → straight RGBA.
#[allow(dead_code)]
pub fn bgra_premultiplied_to_rgba(
    data: &[u8],
    width: usize,
    height: usize,
    stride: usize,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(width * height * 4);
    for row in 0..height {
        let line = &data[row * stride..row * stride + width * 4];
        for px in line.chunks_exact(4) {
            let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
            if a == 0 || a == 255 {
                out.extend_from_slice(&[r, g, b, a]);
            } else {
                let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
                out.extend_from_slice(&[un(r), un(g), un(b), a]);
            }
        }
    }
    out
}

// --- Linux: WebKitGTK -------------------------------------------------------------------------

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
mod platform {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    use webkit2gtk::{
        PrintOperation, PrintOperationExt, SettingsExt, SnapshotOptions, SnapshotRegion, WebViewExt,
    };

    /// GTK's file printer, under its (translated) name.
    fn file_printer() -> String {
        webkit2gtk::glib::dgettext(Some("gtk30"), "Print to File").to_string()
    }

    pub fn print_to_pdf(webview: PlatformWebview, options: PdfOptions, done: Done<Vec<u8>>) {
        let view = webview.inner();
        let path = temp_pdf();
        let uri = match webkit2gtk::glib::filename_to_uri(&path, None) {
            Ok(uri) => uri.to_string(),
            Err(e) => return done.send(Err(e.to_string())),
        };

        let settings = gtk::PrintSettings::new();
        settings.set_printer(&file_printer());
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
        settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&uri));
        settings.set_scale(options.scale * 100.0);
        if !options.page_ranges.is_empty() {
            let ranges: Vec<gtk::PageRange> = options
                .page_ranges
                .iter()
                .map(|&(from, to)| {
                    gtk::PageRange::new(from.saturating_sub(1) as i32, to.saturating_sub(1) as i32)
                })
                .collect();
            settings.set_print_pages(gtk::PrintPages::Ranges);
            settings.set_page_ranges(&ranges);
        }
        let orientation = if options.landscape {
            gtk::PageOrientation::Landscape
        } else {
            gtk::PageOrientation::Portrait
        };
        settings.set_orientation(orientation);

        let paper = gtk::PaperSize::new_custom(
            "tauri-electron",
            "tauri-electron",
            options.page_width,
            options.page_height,
            gtk::Unit::Inch,
        );
        settings.set_paper_size(&paper);
        let setup = gtk::PageSetup::new();
        setup.set_paper_size(&paper);
        setup.set_orientation(orientation);
        setup.set_top_margin(options.margin_top, gtk::Unit::Inch);
        setup.set_bottom_margin(options.margin_bottom, gtk::Unit::Inch);
        setup.set_left_margin(options.margin_left, gtk::Unit::Inch);
        setup.set_right_margin(options.margin_right, gtk::Unit::Inch);

        // `print-backgrounds` is a webview setting: set it for this job only.
        let web_settings = WebViewExt::settings(&view);
        let previous = web_settings.as_ref().map(|s| s.is_print_backgrounds());
        if let Some(s) = &web_settings {
            s.set_print_backgrounds(options.print_background);
        }

        let operation = PrintOperation::new(&view);
        operation.set_print_settings(&settings);
        operation.set_page_setup(&setup);

        // `failed` comes before `finished`; the first one answers. The
        // operation is kept alive until `finished`.
        let keep = Rc::new(RefCell::new(Some(operation.clone())));
        let restore = move || {
            if let (Some(s), Some(previous)) = (&web_settings, previous) {
                s.set_print_backgrounds(previous);
            }
        };
        {
            let done = done.clone();
            let path = path.clone();
            operation.connect_failed(move |_, error| {
                remove_quietly(&path);
                done.send(Err(format!("printing failed: {error}")));
            });
        }
        operation.connect_finished(move |_| {
            restore();
            keep.borrow_mut().take();
            send_file(path.clone(), done.clone());
        });
        operation.print();
    }

    pub fn capture_page(webview: PlatformWebview, done: Done<Vec<u8>>) {
        let view = webview.inner();
        view.snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&webkit2gtk::gio::Cancellable>,
            move |result| {
                let png = match result {
                    // Nothing to show (a hidden window): an empty image, as in Electron.
                    Err(_) => Ok(Vec::new()),
                    Ok(surface) => surface_png(surface),
                };
                done.send(png);
            },
        );
    }

    fn surface_png(surface: cairo::Surface) -> Result<Vec<u8>, String> {
        let image = cairo::ImageSurface::try_from(surface)
            .map_err(|_| "the snapshot is not an image surface".to_string())?;
        image.flush();
        let (width, height, stride) = (
            image.width() as usize,
            image.height() as usize,
            image.stride() as usize,
        );
        if width == 0 || height == 0 {
            return Ok(Vec::new());
        }
        if image.format() != cairo::Format::ARgb32 && image.format() != cairo::Format::Rgb24 {
            return Err(format!("unexpected snapshot format {:?}", image.format()));
        }
        let opaque = image.format() == cairo::Format::Rgb24;
        let mut rgba = Vec::new();
        image
            .with_data(|data| {
                rgba = bgra_premultiplied_to_rgba(data, width, height, stride);
            })
            .map_err(|e| e.to_string())?;
        if opaque {
            for px in rgba.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }
        encode_png(width as u32, height as u32, &rgba)
    }
}

// --- Windows: WebView2 ------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::*;
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment6, ICoreWebView2PrintSettings2, ICoreWebView2_7,
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
        },
        PrintToPdfCompletedHandler,
    };
    use windows::{
        core::{Interface, HSTRING},
        Win32::{
            Foundation::E_OUTOFMEMORY,
            System::Com::{IStream, STREAM_SEEK_SET},
            UI::Shell::SHCreateMemStream,
        },
    };

    pub fn print_to_pdf(webview: PlatformWebview, options: PdfOptions, done: Done<Vec<u8>>) {
        let path = temp_pdf();
        let result = (|| -> windows::core::Result<()> {
            unsafe {
                let core = webview.controller().CoreWebView2()?;
                let core7: ICoreWebView2_7 = core.cast()?;
                let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
                let settings = environment.CreatePrintSettings()?;
                settings.SetOrientation(if options.landscape {
                    COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                } else {
                    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                })?;
                settings.SetScaleFactor(options.scale)?;
                settings.SetPageWidth(options.page_width)?;
                settings.SetPageHeight(options.page_height)?;
                settings.SetMarginTop(options.margin_top)?;
                settings.SetMarginBottom(options.margin_bottom)?;
                settings.SetMarginLeft(options.margin_left)?;
                settings.SetMarginRight(options.margin_right)?;
                settings.SetShouldPrintBackgrounds(options.print_background)?;
                settings.SetShouldPrintHeaderAndFooter(options.display_header_footer)?;
                if !options.page_ranges.is_empty() {
                    if let Ok(settings2) = settings.cast::<ICoreWebView2PrintSettings2>() {
                        settings2.SetPageRanges(&HSTRING::from(options.ranges_string()))?;
                    }
                }
                let (target, answer) = (path.clone(), done.clone());
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |error, ok| {
                    match error {
                        Ok(()) if ok => send_file(target, answer),
                        Ok(()) => {
                            remove_quietly(&target);
                            answer.send(Err("WebView2 could not print the page".into()));
                        }
                        Err(e) => {
                            remove_quietly(&target);
                            answer.send(Err(e.to_string()));
                        }
                    }
                    Ok(())
                }));
                core7.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler)
            }
        })();
        if let Err(e) = result {
            done.send(Err(e.to_string()));
        }
    }

    pub fn capture_page(webview: PlatformWebview, done: Done<Vec<u8>>) {
        let started = (|| -> windows::core::Result<()> {
            unsafe {
                let core = webview.controller().CoreWebView2()?;
                let stream: IStream = SHCreateMemStream(None)
                    .ok_or_else(|| windows::core::Error::from(E_OUTOFMEMORY))?;
                let (target, answer) = (stream.clone(), done.clone());
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |error| {
                    answer.send(match error {
                        Ok(()) => read_stream(&target).map_err(|e| e.to_string()),
                        Err(e) => Err(e.to_string()),
                    });
                    Ok(())
                }));
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                )
            }
        })();
        if let Err(e) = started {
            done.send(Err(e.to_string()));
        }
    }

    fn read_stream(stream: &IStream) -> windows::core::Result<Vec<u8>> {
        unsafe {
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut out = Vec::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let mut read = 0u32;
                stream
                    .Read(
                        buffer.as_mut_ptr().cast(),
                        buffer.len() as u32,
                        Some(&mut read),
                    )
                    .ok()?;
                if read == 0 {
                    break;
                }
                out.extend_from_slice(&buffer[..read as usize]);
            }
            Ok(out)
        }
    }
}

// --- macOS: WKWebView -------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSData, NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    fn web_view(webview: &PlatformWebview) -> &WKWebView {
        // SAFETY: tauri hands out the window's WKWebView, alive while the closure runs.
        unsafe { &*(webview.inner() as *const WKWebView) }
    }

    fn error_text(error: *mut NSError) -> String {
        unsafe { error.as_ref() }
            .map(|e| e.localizedDescription().to_string())
            .unwrap_or_else(|| "WebKit reported no result".into())
    }

    /// WKWebView's PDF is one page as tall as the content: the paper size,
    /// margins, orientation, scale and page ranges are not applied.
    pub fn print_to_pdf(webview: PlatformWebview, _options: PdfOptions, done: Done<Vec<u8>>) {
        let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
            done.send(match unsafe { data.as_ref() } {
                Some(data) => Ok(data.to_vec()),
                None => Err(error_text(error)),
            });
        });
        unsafe { web_view(&webview).createPDFWithConfiguration_completionHandler(None, &block) };
    }

    pub fn capture_page(webview: PlatformWebview, done: Done<Vec<u8>>) {
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            done.send(match unsafe { image.as_ref() } {
                Some(image) => Ok(png_of(image).unwrap_or_default()),
                None => Err(error_text(error)),
            });
        });
        unsafe { web_view(&webview).takeSnapshotWithConfiguration_completionHandler(None, &block) };
    }

    fn png_of(image: &NSImage) -> Option<Vec<u8>> {
        let tiff = image.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }?;
        Some(png.to_vec())
    }
}

// --- elsewhere --------------------------------------------------------------------------------

#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    windows,
    target_os = "macos"
)))]
mod platform {
    use super::*;

    pub fn print_to_pdf(_webview: PlatformWebview, _options: PdfOptions, done: Done<Vec<u8>>) {
        done.send(Err("printToPDF is not available on this platform".into()));
    }

    pub fn capture_page(_webview: PlatformWebview, done: Done<Vec<u8>>) {
        done.send(Err("capturePage is not available on this platform".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_ranges_for_webview2() {
        let options = PdfOptions {
            page_ranges: vec![(1, 3), (5, 5)],
            ..Default::default()
        };
        assert_eq!(options.ranges_string(), "1-3,5");
        assert_eq!(PdfOptions::default().ranges_string(), "");
    }

    #[test]
    fn unpremultiplies_bgra() {
        // One opaque blue pixel, one half-transparent red one (premultiplied), one transparent.
        let data = [255, 0, 0, 255, 0, 0, 64, 128, 9, 9, 9, 0];
        let rgba = bgra_premultiplied_to_rgba(&data, 3, 1, 12);
        assert_eq!(&rgba[0..4], &[0, 0, 255, 255]);
        assert_eq!(&rgba[4..8], &[128, 0, 0, 128]);
        assert_eq!(rgba[11], 0);
    }

    #[test]
    fn encodes_png() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn options_from_javascript() {
        let options: PdfOptions = serde_json::from_value(serde_json::json!({
            "landscape": true, "pageWidth": 8.27, "pageHeight": 11.7, "pageRanges": [[2, 4]]
        }))
        .unwrap();
        assert!(options.landscape);
        assert_eq!(options.page_ranges, vec![(2, 4)]);
        assert_eq!(options.scale, 1.0);
        assert_eq!(options.margin_top, 0.4);
    }
}
