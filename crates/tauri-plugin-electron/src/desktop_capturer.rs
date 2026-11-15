//! `desktopCapturer.getSources()` (roadmap C9): the screens and windows a
//! page could share, with thumbnails and window icons.
//!
//! - **Linux**: X11 through x11rb (`GetImage` of the root window and of each
//!   window in `_NET_CLIENT_LIST`, `_NET_WM_NAME`, `_NET_WM_ICON`). Under
//!   Wayland, X11 cannot see other windows or the screen: the screens are
//!   listed without thumbnails and no windows are.
//! - **Windows**: GDI (`StretchBlt` of the screen, `PrintWindow` for
//!   windows, `EnumWindows`, the window's icon).
//! - **macOS**: CoreGraphics (`CGDisplayCreateImage`,
//!   `CGWindowListCopyWindowInfo` / `CGWindowListCreateImage`), which needs
//!   the Screen Recording permission (without it, other apps' windows have
//!   no names and their thumbnails show the desktop).
//!
//! What a page then receives is decided by `getDisplayMedia` (see
//! `display_media.rs`): no webview lets the app choose the source itself.

#![cfg_attr(not(feature = "desktop-capturer"), allow(dead_code))]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub screens: bool,
    pub windows: bool,
    /// Thumbnails fit in this size (in pixels); 0 × 0 skips them.
    pub thumbnail_width: u32,
    pub thumbnail_height: u32,
    pub fetch_window_icons: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub display_id: String,
    /// PNG, base64 (empty: no thumbnail).
    pub thumbnail: String,
    pub app_icon: Option<String>,
}

/// A monitor as Tauri reports it (physical pixels, desktop coordinates).
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct Screen {
    pub index: usize,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// RGBA pixels.
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The size of a `width` × `height` image scaled to fit in `max_w` × `max_h`
/// (keeping its aspect ratio), or None for no thumbnail.
pub fn fit(width: u32, height: u32, max_w: u32, max_h: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 || max_w == 0 || max_h == 0 {
        return None;
    }
    let scale = f64::min(max_w as f64 / width as f64, max_h as f64 / height as f64);
    let w = ((width as f64 * scale).round() as u32).clamp(1, max_w);
    let h = ((height as f64 * scale).round() as u32).clamp(1, max_h);
    Some((w, h))
}

/// Scale to `width` × `height`: the average of the covered pixels when
/// shrinking, the nearest pixel when growing.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn scale(src: &Pixels, width: u32, height: u32) -> Pixels {
    let (sw, sh) = (src.width as usize, src.height as usize);
    let (dw, dh) = (width as usize, height as usize);
    let mut rgba = vec![0u8; dw * dh * 4];
    for y in 0..dh {
        let y0 = y * sh / dh;
        let y1 = ((y + 1) * sh / dh).max(y0 + 1).min(sh);
        for x in 0..dw {
            let x0 = x * sw / dw;
            let x1 = ((x + 1) * sw / dw).max(x0 + 1).min(sw);
            let mut sum = [0u64; 4];
            for sy in y0..y1 {
                let row = &src.rgba[(sy * sw + x0) * 4..(sy * sw + x1) * 4];
                for px in row.chunks_exact(4) {
                    for c in 0..4 {
                        sum[c] += px[c] as u64;
                    }
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u64;
            let out = &mut rgba[(y * dw + x) * 4..(y * dw + x) * 4 + 4];
            for c in 0..4 {
                out[c] = ((sum[c] + n / 2) / n) as u8;
            }
        }
    }
    Pixels {
        width,
        height,
        rgba,
    }
}

/// A thumbnail of `pixels` fitting the options' size, as base64 PNG.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn thumbnail(pixels: Option<Pixels>, options: &Options) -> String {
    let Some(pixels) = pixels else {
        return String::new();
    };
    let Some((w, h)) = fit(
        pixels.width,
        pixels.height,
        options.thumbnail_width,
        options.thumbnail_height,
    ) else {
        return String::new();
    };
    let scaled = if (w, h) == (pixels.width, pixels.height) {
        pixels
    } else {
        scale(&pixels, w, h)
    };
    png_base64(&scaled)
}

pub fn png_base64(pixels: &Pixels) -> String {
    crate::capture::encode_png(pixels.width, pixels.height, &pixels.rgba)
        .map(|png| BASE64.encode(png))
        .unwrap_or_default()
}

/// Electron's names: "Entire Screen" for one screen, "Screen 1", "Screen 2", ... otherwise.
pub fn screen_name(index: usize, count: usize) -> String {
    if count == 1 {
        "Entire Screen".into()
    } else {
        format!("Screen {}", index + 1)
    }
}

/// A screen source; `display_id` matches `screen.getAllDisplays()` (index + 1).
#[allow(dead_code)]
fn screen_source(screen: &Screen, count: usize, thumbnail: String) -> Source {
    Source {
        id: format!("screen:{}:0", screen.index + 1),
        name: screen_name(screen.index, count),
        display_id: (screen.index + 1).to_string(),
        thumbnail,
        app_icon: None,
    }
}

/// `desktopCapturer.getSources()`.
#[tauri::command]
pub async fn desktop_sources<R: Runtime>(
    app: AppHandle<R>,
    options: Options,
) -> Result<Vec<Source>, Value> {
    #[cfg(not(feature = "desktop-capturer"))]
    {
        let _ = (app, options);
        Err(json!({ "code": "ERR_FEATURE_DISABLED", "feature": "desktop-capturer" }))
    }
    #[cfg(feature = "desktop-capturer")]
    sources(app, options)
        .await
        .map_err(|message| json!({ "message": message }))
}

#[cfg(feature = "desktop-capturer")]
async fn sources<R: Runtime>(app: AppHandle<R>, options: Options) -> Result<Vec<Source>, String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let screens: Vec<Screen> = monitors
        .iter()
        .enumerate()
        .map(|(index, m)| Screen {
            index,
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();
    tauri::async_runtime::spawn_blocking(move || platform::sources(&options, &screens))
        .await
        .map_err(|e| e.to_string())?
}

// --- Linux: X11 -------------------------------------------------------------------------------

#[cfg(all(
    feature = "desktop-capturer",
    any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )
))]
mod platform {
    use super::*;
    use x11rb::{
        connection::Connection,
        protocol::xproto::{
            Atom, AtomEnum, ConnectionExt as _, ImageFormat, ImageOrder, MapState, Window,
            WindowClass,
        },
        rust_connection::RustConnection,
    };

