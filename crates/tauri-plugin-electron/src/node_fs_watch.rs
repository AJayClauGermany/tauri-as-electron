//! `fs.watch` / `fs.promises.watch` (feature `node-fs`) on the notify crate:
//! inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows.
//!
//! A watcher is created synchronously (over the bridge, so a missing path
//! throws from `fs.watch` as in Node and no event between `fs.watch()` and
//! the first listener is lost), then streams Node-shaped events over a Channel:
//! `{ "type": "change" | "rename", "filename": <relative path> }`, or
//! `{ "type": "error", "error": <NodeError> }`. As in Node, a watched file
//! reports its own name, a watched directory the path of the entry below it.

#![allow(clippy::result_large_err)]

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, LazyLock, Mutex,
    },
};

use notify::{
    event::{EventKind, ModifyKind},
    RecommendedWatcher, RecursiveMode, Watcher,
};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::node_common::NodeError;

/// Where a watcher's events go: kept until JavaScript attaches its Channel
/// (the watcher is created synchronously, over the bridge, as Node's is;
/// the Channel follows with a command), then sent as they come.
enum Sink {
    Buffer(Vec<Value>),
    Channel(Channel<Value>),
}

/// Events kept for a watcher nobody attached to.
const MAX_BUFFERED: usize = 10_000;

impl Sink {
    fn send(&mut self, event: Value) {
        match self {
            Sink::Buffer(events) if events.len() < MAX_BUFFERED => events.push(event),
            Sink::Buffer(_) => {}
            Sink::Channel(channel) => {
                let _ = channel.send(event);
            }
        }
    }
}

struct Entry {
    /// The webview that created it, and when (see `node_fs::owners`).
    owner: String,
    stamp: u64,
    _watcher: RecommendedWatcher,
    sink: Arc<Mutex<Sink>>,
}

static WATCHERS: LazyLock<Mutex<HashMap<u32, Entry>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn watch_error(error: notify::Error, path: &str) -> NodeError {
    let io = match error.kind {
        notify::ErrorKind::Io(io) => io,
        notify::ErrorKind::PathNotFound | notify::ErrorKind::WatchNotFound => {
            std::io::Error::from(std::io::ErrorKind::NotFound)
        }
        notify::ErrorKind::MaxFilesWatch => std::io::Error::other("ENOSPC: too many watched files"),
        other => std::io::Error::other(format!("{other:?}")),
    };
    NodeError::io(&io, "watch", Some(path), None)
}

/// The name Node reports for `changed`, relative to the watched `root`.
fn relative_name(root: &Path, root_is_dir: bool, changed: &Path) -> String {
    let name = if root_is_dir {
        changed
            .strip_prefix(root)
            .ok()
            .filter(|rest| !rest.as_os_str().is_empty())
            .map(Path::to_path_buf)
    } else {
        None
    };
    name.or_else(|| changed.file_name().map(PathBuf::from))
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// Node's two event types: `rename` for entries appearing and disappearing,
/// `change` for content and metadata. Reads are not reported.
fn event_type(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => Some("rename"),
        EventKind::Modify(ModifyKind::Name(_)) => Some("rename"),
        EventKind::Modify(_) | EventKind::Any | EventKind::Other => Some("change"),
        EventKind::Access(_) => None,
    }
}

