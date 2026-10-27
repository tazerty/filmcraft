//! Evora fork (patch COR-FK-B1: COR-02 and COR-03; HOST-PROTOCOL §4.3, §4.5, §6, §7.2 to §7.4 in
//! Evora): what the app writes inside Evora.
//!
//! - **The project** Evora opened (`/evora/<docRef>/<name>`) goes to the shell as `evora:save`.
//!   With `doc.saved-ack` effective, it is saved when Evora says so: the engine marks a project
//!   saved when its bytes are handed over (`write_project`), so the next tick restores the saved
//!   revision it had, until `evora:saved {ok: true}` names this save; then the save's revision is
//!   the saved one, and a change made while the bytes travelled keeps the project modified
//!   (§4.5). `ok: false` (409, 413…) keeps it modified.
//! - **Save As** (File ▸ Save As…, the save dialog of `install_hooks` inside Evora) writes under
//!   [`SAVE_AS_DIR`]: the project goes to the shell as a new document (`evora:save {saveAs:
//!   true}`, §7.3). On `evora:saved {ok: true, docRef}` the engine adopts the new document
//!   (`/evora/<new docRef>/<name>`); refused, it goes back to the original one, still modified. A
//!   copy (File ▸ Save a Copy…) is sent the same way and adopts nothing.
//! - **Any other file** (exports, captions, interchange documents, embedded audio of an AAF import
//!   written by `write_file_new`) goes to Evora's Drive as `evora:export` (`export.drive`, §7.4);
//!   without the capability the write fails. Never a download.

use wasm_bindgen::JsValue;

use crate::ehp::{self, DOC_DIR, HostDoc, NOT_HERE, State, is_name, object};

/// Where Save As writes inside Evora: a project written here goes to the shell as a new document.
pub(crate) const SAVE_AS_DIR: &str = "/evora-save-as";

/// An `evora:save` awaiting its `evora:saved`.
pub(crate) struct SaveInFlight {
    pub id: String,
    /// The engine revision it carries: the saved revision the engine marked when the bytes were
    /// handed over, read at the next tick.
    pub revision: Option<u64>,
    /// `evora:saved` came: accepted or not (applied at the next tick).
    pub answer: Option<bool>,
    /// A Save As or a copy (`saveAs: true`).
    pub save_as: bool,
}

/// A Save As in flight.
pub(crate) struct SaveAs {
    pub id: String,
    pub name: String,
    /// The path the engine wrote (and, for Save As, adopted).
    pub temp_path: String,
    /// The engine took the new path (Save As) or kept its own (Save a Copy).
    pub adopted: Option<bool>,
    /// The answer: `Some(Some(docRef))` accepted, `Some(None)` refused.
    pub outcome: Option<Option<String>>,
}

/// The save dialog inside Evora: Save As (and Save a Copy) of the project, under the name the user
/// typed, become a new document of the shell. `None` (the dialog is cancelled) without
/// `doc.saved-ack`, which names the new document.
pub(crate) fn save_as_path(name: &str) -> Option<String> {
    if !ehp::has("doc.save") || !ehp::has("doc.saved-ack") {
        crate::post(|w, _| w.app.status("Save As is done from Evora's bar here"));
        return None;
    }
    let clean: String = name.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '_' } else { c }).collect();
    Some(format!("{SAVE_AS_DIR}/{clean}"))
}

/// The write hook's decision (called with the bridge's state borrowed).
pub(crate) fn on_write(st: &mut State, path: &str, data: &[u8]) -> Result<(), String> {
    if let Some(name) = path.strip_prefix(SAVE_AS_DIR).and_then(|r| r.strip_prefix('/')) {
        return write_save_as(st, path, name, data);
    }
    match st.doc.clone() {
        Some(doc) if path == doc.path => write_save(st, &doc, data),
        Some(doc) if is_schema_backup(path, &doc.path) => {
            // an upgraded project's schema backup is not kept (Drive keeps the versions)
            log::info!("{path}: not kept inside Evora (the shell keeps the versions)");
            Ok(())
        }
        _ => write_export(st, path, data),
    }
}