    fn wayland_session() -> bool {
        std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.eq_ignore_ascii_case("wayland"))
            || (std::env::var_os("WAYLAND_DISPLAY").is_some()
                && std::env::var_os("DISPLAY").is_none())
    }

    pub fn sources(options: &Options, screens: &[Screen]) -> Result<Vec<Source>, String> {
        let x11 = if wayland_session() {
            None
        } else {
            x11rb::connect(None).ok()
        };
        let mut out = Vec::new();
        if options.screens {
            for screen in screens {
                let pixels = x11.as_ref().and_then(|(conn, n)| {
                    let root = conn.setup().roots[*n].root;
                    capture(conn, root, screen.x, screen.y, screen.width, screen.height)
                });
                out.push(screen_source(
                    screen,
                    screens.len(),
                    thumbnail(pixels, options),
                ));
            }
        }
        if options.windows {
            if let Some((conn, n)) = &x11 {
                out.extend(windows(conn, *n, options));
            }
        }
        Ok(out)
    }

    fn atom(conn: &RustConnection, name: &str) -> Option<Atom> {
        let atom = conn
            .intern_atom(true, name.as_bytes())
            .ok()?
            .reply()
            .ok()?
            .atom;
        (atom != 0).then_some(atom)
    }

    /// The managed windows (`_NET_CLIENT_LIST`); without a window manager, the
    /// root's mapped, named children.
    fn window_list(conn: &RustConnection, root: Window) -> Vec<Window> {
        if let Some(list) = atom(conn, "_NET_CLIENT_LIST") {
            if let Ok(Ok(reply)) = conn
                .get_property(false, root, list, AtomEnum::WINDOW, 0, u32::MAX / 4)
                .map(|c| c.reply())
            {
                if let Some(values) = reply.value32() {
                    let windows: Vec<Window> = values.collect();
                    if !windows.is_empty() {
                        return windows;
                    }
                }
            }
        }
        let Ok(Ok(tree)) = conn.query_tree(root).map(|c| c.reply()) else {
            return Vec::new();
        };
        tree.children
            .into_iter()
            .filter(|&w| {
                conn.get_window_attributes(w)
                    .ok()
                    .and_then(|c| c.reply().ok())
                    .is_some_and(|a| {
                        a.map_state == MapState::VIEWABLE
                            && !a.override_redirect
                            && a.class == WindowClass::INPUT_OUTPUT
                    })
            })
            .collect()
    }

    fn window_name(conn: &RustConnection, window: Window) -> Option<String> {
        let utf8 = atom(conn, "UTF8_STRING");
        if let (Some(name), Some(utf8)) = (atom(conn, "_NET_WM_NAME"), utf8) {
            if let Ok(Ok(reply)) = conn
                .get_property(false, window, name, utf8, 0, 1024)
                .map(|c| c.reply())
            {
                if !reply.value.is_empty() {
                    return Some(String::from_utf8_lossy(&reply.value).into_owned());
                }
            }
        }
        let reply = conn
            .get_property(false, window, AtomEnum::WM_NAME, AtomEnum::ANY, 0, 1024)
            .ok()?
            .reply()
            .ok()?;
        (!reply.value.is_empty()).then(|| String::from_utf8_lossy(&reply.value).into_owned())
    }

    fn windows(conn: &RustConnection, screen: usize, options: &Options) -> Vec<Source> {
        let root_info = &conn.setup().roots[screen];
        let root = root_info.root;
        let (root_w, root_h) = (
            root_info.width_in_pixels as i32,
            root_info.height_in_pixels as i32,
        );
        let mut out = Vec::new();
        for window in window_list(conn, root) {
            let Some(name) = window_name(conn, window).filter(|n| !n.trim().is_empty()) else {
                continue;
            };
            let pixels = (options.thumbnail_width > 0 && options.thumbnail_height > 0)
                .then(|| window_pixels(conn, root, window, root_w, root_h))
                .flatten();
            let app_icon = options
                .fetch_window_icons
                .then(|| icon(conn, window))
                .flatten()
                .map(|p| png_base64(&p));
            out.push(Source {
                id: format!("window:{window}:0"),
                name,
                display_id: String::new(),
                thumbnail: thumbnail(pixels, options),
                app_icon,
            });
        }
        out
    }

    /// The window's visible part (GetImage fails for areas off the screen).
    fn window_pixels(
        conn: &RustConnection,
        root: Window,
        window: Window,
        root_w: i32,
        root_h: i32,
    ) -> Option<Pixels> {
        let geometry = conn.get_geometry(window).ok()?.reply().ok()?;
        let origin = conn
            .translate_coordinates(window, root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        let (ox, oy) = (origin.dst_x as i32, origin.dst_y as i32);
        let x0 = ox.max(0);
        let y0 = oy.max(0);
        let x1 = (ox + geometry.width as i32).min(root_w);
        let y1 = (oy + geometry.height as i32).min(root_h);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        capture(
            conn,
            window,
            x0 - ox,
            y0 - oy,
            (x1 - x0) as u32,
            (y1 - y0) as u32,
        )
    }

    /// GetImage of a drawable's area, for 24 / 32-bit TrueColor visuals.
    pub fn capture(
        conn: &RustConnection,
        drawable: u32,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Option<Pixels> {
        let (w, h) = (width.min(u16::MAX as u32), height.min(u16::MAX as u32));
        let reply = conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                drawable,
                x as i16,
                y as i16,
                w as u16,
                h as u16,
                !0,
            )
            .ok()?
            .reply()
            .ok()?;
        let setup = conn.setup();
        let format = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == reply.depth)?;
        if format.bits_per_pixel != 32 || reply.depth < 24 {
            return None;
        }
        let msb = setup.image_byte_order == ImageOrder::MSB_FIRST;
        let count = (w * h) as usize;
        if reply.data.len() < count * 4 {
            return None;
        }
        let mut rgba = Vec::with_capacity(count * 4);
        for px in reply.data[..count * 4].chunks_exact(4) {
            let (r, g, b) = if msb {
                (px[1], px[2], px[3])
            } else {
                (px[2], px[1], px[0])
            };
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
        Some(Pixels {
            width: w,
            height: h,
            rgba,
        })
    }

    /// `_NET_WM_ICON`: the largest icon up to 128 pixels (else the smallest).
    fn icon(conn: &RustConnection, window: Window) -> Option<Pixels> {
        let property = atom(conn, "_NET_WM_ICON")?;
        let reply = conn
            .get_property(false, window, property, AtomEnum::CARDINAL, 0, u32::MAX / 4)
            .ok()?
            .reply()
            .ok()?;
        let values: Vec<u32> = reply.value32()?.collect();
        let mut icons = Vec::new();
        let mut i = 0;
        while i + 2 <= values.len() {
            let (w, h) = (values[i], values[i + 1]);
            let n = (w as usize).saturating_mul(h as usize);
            if w == 0 || h == 0 || i + 2 + n > values.len() {
                break;
            }
            icons.push((w, h, &values[i + 2..i + 2 + n]));
            i += 2 + n;
        }
        let best = icons
            .iter()
            .filter(|(w, _, _)| *w <= 128)
            .max_by_key(|(w, _, _)| *w)
            .or_else(|| icons.iter().min_by_key(|(w, _, _)| *w))?;
        let (w, h, argb) = *best;
        let mut rgba = Vec::with_capacity(argb.len() * 4);
        for &p in argb {
            rgba.extend_from_slice(&[(p >> 16) as u8, (p >> 8) as u8, p as u8, (p >> 24) as u8]);
        }
        Some(Pixels {
            width: w,
            height: h,
            rgba,
        })
    }
}

