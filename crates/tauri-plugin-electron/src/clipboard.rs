//! What tauri-plugin-clipboard-manager does not read: HTML, and the
//! synchronous reads of Electron < 45 (`clipboard.readText()` & co. answered
//! over the synchronous bridge). Uses arboard, like that plugin.

use arboard::Clipboard;
use serde_json::{json, Value};

/// Text, HTML or image content of the clipboard, as the bridge returns it.
pub enum Answer {
    Json(Value),
    /// RGBA pixels after a little-endian `u32` width and height.
    Image(Vec<u8>),
}

fn clipboard() -> Result<Clipboard, String> {
    Clipboard::new().map_err(|e| e.to_string())
}

/// HTML on the clipboard, or an empty string.
pub fn read_html() -> Result<String, String> {
    Ok(clipboard()?.get().html().unwrap_or_default())
}

/// `op`: `readText`, `readHTML`, `readImage` or `formats`.
pub fn read(op: &str) -> Result<Answer, String> {
    let mut board = clipboard()?;
    match op {
        "readText" => Ok(Answer::Json(json!(board.get_text().unwrap_or_default()))),
        "readHTML" => Ok(Answer::Json(json!(board.get().html().unwrap_or_default()))),
        "readImage" => Ok(Answer::Image(match board.get_image() {
            Ok(image) => {
                let mut out = Vec::with_capacity(8 + image.bytes.len());
                out.extend_from_slice(&(image.width as u32).to_le_bytes());
                out.extend_from_slice(&(image.height as u32).to_le_bytes());
                out.extend_from_slice(&image.bytes);
                out
            }
            Err(_) => Vec::new(),
        })),
        "formats" => {
            let mut formats = Vec::new();
            if board.get_text().is_ok_and(|t| !t.is_empty()) {
                formats.push("text/plain");
            }
            if board.get().html().is_ok_and(|h| !h.is_empty()) {
                formats.push("text/html");
            }
            if board.get_image().is_ok() {
                formats.push("image/png");
            }
            Ok(Answer::Json(json!(formats)))
        }
        other => Err(format!("unknown clipboard read '{other}'")),
    }
}
