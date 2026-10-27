//! Evora fork (patch COR-FK-B1: COR-04, COR-12, COR-15; HOST-PROTOCOL §7.5, §7.6 and amendment
//! A-28 in Evora): the media of a project come from Evora's Drive, through the shell.
//!
//! - **`evora:need`** (`media.need`): after an open, the media files the project names and the
//!   engine doesn't have go to the shell, in batches of at most `maxPathsPerNeed` paths. A path the
//!   schema refuses (§4.2 `path`: `/…`, at most 255 characters, no control character, no `..`
//!   segment) stays offline, as an unknown one does.
//! - **`evora:file`** answering a request: bytes become an in-memory file, a signed URL a remote
//!   entry read by range (`media.ranges`, [`crate::remote`]; its size from a first `bytes=0-0`),
//!   an error leaves the medium offline. Registering a file never modifies the project. Once the
//!   shell closes its answer (`evora:ack`) and every URL is probed, the media pool forgets what it
//!   marked offline: the files are read on next use. Nothing is copied to the browser's storage.
//! - A signed URL that **expired** (401, 403, 404, 410) is renewed by a new `evora:need` for its
//!   path alone; its reads wait meanwhile.
//! - **`evora:pick`** (`pick.drive`): File ▸ Import (and every import dialog), Link Media ▸
//!   Locate… and Open Project ask the shell's picker, never the browser's. Imported files are
//!   imported, a relink runs its command on the file, Open is the shell's (it navigates).
//! - **`evora:drop`** (`drop.files`): files dropped on the canvas go to the shell, which puts them
//!   in Drive first and answers as a picker does; they are then imported.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use filmcraft_ui_egui::RelinkHint;
use wasm_bindgen::{JsCast, JsValue};

use crate::ehp;

/// Longest virtual path the shell accepts: Evora's `creative_ehp_max_path_length` (D-15,
/// 2026-10-24).
const MAX_PATH_LENGTH: usize = 255;
/// Most `accept` items of an `evora:pick`: Evora's `creative_ehp_max_accept_items` (D-15).
const MAX_ACCEPT_ITEMS: usize = 32;
/// `error` values of `evora:file` (§4.3).
const FILE_ERRORS: [&str; 4] = ["not_found", "forbidden", "too_large", "unsupported"];

/// What a request asked the shell for.
enum Purpose {
    /// The media of an opened project (these paths only).
    Need(Vec<String>),
    /// Files to import (a picker).
    Import,
    /// One file to relink to, with the command to run on it.
    Relink(Option<RelinkHint>),
    /// A project to open: the shell navigates, nothing comes back.
    Open,
    /// Files dropped on the canvas.
    Drop,
}

struct Request {
    purpose: Purpose,
    /// Paths registered for it so far.
    files: Vec<String>,
    /// Signed URLs being probed.
    probing: usize,
    /// The shell's closing `evora:ack`: accepted or not.
    closed: Option<bool>,
}