// --- Windows: GDI -----------------------------------------------------------------------------

#[cfg(all(feature = "desktop-capturer", windows))]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use windows::{
        core::BOOL,
        Win32::{
            Foundation::{HWND, LPARAM, RECT, WPARAM},
            Graphics::{
                Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
                Gdi::{
                    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
                    GetDIBits, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO,
                    BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HBITMAP, HDC,
                    SRCCOPY,
                },
            },
            Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
            UI::WindowsAndMessaging::{
                DrawIconEx, EnumWindows, GetClassLongPtrW, GetWindow, GetWindowLongW,
                GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
                SendMessageTimeoutW, DI_NORMAL, GCLP_HICON, GCLP_HICONSM, GWL_EXSTYLE, GW_OWNER,
                HICON, ICON_BIG, ICON_SMALL2, SMTO_ABORTIFHUNG, WM_GETICON, WS_EX_TOOLWINDOW,
            },
        },
    };

    /// PW_RENDERFULLCONTENT: windows drawn with DirectComposition (browsers, WebView2).
    const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

    pub fn sources(options: &Options, screens: &[Screen]) -> Result<Vec<Source>, String> {
        let mut out = Vec::new();
        if options.screens {
            for screen in screens {
                let pixels = fit(
                    screen.width,
                    screen.height,
                    options.thumbnail_width,
                    options.thumbnail_height,
                )
                .and_then(|(w, h)| unsafe {
                    let screen_dc = GetDC(None);
                    let pixels = stretch(
                        screen_dc,
                        screen.x,
                        screen.y,
                        screen.width as i32,
                        screen.height as i32,
                        w,
                        h,
                    );
                    ReleaseDC(None, screen_dc);
                    pixels
                });
                out.push(screen_source(
                    screen,
                    screens.len(),
                    pixels.map(|p| png_base64(&p)).unwrap_or_default(),
                ));
            }
        }
        if options.windows {
            for hwnd in top_level_windows() {
                let name = unsafe {
                    let mut buffer = vec![0u16; GetWindowTextLengthW(hwnd) as usize + 1];
                    let len = GetWindowTextW(hwnd, &mut buffer);
                    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
                };
                if name.trim().is_empty() {
                    continue;
                }
                let thumbnail = window_thumbnail(hwnd, options)
                    .map(|p| png_base64(&p))
                    .unwrap_or_default();
                let app_icon = options
                    .fetch_window_icons
                    .then(|| window_icon(hwnd))
                    .flatten()
                    .map(|p| png_base64(&p));
                out.push(Source {
                    id: format!("window:{}:0", hwnd.0 as isize),
                    name,
                    display_id: String::new(),
                    thumbnail,
                    app_icon,
                });
            }
        }
        Ok(out)
    }

    unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<HWND>) };
        list.push(hwnd);
        BOOL(1)
    }

    /// Visible, uncloaked, unowned windows with a title (what Alt+Tab shows).
    fn top_level_windows() -> Vec<HWND> {
        let mut all: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
        }
        all.into_iter()
            .filter(|&hwnd| unsafe {
                if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) == 0 {
                    return false;
                }
                if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                    return false;
                }
                if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()) {
                    return false;
                }
                let mut cloaked = 0u32;
                let _ = DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_CLOAKED,
                    &mut cloaked as *mut u32 as *mut c_void,
                    std::mem::size_of::<u32>() as u32,
                );
                cloaked == 0
            })
            .collect()
    }

    fn window_thumbnail(hwnd: HWND, options: &Options) -> Option<Pixels> {
        unsafe {
            let mut rect = RECT::default();
            GetWindowRect(hwnd, &mut rect).ok()?;
            let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
            if width <= 0 || height <= 0 {
                return None;
            }
            let (tw, th) = fit(
                width as u32,
                height as u32,
                options.thumbnail_width,
                options.thumbnail_height,
            )?;
            let screen_dc = GetDC(None);
            let full_dc = CreateCompatibleDC(Some(screen_dc));
            let full = CreateCompatibleBitmap(screen_dc, width, height);
            let previous = SelectObject(full_dc, full.into());
            let printed = PrintWindow(hwnd, full_dc, PW_RENDERFULLCONTENT).as_bool();
            let pixels = if printed {
                stretch(full_dc, 0, 0, width, height, tw, th)
            } else {
                None
            };
            SelectObject(full_dc, previous);
            let _ = DeleteObject(full.into());
            let _ = DeleteDC(full_dc);
            ReleaseDC(None, screen_dc);
            pixels
        }
    }

    /// StretchBlt an area of `source` into a `tw` × `th` bitmap and read it.
    unsafe fn stretch(
        source: HDC,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        tw: u32,
        th: u32,
    ) -> Option<Pixels> {
        unsafe {
            let dc = CreateCompatibleDC(Some(source));
            let bitmap = CreateCompatibleBitmap(source, tw as i32, th as i32);
            let previous = SelectObject(dc, bitmap.into());
            SetStretchBltMode(dc, HALFTONE);
            let ok = StretchBlt(
                dc,
                0,
                0,
                tw as i32,
                th as i32,
                Some(source),
                x,
                y,
                width,
                height,
                SRCCOPY | CAPTUREBLT,
            )
            .as_bool();
            SelectObject(dc, previous);
            let pixels = if ok {
                read_bitmap(dc, bitmap, tw, th, true)
            } else {
                None
            };
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(dc);
            pixels
        }
    }

    /// A bitmap's pixels as RGBA (`opaque`: GDI leaves the alpha byte undefined).
    unsafe fn read_bitmap(
        dc: HDC,
        bitmap: HBITMAP,
        width: u32,
        height: u32,
        opaque: bool,
    ) -> Option<Pixels> {
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (width * height * 4) as usize];
        let lines = unsafe {
            GetDIBits(
                dc,
                bitmap,
                0,
                height,
                Some(bgra.as_mut_ptr() as *mut c_void),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if lines == 0 {
            return None;
        }
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
            if opaque {
                px[3] = 255;
            }
        }
        Some(Pixels {
            width,
            height,
            rgba: bgra,
        })
    }

    fn window_icon(hwnd: HWND) -> Option<Pixels> {
        unsafe {
            let mut result = 0usize;
            let mut icon = 0usize;
            for kind in [ICON_BIG, ICON_SMALL2] {
                SendMessageTimeoutW(
                    hwnd,
                    WM_GETICON,
                    WPARAM(kind as usize),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG,
                    100,
                    Some(&mut result),
                );
                if result != 0 {
                    icon = result;
                    break;
                }
            }
            if icon == 0 {
                icon = GetClassLongPtrW(hwnd, GCLP_HICON);
            }
            if icon == 0 {
                icon = GetClassLongPtrW(hwnd, GCLP_HICONSM);
            }
            if icon == 0 {
                return None;
            }
            const SIZE: u32 = 32;
            let screen_dc = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen_dc));
            let bitmap = CreateCompatibleBitmap(screen_dc, SIZE as i32, SIZE as i32);
            let previous = SelectObject(dc, bitmap.into());
            let drawn = DrawIconEx(
                dc,
                0,
                0,
                HICON(icon as *mut c_void),
                SIZE as i32,
                SIZE as i32,
                0,
                None,
                DI_NORMAL,
            )
            .is_ok();
            SelectObject(dc, previous);
            let pixels = if drawn {
                read_bitmap(dc, bitmap, SIZE, SIZE, false)
            } else {
                None
            };
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(dc);
            ReleaseDC(None, screen_dc);
            pixels
        }
    }
}