/// Start watching `path` (bridge `node/fs/watch?a={ path, recursive }`):
/// `{ id }`. Events are kept until [`attach`].
pub fn watch(owner: &str, args: &Value) -> Result<Value, NodeError> {
    // Stamped when asked: a watch the previous page started belongs to it,
    // however long a recursive walk takes.
    let stamp = crate::node_fs::owners::stamp();
    let path = args["path"]
        .as_str()
        .ok_or_else(|| NodeError::invalid("path must be a string"))?
        .to_string();
    let recursive = args["recursive"].as_bool().unwrap_or(false);
    let root = PathBuf::from(&path);
    let metadata =
        std::fs::metadata(&root).map_err(|e| NodeError::io(&e, "watch", Some(&path), None))?;
    // Paths in events are absolute and canonical on some platforms (FSEvents).
    let canonical = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let root_is_dir = metadata.is_dir();
    let sink = Arc::new(Mutex::new(Sink::Buffer(Vec::new())));
    let events = sink.clone();
    let error_path = path.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let mut sink = events.lock().unwrap();
        match result {
            Ok(event) => {
                let Some(kind) = event_type(&event.kind) else {
                    return;
                };
                for changed in &event.paths {
                    let base = if changed.starts_with(&canonical) {
                        &canonical
                    } else {
                        &root
                    };
                    let filename = relative_name(base, root_is_dir, changed);
                    sink.send(json!({ "type": kind, "filename": filename }));
                }
            }
            Err(error) => {
                sink.send(json!({ "type": "error", "error": watch_error(error, &error_path) }))
            }
        }
    })
    .map_err(|e| watch_error(e, &path))?;
    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };
    watcher
        .watch(Path::new(&path), mode)
        .map_err(|e| watch_error(e, &path))?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut watchers = WATCHERS.lock().unwrap();
    watchers.insert(
        id,
        Entry {
            owner: owner.to_string(),
            stamp,
            _watcher: watcher,
            sink,
        },
    );
    Ok(json!({ "id": id }))
}

/// Send a watcher's events to `channel`, those kept so far first. False
/// when the watcher is gone.
pub fn attach(owner: &str, id: u32, channel: Channel<Value>) -> bool {
    let Some(sink) = WATCHERS
        .lock()
        .unwrap()
        .get(&id)
        .filter(|entry| entry.owner == owner)
        .map(|entry| entry.sink.clone())
    else {
        return false;
    };
    let mut sink = sink.lock().unwrap();
    if let Sink::Buffer(kept) = &mut *sink {
        for event in kept.drain(..) {
            let _ = channel.send(event);
        }
    }
    *sink = Sink::Channel(channel);
    true
}

/// `watcher.close()`. False when it was already closed.
pub fn unwatch(owner: &str, id: u32) -> bool {
    let mut watchers = WATCHERS.lock().unwrap();
    if watchers.get(&id).is_some_and(|entry| entry.owner == owner) {
        watchers.remove(&id);
        return true;
    }
    false
}

/// Stop the watchers `owner` created before `stamp` (a later page loaded,
/// or the window closed).
pub fn close_owned_before(owner: &str, stamp: u64) {
    WATCHERS
        .lock()
        .unwrap()
        .retain(|_, entry| entry.owner != owner || entry.stamp >= stamp);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_relative_to_a_directory_and_the_basename_of_a_file() {
        let dir = Path::new("/w/dir");
        assert_eq!(relative_name(dir, true, Path::new("/w/dir/a.txt")), "a.txt");
        assert_eq!(
            relative_name(dir, true, Path::new("/w/dir/sub/b.txt")),
            Path::new("sub").join("b.txt").to_string_lossy()
        );
        assert_eq!(relative_name(dir, true, Path::new("/w/dir")), "dir");
        assert_eq!(
            relative_name(Path::new("/w/f.txt"), false, Path::new("/w/f.txt")),
            "f.txt"
        );
    }

    #[test]
    fn kinds_map_to_node_event_types() {
        use notify::event::{AccessKind, CreateKind, DataChange, RenameMode};
        assert_eq!(
            event_type(&EventKind::Create(CreateKind::File)),
            Some("rename")
        );
        assert_eq!(
            event_type(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some("rename")
        );
        assert_eq!(
            event_type(&EventKind::Modify(ModifyKind::Data(DataChange::Content))),
            Some("change")
        );
        assert_eq!(event_type(&EventKind::Access(AccessKind::Read)), None);
    }
}