/// `<stem> (schema vN backup).fcproj`, the copy upstream writes before saving an upgraded project.
fn is_schema_backup(path: &str, doc_path: &str) -> bool {
    let stem = doc_path.strip_suffix(".fcproj").unwrap_or(doc_path);
    path.strip_prefix(stem).is_some_and(|rest| rest.starts_with(" (schema v") && rest.ends_with(" backup).fcproj"))
}

/// This write is the save: it answers the pending `evora:request-save`, if any.
fn write_save(st: &mut State, doc: &HostDoc, data: &[u8]) -> Result<(), String> {
    let re = ehp::take_save_re();
    if !st.has("doc.save") {
        ehp::refuse("capability");
        return Err("Evora is not ready to save yet".to_string());
    }
    if data.is_empty() || data.len() as f64 > st.limits.max_document {
        ehp::refuse("too_large");
        return Err("the project is too large to save in Evora".to_string());
    }
    let id = send_save(st, &doc.doc_ref, &doc.name, false, data, re.as_deref())?;
    st.saves.push(SaveInFlight { id, revision: None, answer: None, save_as: false });
    Ok(())
}

/// Save As (or a copy) of the project, named `name`, as a new document of the shell.
fn write_save_as(st: &mut State, path: &str, name: &str, data: &[u8]) -> Result<(), String> {
    let Some(doc) = st.doc.clone() else { return Err(NOT_HERE.to_string()) };
    if !st.has("doc.save") || !st.has("doc.saved-ack") || st.save_as.is_some() {
        return Err("Save As is not available inside Evora right now".to_string());
    }
    if !is_name(name) || !name.to_ascii_lowercase().ends_with(".fcproj") {
        return Err(NOT_HERE.to_string());
    }
    if data.is_empty() || data.len() as f64 > st.limits.max_document {
        return Err("the project is too large to save in Evora".to_string());
    }
    let id = send_save(st, &doc.doc_ref, name, true, data, None)?;
    st.saves.push(SaveInFlight { id: id.clone(), revision: None, answer: None, save_as: true });
    st.save_as = Some(SaveAs { id, name: name.to_string(), temp_path: path.to_string(), adopted: None, outcome: None });
    Ok(())
}

fn send_save(st: &State, doc_ref: &str, name: &str, save_as: bool, data: &[u8], re: Option<&str>) -> Result<String, String> {
    let buffer = js_sys::Uint8Array::from(data).buffer();
    let payload = object(&[("docRef", doc_ref.into()), ("name", name.into()), ("saveAs", save_as.into()), ("bytes", buffer.clone().into())])
        .ok_or_else(|| "couldn't build the message".to_string())?;
    ehp::send(st, "evora:save", re, &payload, Some(&buffer)).ok_or_else(|| "couldn't send the project to Evora".to_string())
}

/// Any other file: to Evora's Drive (`evora:export`), or a failed write.
fn write_export(st: &mut State, path: &str, data: &[u8]) -> Result<(), String> {
    if !st.has("export.drive") {
        return Err(NOT_HERE.to_string());
    }
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    if !is_name(&name) {
        return Err(NOT_HERE.to_string());
    }
    if data.is_empty() || data.len() as f64 > st.limits.max_export {
        return Err("the file is too large to send to Evora".to_string());
    }
    let buffer = js_sys::Uint8Array::from(data).buffer();
    let mut fields: Vec<(&str, JsValue)> = Vec::new();
    if let Some(doc) = &st.doc {
        fields.push(("docRef", doc.doc_ref.clone().into()));
    }
    fields.push(("name", name.clone().into()));
    fields.push(("mime", mime_for(&name).into()));
    fields.push(("bytes", buffer.clone().into()));
    let payload = object(&fields).ok_or_else(|| "couldn't build the message".to_string())?;
    // `ui.activity` (A-28): an export job may start and end within one frame, before any tick sees
    // it running; the activity is then announced here, before the file, and its end at the next tick
    if st.has("ui.activity")
        && st.last_busy != Some(true)
        && let Some(activity) = object(&[("busy", true.into()), ("kind", "export".into())])
        && ehp::send(st, "evora:activity", None, &activity, None).is_some()
    {
        st.last_busy = Some(true);
    }
    let id = ehp::send(st, "evora:export", None, &payload, Some(&buffer)).ok_or_else(|| "couldn't send the file to Evora".to_string())?;
    st.exports.push((id, name));
    Ok(())
}