// --- macOS: CoreGraphics ----------------------------------------------------------------------

#[cfg(all(feature = "desktop-capturer", target_os = "macos"))]
mod platform {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    #[allow(deprecated)]
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGColorSpace, CGContext, CGDirectDisplayID, CGDisplayCreateImage,
        CGGetActiveDisplayList, CGImage, CGWindowImageOption, CGWindowListCopyWindowInfo,
        CGWindowListCreateImage, CGWindowListOption,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};

    pub fn sources(options: &Options, screens: &[Screen]) -> Result<Vec<Source>, String> {
        let mut out = Vec::new();
        if options.screens {
            let displays = active_displays();
            for screen in screens {
                let pixels = displays.get(screen.index).and_then(|&display| {
                    #[allow(deprecated)]
                    let image = CGDisplayCreateImage(display)?;
                    draw(&image, options)
                });
                out.push(screen_source(
                    screen,
                    screens.len(),
                    pixels.map(|p| png_base64(&p)).unwrap_or_default(),
                ));
            }
        }
        if options.windows {
            out.extend(windows(options));
        }
        Ok(out)
    }

    fn active_displays() -> Vec<CGDirectDisplayID> {
        let mut ids = [0 as CGDirectDisplayID; 16];
        let mut count = 0u32;
        let error = unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
        if error.0 != 0 {
            return Vec::new();
        }
        ids[..count as usize].to_vec()
    }

    fn number(dict: &NSDictionary<NSString, AnyObject>, key: &str) -> Option<i64> {
        let value = dict.objectForKey(&NSString::from_str(key))?;
        Some(value.downcast_ref::<NSNumber>()?.as_i64())
    }

    fn string(dict: &NSDictionary<NSString, AnyObject>, key: &str) -> Option<String> {
        let value = dict.objectForKey(&NSString::from_str(key))?;
        Some(value.downcast_ref::<NSString>()?.to_string())
    }

    fn windows(options: &Options) -> Vec<Source> {
        let Some(info) = CGWindowListCopyWindowInfo(
            CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
            0,
        ) else {
            return Vec::new();
        };
        // CFArray of CFDictionary, toll-free bridged to NSArray / NSDictionary.
        let raw = objc2_core_foundation::CFRetained::into_raw(info);
        let Some(list) = (unsafe {
            Retained::<NSArray<NSDictionary<NSString, AnyObject>>>::from_raw(raw.as_ptr().cast())
        }) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for dict in list.iter() {
            if number(&dict, "kCGWindowLayer") != Some(0) {
                continue;
            }
            let Some(id) = number(&dict, "kCGWindowNumber") else {
                continue;
            };
            let name = string(&dict, "kCGWindowName").filter(|n| !n.is_empty());
            let owner = string(&dict, "kCGWindowOwnerName");
            let Some(name) = name.or(owner) else {
                continue;
            };
            let thumbnail = (options.thumbnail_width > 0 && options.thumbnail_height > 0)
                .then(|| {
                    #[allow(deprecated)]
                    let image = CGWindowListCreateImage(
                        CGRect::new(CGPoint::new(f64::INFINITY, f64::INFINITY), CGSize::ZERO),
                        CGWindowListOption::OptionIncludingWindow,
                        id as u32,
                        CGWindowImageOption::BoundsIgnoreFraming
                            | CGWindowImageOption::NominalResolution,
                    )?;
                    draw(&image, options)
                })
                .flatten()
                .map(|p| png_base64(&p))
                .unwrap_or_default();
            out.push(Source {
                id: format!("window:{id}:0"),
                name,
                display_id: String::new(),
                thumbnail,
                // Application icons need NSRunningApplication: not fetched.
                app_icon: None,
            });
        }
        out
    }

    /// Draw `image` scaled to the thumbnail size into an RGBA bitmap.
    fn draw(image: &CGImage, options: &Options) -> Option<Pixels> {
        let (width, height) = (
            CGImage::width(Some(image)) as u32,
            CGImage::height(Some(image)) as u32,
        );
        let (w, h) = fit(
            width,
            height,
            options.thumbnail_width,
            options.thumbnail_height,
        )?;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        let space = CGColorSpace::new_device_rgb()?;
        // kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
        let info = 1 | (4 << 12);
        let context = unsafe {
            CGBitmapContextCreate(
                rgba.as_mut_ptr().cast(),
                w as usize,
                h as usize,
                8,
                (w * 4) as usize,
                Some(&space),
                info,
            )
        }?;
        CGContext::draw_image(
            Some(&context),
            CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64)),
            Some(image),
        );
        drop(context);
        for px in rgba.chunks_exact_mut(4) {
            let a = px[3] as u32;
            if a != 0 && a != 255 {
                for c in &mut px[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        Some(Pixels {
            width: w,
            height: h,
            rgba,
        })
    }
}

#[cfg(all(
    feature = "desktop-capturer",
    not(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd",
        windows,
        target_os = "macos"
    ))
))]
mod platform {
    use super::*;