thread_local! {
    static REQUESTS: RefCell<HashMap<String, Request>> = RefCell::new(HashMap::new());
    /// Paths whose expired URL is being renewed (one `evora:need` each).
    static RENEWING: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// §4.2 `path`, and no `..` segment.
pub fn is_virtual_path(p: &str) -> bool {
    p.starts_with('/') && p.chars().count() <= MAX_PATH_LENGTH && !p.chars().any(char::is_control) && !p.split('/').any(|s| s == "..")
}

fn remember(id: String, purpose: Purpose) {
    REQUESTS.with(|r| r.borrow_mut().insert(id, Request { purpose, files: Vec::new(), probing: 0, closed: None }));
}

/// The media files a project names, sorted, once each.
fn media_paths(session: &filmcraft_engine::Session) -> Vec<String> {
    use filmcraft_engine::project::MediaRef;
    let mut paths: Vec<String> = session
        .project
        .items
        .values()
        .filter_map(|item| item.as_media())
        .filter_map(|m| match &m.media {
            MediaRef::File { path } => Some(path.clone()),
            _ => None,
        })
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

/// After an open: ask the shell for every medium of the project the engine doesn't have.
pub fn need_missing(doc_ref: &str, session: &filmcraft_engine::Session) {
    if !ehp::has("media.need") {
        return;
    }
    let missing: Vec<String> = media_paths(session).into_iter().filter(|p| is_virtual_path(p) && !crate::fs::has(p)).collect();
    let batch = ehp::limits().max_paths_per_need.max(1);
    for paths in missing.chunks(batch) {
        need(doc_ref, paths.to_vec());
    }
}

/// `evora:need {docRef, paths}`.
fn need(doc_ref: &str, paths: Vec<String>) -> Option<String> {
    let list = js_sys::Array::new();
    for p in &paths {
        list.push(&JsValue::from_str(p));
    }
    let payload = ehp::object(&[("docRef", doc_ref.into()), ("paths", list.into())])?;
    let id = ehp::post_message("evora:need", None, &payload, None)?;
    remember(id.clone(), Purpose::Need(paths));
    Some(id)
}

/// The signed URL of the remote entry at `path` expired: ask for a new one, once per expiry.
pub fn renew(path: &str) {
    let Some(doc_ref) = ehp::current_doc_ref() else { return };
    if !ehp::has("media.need") || !RENEWING.with(|r| r.borrow_mut().insert(path.to_string())) {
        return;
    }
    if need(&doc_ref, vec![path.to_string()]).is_none() {
        RENEWING.with(|r| r.borrow_mut().remove(path));
    }
}

/// §4.4 `accept`: `.ext` for each extension, or, past [`MAX_ACCEPT_ITEMS`], the media families
/// (`video/*`, `audio/*`, `image/*`) and the other extensions.
fn accept_list(exts: &[&str]) -> Vec<String> {
    let mut clean: Vec<String> = Vec::new();
    for e in exts {
        let e = e.trim_start_matches('.').to_ascii_lowercase();
        if !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()) && !clean.contains(&e) {
            clean.push(e);
        }
    }
    if clean.len() <= MAX_ACCEPT_ITEMS {
        return clean.into_iter().map(|e| format!(".{e}")).collect();
    }
    let family = |e: &str| {
        if filmcraft_media::VIDEO_EXTENSIONS.contains(&e) {
            Some("video/*")
        } else if filmcraft_media::AUDIO_EXTENSIONS.contains(&e) {
            Some("audio/*")
        } else if filmcraft_media::STILL_EXTENSIONS.contains(&e) {
            Some("image/*")
        } else {
            None
        }
    };
    let mut out: Vec<String> = Vec::new();
    for e in &clean {
        let item = family(e.as_str()).map_or_else(|| format!(".{e}"), str::to_string);
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out.truncate(MAX_ACCEPT_ITEMS);
    out
}

/// Ask the shell's picker (`evora:pick`, §7.6). `false` when `pick.drive` is not effective: the
/// caller says so, and never falls back on the browser's picker.
pub fn pick(purpose: &'static str, exts: &[&str], multiple: bool, hint: Option<RelinkHint>) -> bool {
    if !ehp::has("pick.drive") {
        return false;
    }
    let accept = js_sys::Array::new();
    for a in accept_list(exts) {
        accept.push(&JsValue::from_str(&a));
    }
    let Some(payload) = ehp::object(&[("purpose", purpose.into()), ("accept", accept.into()), ("multiple", multiple.into())]) else { return false };
    let Some(id) = ehp::post_message("evora:pick", None, &payload, None) else { return false };
    let purpose = match purpose {
        "import" => Purpose::Import,
        "relink" => Purpose::Relink(hint),
        _ => Purpose::Open,
    };
    remember(id, purpose);
    true
}

/// Files dropped on the canvas (`evora:drop`, A-28). `false` when `drop.files` is not effective
/// or there are too many of them: the drop is then left alone inside Evora.
pub fn drop_files(files: Vec<web_sys::File>) -> bool {
    if !ehp::has("drop.files") || files.is_empty() || files.len() > ehp::limits().max_drop_files.max(1) {
        return false;
    }
    let list = js_sys::Array::new();
    for f in &files {
        list.push(f);
    }
    let Some(payload) = ehp::object(&[("purpose", "import".into()), ("files", list.into())]) else { return false };
    let Some(id) = ehp::post_message("evora:drop", None, &payload, None) else { return false };
    remember(id, Purpose::Drop);
    true
}

fn add_file(re: &str, path: String) {
    REQUESTS.with(|r| {
        if let Some(q) = r.borrow_mut().get_mut(re)
            && !q.files.contains(&path)
        {
            q.files.push(path);
        }
    });
}

/// `evora:file` answering a request of this module (`re`, §4.3).
pub fn on_file(re: &str, p: &JsValue) {
    if !ehp::only_keys(p, &["path", "name", "bytes", "url", "error"]) {
        return;
    }
    let Some(path) = ehp::get(p, "path").as_string().filter(|x| is_virtual_path(x)) else { return };
    let name = ehp::get(p, "name");
    if !name.is_undefined() && !name.as_string().is_some_and(|n| ehp::is_name(&n)) {
        return;
    }
    let (bytes, url, error) = (ehp::get(p, "bytes"), ehp::get(p, "url"), ehp::get(p, "error"));
    if [&bytes, &url, &error].iter().filter(|v| !v.is_undefined()).count() != 1 {
        return;
    }
    // the request it answers, still open, and whether this path may come with it
    let admitted = REQUESTS.with(|r| {
        r.borrow().get(re).is_some_and(|q| {
            q.closed.is_none()
                && match &q.purpose {
                    Purpose::Need(paths) => paths.contains(&path),
                    Purpose::Open => false,
                    _ => true,
                }
        })
    });
    if !admitted {
        return;
    }
    if !error.is_undefined() {
        if error.as_string().is_some_and(|e| FILE_ERRORS.contains(&e.as_str())) {
            log::info!("{path}: not available from Evora, the medium stays offline");
        }
        return;
    }
    if !bytes.is_undefined() {
        // An ArrayBuffer (never a SharedArrayBuffer or a typed view), within the inline bound.
        if !bytes.is_instance_of::<js_sys::ArrayBuffer>() {
            return;
        }
        let n = f64::from(bytes.unchecked_ref::<js_sys::ArrayBuffer>().byte_length());
        if n < 1.0 || n > ehp::limits().max_media {
            log::warn!("{path}: {n} bytes sent inline, refused");
            return;
        }
        crate::fs::put(&path, js_sys::Uint8Array::new(&bytes).to_vec());
        add_file(re, path);
        return;
    }
    let Some(url) = url.as_string().filter(|u| u.starts_with("https://") || u.starts_with("http://")) else { return };
    if !ehp::has("media.ranges") {
        return;
    }
    // a renewal: the same entry, its new URL
    if crate::fs::is_remote(&path) && crate::fs::renew_remote(&path, url.clone()) {
        add_file(re, path);
        return;
    }
    REQUESTS.with(|r| {
        if let Some(q) = r.borrow_mut().get_mut(re) {
            q.probing += 1;
        }
    });
    let re = re.to_string();
    wasm_bindgen_futures::spawn_local(async move {
        match crate::remote::get_range(&url, 0, 0).await {
            Ok(reply) => {
                crate::fs::register_remote(&path, url, reply.total);
                add_file(&re, path);
            }
            Err(crate::remote::RangeError::Expired) => log::warn!("{path}: the signed URL Evora sent is not valid"),
            Err(crate::remote::RangeError::Other(e)) => log::warn!("{path}: {e}"),
        }
        REQUESTS.with(|r| {
            if let Some(q) = r.borrow_mut().get_mut(&re) {
                q.probing = q.probing.saturating_sub(1);
            }
        });
        finish_if_ready(&re);
    });
}

/// `evora:ack` closing a request of this module; `false` when `re` is none of them.
pub fn on_ack(re: &str, ok: bool, code: Option<String>) -> bool {
    let known = REQUESTS.with(|r| {
        r.borrow_mut()
            .get_mut(re)
            .map(|q| {
                if q.closed.is_none() {
                    q.closed = Some(ok);
                }
            })
            .is_some()
    });
    if !known {
        return false;
    }
    if !ok {
        log::info!("Evora answered {}", code.unwrap_or_default());
    }
    finish_if_ready(re);
    true
}

/// A request is answered (closed by the shell, every URL probed): what came is used.
fn finish_if_ready(re: &str) {
    let done = REQUESTS.with(|r| {
        let mut r = r.borrow_mut();
        let ready = r.get(re).is_some_and(|q| q.closed.is_some() && q.probing == 0);
        if ready { r.remove(re) } else { None }
    });
    let Some(q) = done else { return };
    let accepted = q.closed == Some(true);
    match q.purpose {
        Purpose::Need(paths) => {
            RENEWING.with(|r| {
                let mut r = r.borrow_mut();
                for p in &paths {
                    r.remove(p);
                }
            });
            if !q.files.is_empty() {
                // the media pool forgets what it marked offline: the files are read on next use
                crate::post(|w, _| w.app.session.media.clear());
            }
        }
        Purpose::Import | Purpose::Drop => {
            // a project is opened by the shell, never imported
            let files: Vec<String> = q.files.into_iter().filter(|p| !p.to_ascii_lowercase().ends_with(".fcproj")).collect();
            if accepted && !files.is_empty() {
                wasm_bindgen_futures::spawn_local(async move {
                    let _ = crate::import::import_registered(files).await;
                });
            }
        }
        Purpose::Relink(hint) => {
            if accepted
                && let (Some(hint), Some(path)) = (hint, q.files.into_iter().next())
            {
                crate::import::relink_registered(path, hint);
            }
        }
        Purpose::Open => {}
    }
}