/// The indicative type of an export (§4.4 `mime`); the server recomputes it from the bytes.
fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mxf" => "application/mxf",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "wav" | "wave" | "bwf" => "audio/wav",
        "aif" | "aiff" => "audio/aiff",
        "aac" | "m4a" => "audio/aac",
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "tif" | "tiff" => "image/tiff",
        "bmp" => "image/bmp",
        "srt" => "application/x-subrip",
        "vtt" => "text/vtt",
        "edl" | "txt" => "text/plain",
        "xml" | "fcpxml" | "ttml" | "dfxp" => "application/xml",
        "otio" | "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// `evora:saved` for `re` came (`ok`, and the new document of a Save As); `false` for no save of
/// this engine.
pub(crate) fn answered(st: &mut State, re: &str, ok: bool, new_ref: Option<String>) -> bool {
    let Some(save) = st.saves.iter_mut().find(|s| s.id == re && s.answer.is_none()) else { return false };
    save.answer = Some(ok);
    if let Some(sa) = st.save_as.as_mut().filter(|a| a.id == re) {
        sa.outcome = Some(if ok { new_ref } else { None });
    }
    true
}

/// At each tick: revisions of the saves handed over, Evora's answers, Save As adopted.
pub(crate) fn track(st: &mut State, session: &mut filmcraft_engine::Session) {
    let acked = st.has("doc.saved-ack");
    if let Some(sa) = st.save_as.as_mut()
        && sa.adopted.is_none()
    {
        sa.adopted = Some(session.path.as_deref() == Some(sa.temp_path.as_str()));
    }
    // 1. saves handed over since the last tick: the engine marked their revision saved; with
    //    doc.saved-ack the saved state waits for Evora's answer
    let mut handed = false;
    for s in st.saves.iter_mut().filter(|s| s.revision.is_none()) {
        s.revision = Some(session.saved_revision);
        handed = true;
    }
    if handed
        && acked
        && let Some(prev) = st.prev_saved
    {
        session.saved_revision = prev;
    }
    // 2. answers: an accepted save marks its revision saved (a copy marks nothing)
    let adopted_as = st.save_as.as_ref().filter(|a| a.adopted == Some(true)).map(|a| a.id.clone());
    let mut done = Vec::new();
    for (i, s) in st.saves.iter().enumerate() {
        let (Some(ok), Some(revision)) = (s.answer, s.revision) else { continue };
        done.push(i);
        let counts = !s.save_as || adopted_as.as_deref() == Some(s.id.as_str());
        if ok && counts && acked {
            session.saved_revision = revision;
        }
    }
    for i in done.into_iter().rev() {
        st.saves.remove(i);
    }
    adopt(st, session);
    st.prev_saved = Some(session.saved_revision);
}

/// Save As answered: the engine continues on the new document Evora named, or (refused) on the
/// original one.
fn adopt(st: &mut State, session: &mut filmcraft_engine::Session) {
    let ready = st.save_as.as_ref().is_some_and(|a| a.outcome.is_some() && a.adopted.is_some());
    if !ready {
        return;
    }
    let Some(sa) = st.save_as.take() else { return };
    if sa.adopted != Some(true) {
        return;
    }
    match sa.outcome.flatten() {
        Some(doc_ref) => {
            let path = format!("{DOC_DIR}/{doc_ref}/{}", sa.name);
            crate::fs::rename(&sa.temp_path, &path);
            session.path = Some(path.clone());
            st.doc = Some(HostDoc { doc_ref, name: sa.name, path });
            st.last_dirty = None;
        }
        None => {
            if let Some(doc) = &st.doc {
                session.path = Some(doc.path.clone());
            }
            crate::fs::remove(&sa.temp_path);
            st.last_dirty = None;
        }
    }
}