    pub fn sources(_options: &Options, _screens: &[Screen]) -> Result<Vec<Source>, String> {
        Err("desktopCapturer is not available on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_keeping_the_aspect_ratio() {
        assert_eq!(fit(1920, 1080, 150, 150), Some((150, 84)));
        assert_eq!(fit(1080, 1920, 150, 150), Some((84, 150)));
        assert_eq!(fit(100, 50, 150, 150), Some((150, 75)));
        assert_eq!(fit(1920, 1080, 0, 0), None);
        assert_eq!(fit(0, 1080, 150, 150), None);
    }

    #[test]
    fn scales_by_averaging() {
        // 2 × 2 → 1 × 1: the average colour.
        let src = Pixels {
            width: 2,
            height: 2,
            rgba: vec![
                0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
            ],
        };
        let out = scale(&src, 1, 1);
        assert_eq!(out.rgba, vec![128, 128, 128, 255]);
        // 1 × 1 → 2 × 2: the same pixel.
        let one = Pixels {
            width: 1,
            height: 1,
            rgba: vec![1, 2, 3, 4],
        };
        assert_eq!(scale(&one, 2, 2).rgba, [1, 2, 3, 4].repeat(4));
    }

    #[test]
    fn names_screens_like_electron() {
        assert_eq!(screen_name(0, 1), "Entire Screen");
        assert_eq!(screen_name(1, 2), "Screen 2");
    }

    #[test]
    fn thumbnails_are_png() {
        let options = Options {
            thumbnail_width: 4,
            thumbnail_height: 4,
            ..Default::default()
        };
        let pixels = Pixels {
            width: 8,
            height: 2,
            rgba: vec![200; 64],
        };
        let png = BASE64.decode(thumbnail(Some(pixels), &options)).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(thumbnail(None, &options), "");
    }
}
