//! Evora fork (patch E4): the native bridge of the Evora host protocol, EHP v1
//! (`apps/creative/HOST-PROTOCOL.md` in Evora), for `?host=evora`. It takes upstream's opt-in
//! embedding bridge (PR #930, `?host=parent`, same origin only) to EHP: the parent page is on
//! another origin, which the engine admits only if `evora-host.json` lists it.
//!
//! - **Parent origin** (§2.3): `evora-host.json`, next to `index.html`, lists the admitted parent
//!   origins (`{"parentOrigins": ["https://…"]}`, bare http(s) origins). Evora's provisioning writes
//!   it; the build ships it empty, and an empty or missing list keeps the bridge silent. Never from a
//!   URL parameter, a message or the referrer alone: `location.ancestorOrigins` names the parent when
//!   the browser gives it, and that origin must be admitted; otherwise the referrer may only choose
//!   among the admitted origins, or the single one.
//! - **Receiving** (§5.1, §5.2): `event.source` is the parent window AND `event.origin` the admitted
//!   origin; then a plain object, `v` = 1, a known type, a capability in the effective set, the exact
//!   envelope `{v, type, id, re, payload}`, ULIDs, the payload's schema, bytes as an `ArrayBuffer`
//!   (never a `SharedArrayBuffer` or a typed view) within `maxDocumentBytes`, `re` matching a request.
//!   Anything else is ignored, without an answer. An `id` already seen is ignored too.
//! - **Sending**: always to the admitted origin, never `*`; every `id` is a fresh ULID.
//! - **Messages**: `evora:ready` (once, before any storage access), `evora:init` (language through
//!   E3's mapping, theme and accent, storage namespace: other namespaces and upstream's leftovers
//!   purged first, §7.7 b), `evora:open` (bytes or a new project), `evora:save` (Save of the project
//!   Evora opened, and the answer to `evora:request-save`), `evora:saved` (checked; the engine does
//!   not declare `doc.saved-ack`, so the shell keeps its own save state, §6.3), `evora:dirty`,
//!   `evora:lang`, `evora:theme`, `evora:purge` (OPFS closed first, then erased, then the answer),
//!   `evora:ack`, and `evora:failed` when the engine cannot start.
//!
//! Not here (not declared): media of a project (`media.need`, `media.ranges`), exports to Drive
//! (`export.drive`), Drive's picker, host commands, `doc.saved-ack`. Inside Evora, a file the app
//! writes other than the project Evora opened is neither downloaded nor sent: the write fails and the
//! app says so.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;

use serde_json::json;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};

use crate::opfs;

/// Build slug and protocol version announced in `evora:ready` (§4.4, §10).
const APP: &str = "corte";
const EHP: &str = "1.0";
/// What this engine honours (§9.1), each exercised by the CI smoke test (scenario « pont-ehp »).
const CAPABILITIES: [&str; 8] = ["doc.open", "doc.save", "doc.dirty", "doc.request-save", "storage.ns", "storage.purge", "live.lang", "live.theme"];
/// The admitted parent origins, beside `index.html` (§2.3).
const CONFIG: &str = "evora-host.json";
/// Evora's languages (§4.2 `lang`).
const LANGS: [&str; 14] = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh-Hans"];
/// The capability vocabulary (§4.2 `capability`).
const CAPABILITY_NAMES: [&str; 18] = [
    "doc.open",
    "doc.save",
    "doc.saved-ack",
    "doc.dirty",
    "doc.multi",
    "doc.request-save",
    "export.drive",
    "media.need",
    "media.ranges",
    "pick.drive",
    "command",
    "storage.ns",
    "storage.memory",
    "storage.purge",
    "live.lang",
    "live.theme",
    "font.inject",
    "author",
];
/// `evora:request-save` reasons (§4.3).
const REASONS: [&str; 5] = ["autosave", "visibility", "close", "logout", "user"];
/// `ackCode` (§4.2).
const ACK_CODES: [&str; 16] = [
    "clean",
    "cancelled",
    "conflict",
    "too_large",
    "quota",
    "forbidden",
    "not_found",
    "invalid_content",
    "unsupported",
    "rate_limited",
    "read_only",
    "busy",
    "capability",
    "network",
    "server",
    "timeout",
];
/// Where the project Evora opened lives in the virtual file table: `/evora/<docRef>/<name>`.
const DOC_DIR: &str = "/evora";
/// What the app says when it writes a file inside Evora that is not the project Evora opened.
const NOT_HERE: &str = "not available inside Evora: only the project opened from Evora is saved, to Evora";

/// The project Evora opened.
#[derive(Clone)]
struct HostDoc {
    doc_ref: String,
    name: String,
    path: String,
}

struct State {
    parent: web_sys::Window,
    origin: String,
    ready_id: String,
    /// An `evora:init` was accepted (a second one is ignored).
    initialized: bool,
    /// The effective capabilities: what the shell offers and this engine declares (§9).
    caps: Vec<String>,
    max_document: f64,
    /// The account's storage namespace, when `storage.ns` is effective.
    storage_ns: Option<String>,
    doc: Option<HostDoc>,
    /// `id`s of the `evora:save` messages awaiting their `evora:saved`.
    pending_saves: Vec<String>,
    last_dirty: Option<bool>,
    /// Every `id` received (a replay is ignored, §3).
    seen: HashSet<String>,
}

impl State {
    fn has(&self, capability: &str) -> bool {
        self.initialized && self.caps.iter().any(|c| c == capability)
    }
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    /// The `id` of the `evora:request-save` that the save being written answers.
    static SAVE_RE: RefCell<Option<String>> = const { RefCell::new(None) };
    /// Why the save of the project Evora opened was refused (an `ackCode`).
    static REFUSAL: Cell<Option<&'static str>> = const { Cell::new(None) };
}

/// Read `evora-host.json`, find the admitted parent, listen, and announce `evora:ready`. Called once
/// the app runs: the requests it posts are carried out from the next frame on.
pub fn connect() {
    wasm_bindgen_futures::spawn_local(async {
        let Some((window, parent, origin)) = admitted_parent().await else {
            log::info!("Evora host bridge: no admitted parent page (evora-host.json); the bridge stays silent");
            crate::set_info("ehp", json!("silent"));
            return;
        };
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(|event: web_sys::MessageEvent| receive(&event));
        if window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).is_err() {
            return;
        }
        // The listener lives as long as the page.
        on_message.forget();
        let mut st = State {
            parent,
            origin,
            ready_id: String::new(),
            initialized: false,
            caps: Vec::new(),
            max_document: 0.0,
            storage_ns: None,
            doc: None,
            pending_saves: Vec::new(),
            last_dirty: None,
            seen: HashSet::new(),
        };
        let capabilities = js_sys::Array::new();
        for c in CAPABILITIES {
            capabilities.push(&JsValue::from_str(c));
        }
        let Some(payload) = object(&[
            ("app", APP.into()),
            ("version", env!("CARGO_PKG_VERSION").into()),
            ("ehp", EHP.into()),
            ("capabilities", capabilities.into()),
        ]) else {
            return;
        };
        // The answer comes in a later task, once the state below is in place.
        let Some(id) = send(&st, "evora:ready", None, &payload, None) else { return };
        st.ready_id = id;
        STATE.with(|s| *s.borrow_mut() = Some(st));
        crate::set_info("ehp", json!("ready"));
    });
}

/// The engine couldn't start: tell an admitted parent with `evora:failed {code}` (§4.4).
pub fn report_failure(code: &'static str) {
    wasm_bindgen_futures::spawn_local(async move {
        let Some((_, parent, origin)) = admitted_parent().await else { return };
        if let Some(payload) = object(&[("code", code.into())])
            && let Some((message, _)) = envelope("evora:failed", None, &payload)
        {
            let _ = parent.post_message(&message, &origin);
        }
    });
}

/// After each frame: `evora:dirty` when the project Evora opened gains or loses unsaved changes.
pub fn tick(session: &filmcraft_engine::Session) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(st) = s.as_mut() else { return };
        if !st.has("doc.dirty") {
            return;
        }
        let Some(doc_ref) = st.doc.as_ref().filter(|d| session.path.as_deref() == Some(d.path.as_str())).map(|d| d.doc_ref.clone()) else { return };
        let dirty = session.is_dirty();
        if st.last_dirty == Some(dirty) {
            return;
        }
        if let Some(payload) = object(&[("dirty", dirty.into()), ("docRef", doc_ref.into())])
            && send(st, "evora:dirty", None, &payload, None).is_some()
        {
            st.last_dirty = Some(dirty);
        }
    });
}

/// The file-write hook inside Evora (`fs::set_on_write`): the project Evora opened goes to the shell
/// as `evora:save`; an upgraded project's schema backup is not kept (Drive keeps versions); anything
/// else fails, never a download.
pub fn on_write(path: &str, data: &[u8]) -> Result<(), String> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(st) = s.as_mut() else { return Err("Evora is not connected".to_string()) };
        let Some(doc) = st.doc.clone() else { return Err(NOT_HERE.to_string()) };
        if path != doc.path {
            if is_schema_backup(path, &doc.path) {
                log::info!("{path}: not kept inside Evora (the shell keeps the versions)");
                return Ok(());
            }
            return Err(NOT_HERE.to_string());
        }
        // This write is the save: it answers the pending `evora:request-save`, if any.
        let re = SAVE_RE.with(|r| r.borrow_mut().take());
        if !st.has("doc.save") {
            REFUSAL.set(Some("capability"));
            return Err("Evora is not ready to save yet".to_string());
        }
        if data.is_empty() || data.len() as f64 > st.max_document {
            REFUSAL.set(Some("too_large"));
            return Err("the project is too large to save in Evora".to_string());
        }
        let buffer = js_sys::Uint8Array::from(data).buffer();
        let payload = object(&[
            ("docRef", doc.doc_ref.into()),
            ("name", doc.name.into()),
            ("saveAs", false.into()),
            ("bytes", buffer.clone().into()),
        ])
        .ok_or_else(|| "couldn't build the message".to_string())?;
        let id = send(st, "evora:save", re.as_deref(), &payload, Some(&buffer)).ok_or_else(|| "couldn't send the project to Evora".to_string())?;
        st.pending_saves.push(id);
        Ok(())
    })
}

/// `<stem> (schema vN backup).fcproj`, the copy upstream writes before saving an upgraded project.
fn is_schema_backup(path: &str, doc_path: &str) -> bool {
    let stem = doc_path.strip_suffix(".fcproj").unwrap_or(doc_path);
    path.strip_prefix(stem).is_some_and(|rest| rest.starts_with(" (schema v") && rest.ends_with(" backup).fcproj"))
}

/// The parent window and its origin, when the page is framed by an origin `evora-host.json` admits.
async fn admitted_parent() -> Option<(web_sys::Window, web_sys::Window, String)> {
    let window = web_sys::window()?;
    let parent = window.parent().ok().flatten()?;
    if js_sys::Object::is(&parent, &window) {
        return None;
    }
    let admitted = read_config(&window).await?;
    // `location.ancestorOrigins` (a DOMStringList; absent from web-sys and from some browsers).
    let location: JsValue = window.location().into();
    let ancestors = get(&location, "ancestorOrigins");
    let first_ancestor = (get(&ancestors, "length").as_f64().unwrap_or(0.0) >= 1.0)
        .then(|| js_sys::Reflect::get_u32(&ancestors, 0).ok().and_then(|o| o.as_string()))
        .flatten();
    let origin = match first_ancestor {
        Some(parent_origin) => Some(parent_origin).filter(|o| admitted.contains(o))?,
        None => {
            let referrer = window.document().map(|d| d.referrer()).unwrap_or_default();
            let from_referrer = web_sys::Url::new(&referrer).ok().map(|u| u.origin()).filter(|o| admitted.contains(o));
            match (from_referrer, admitted.as_slice()) {
                (Some(o), _) => o,
                (None, [only]) => only.clone(),
                _ => return None,
            }
        }
    };
    Some((window, parent, origin))
}

/// `evora-host.json`: `{ "parentOrigins": ["https://…", …] }`, each a bare web origin.
async fn read_config(window: &web_sys::Window) -> Option<Vec<String>> {
    let response = wasm_bindgen_futures::JsFuture::from(window.fetch_with_str(CONFIG)).await.ok()?;
    let response: web_sys::Response = response.dyn_into().ok()?;
    if !response.ok() {
        return None;
    }
    let text = wasm_bindgen_futures::JsFuture::from(response.text().ok()?).await.ok()?.as_string()?;
    let config = js_sys::JSON::parse(&text).ok()?;
    let list = get(&config, "parentOrigins");
    if !js_sys::Array::is_array(&list) {
        return None;
    }
    let origins: Vec<String> = js_sys::Array::from(&list).iter().filter_map(|o| o.as_string()).filter(|o| is_origin(o)).collect();
    (!origins.is_empty()).then_some(origins)
}

/// `http(s)://host[:port]`, nothing after.
fn is_origin(o: &str) -> bool {
    let rest = o.strip_prefix("https://").or_else(|| o.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty() && !r.contains(['/', '?', '#', '@', ' ', '\\']))
}

fn receive(event: &web_sys::MessageEvent) {
    // §5.1: source AND origin.
    let heard = STATE.with(|s| {
        s.borrow().as_ref().is_some_and(|st| event.origin() == st.origin && event.source().is_some_and(|src| js_sys::Object::is(&src, &st.parent)))
    });
    if !heard {
        return;
    }
    // §5.2: a plain object, version 1, a known type, an effective capability, the exact envelope.
    let data = event.data();
    if !plain_object(&data) || get(&data, "v").as_f64() != Some(1.0) {
        return;
    }
    let Some(kind) = get(&data, "type").as_string() else { return };
    let capability = match kind.as_str() {
        "evora:init" => None,
        "evora:open" => Some("doc.open"),
        "evora:saved" => Some("doc.save"),
        "evora:request-save" => Some("doc.request-save"),
        "evora:lang" => Some("live.lang"),
        "evora:theme" => Some("live.theme"),
        "evora:purge" => Some("storage.purge"),
        // Unknown here, or a capability this engine doesn't declare: ignored (§4.1, §10).
        _ => return,
    };
    if let Some(c) = capability
        && !STATE.with(|s| s.borrow().as_ref().is_some_and(|st| st.has(c)))
    {
        return;
    }
    if !only_keys(&data, &["v", "type", "id", "re", "payload"]) {
        return;
    }
    let Some(id) = get(&data, "id").as_string().filter(|i| is_ulid(i)) else { return };
    let re = get(&data, "re");
    let re = if re.is_undefined() {
        None
    } else {
        match re.as_string().filter(|r| is_ulid(r)) {
            Some(r) => Some(r),
            None => return,
        }
    };
    let payload = get(&data, "payload");
    if !plain_object(&payload) {
        return;
    }
    // Only answers carry `re` (§3, §4.5).
    let answer = matches!(kind.as_str(), "evora:init" | "evora:saved");
    if answer != re.is_some() {
        return;
    }
    if !STATE.with(|s| s.borrow_mut().as_mut().is_some_and(|st| st.seen.insert(id.clone()))) {
        return;
    }
    match kind.as_str() {
        "evora:init" => on_init(id, re.as_deref(), &payload),
        "evora:open" => on_open(id, &payload),
        "evora:saved" => on_saved(re.as_deref(), &payload),
        "evora:request-save" => on_request_save(id, &payload),
        "evora:lang" => on_lang(id, &payload),
        "evora:theme" => on_theme(id, &payload),
        "evora:purge" => on_purge(id, &payload),
        _ => {}
    }
}

/// `engineLang`: `null` (the engine lacks Evora's language: English) or the engine's code, mapped by
/// patch E3; `None` when malformed.
fn engine_language(v: &JsValue) -> Option<&'static str> {
    if v.is_null() {
        return Some("en");
    }
    let tag = v.as_string().filter(|l| is_lang_tag(l))?;
    Some(filmcraft_ui_egui::i18n::Language::from_evora(&tag).map_or("en", |l| l.code()))
}

fn is_accent(v: &JsValue) -> Option<String> {
    v.as_string().filter(|a| a.len() == 7 && a.starts_with('#') && a.chars().skip(1).all(|c| c.is_ascii_hexdigit())).map(|a| a.to_ascii_lowercase())
}

fn is_theme(v: &JsValue) -> Option<&'static str> {
    match v.as_string().as_deref() {
        Some("light") => Some("light"),
        Some("dark") => Some("dark"),
        _ => None,
    }
}

fn is_lang(v: &JsValue) -> bool {
    v.as_string().is_some_and(|l| LANGS.contains(&l.as_str()))
}

/// What `evora:init` asks, once its payload passed the schema of §4.3.
struct Init {
    language: &'static str,
    theme: &'static str,
    accent: String,
    storage_ns: String,
    caps: Vec<String>,
    max_document: f64,
}

fn parse_init(p: &JsValue) -> Option<Init> {
    let required = ["lang", "engineLang", "theme", "accent", "readOnly", "storageNs", "capabilities", "prefs", "limits"];
    let mut allowed = required.to_vec();
    allowed.push("displayName");
    if !only_keys(p, &allowed) || !required.iter().all(|k| !get(p, k).is_undefined()) || !is_lang(&get(p, "lang")) {
        return None;
    }
    let language = engine_language(&get(p, "engineLang"))?;
    let theme = is_theme(&get(p, "theme"))?;
    let accent = is_accent(&get(p, "accent"))?;
    get(p, "readOnly").as_bool()?;
    let storage_ns = get(p, "storageNs").as_string().filter(|ns| opfs::valid_namespace(ns))?;
    let name = get(p, "displayName");
    if !name.is_undefined() && !name.as_string().is_some_and(|n| (1..=100).contains(&n.chars().count())) {
        return None;
    }
    let caps = string_list(&get(p, "capabilities")).filter(|c| c.iter().all(|x| CAPABILITY_NAMES.contains(&x.as_str())))?;
    let prefs = get(p, "prefs");
    if !plain_object(&prefs) {
        return None;
    }
    let pref_values = js_sys::Object::values(prefs.unchecked_ref::<js_sys::Object>());
    if !pref_values.iter().all(|v| v.as_string().is_some() || v.as_f64().is_some() || v.as_bool().is_some()) {
        return None;
    }
    let limits = get(p, "limits");
    let whole = |v: Option<f64>| v.filter(|m| *m >= 1.0 && m.fract() == 0.0);
    let max_document = whole(get(&limits, "maxDocumentBytes").as_f64())?;
    whole(get(&limits, "maxExportBytes").as_f64())?;
    if !plain_object(&limits) || !only_keys(&limits, &["maxDocumentBytes", "maxExportBytes"]) {
        return None;
    }
    Some(Init { language, theme, accent, storage_ns, caps, max_document })
}

/// `evora:init`: language, theme and accent applied; the storage namespace opened once the other
/// namespaces and upstream's leftovers are purged (§7.1 step 6, §7.7 b); then the answer.
fn on_init(id: String, re: Option<&str>, p: &JsValue) {
    let expected = STATE.with(|s| s.borrow().as_ref().is_some_and(|st| !st.initialized && re == Some(st.ready_id.as_str())));
    if !expected {
        return;
    }
    let Some(init) = parse_init(p) else { return };
    let caps: Vec<String> = init.caps.into_iter().filter(|c| CAPABILITIES.contains(&c.as_str())).collect();
    let (purge, namespace) = (caps.iter().any(|c| c == "storage.purge"), caps.iter().any(|c| c == "storage.ns"));
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            st.initialized = true;
            st.caps = caps;
            st.max_document = init.max_document;
            st.storage_ns = namespace.then(|| init.storage_ns.clone());
        }
    });
    let values = json!({
        "general.interfaceLanguage": init.language,
        "appearance.appearanceMode": init.theme,
        "appearance.highlightColor": init.accent,
    });
    let ns = init.storage_ns;
    wasm_bindgen_futures::spawn_local(async move {
        set_prefs(values).await;
        let mut ok = true;
        if purge && let Err(e) = opfs::purge(opfs::Purge::Others(ns.clone())).await {
            log::warn!("Evora storage purge at start-up: {e:?}");
            ok = false;
        }
        // the namespace directory is created here, once; refused (sealed by an evora:purge meanwhile,
        // or not creatable): busy, OPFS stays closed
        if ok && namespace && !opfs::open_namespace(&ns).await {
            ok = false;
        }
        crate::set_info("storage", json!(opfs::describe()));
        crate::set_info("opfs", json!(opfs::available()));
        ack(&id, ok, (!ok).then_some("busy"));
    });
}

/// Apply preferences on the UI thread (they take effect at the next frame, `apply_prefs`).
async fn set_prefs(values: serde_json::Value) {
    crate::import::on_ui(move |w, _| {
        if let Err(e) = w.app.session.execute("prefs.set", json!({ "values": values })) {
            log::warn!("Evora preferences: {e}");
        }
    })
    .await;
}

/// `evora:open`: a project in bytes (opened at `/evora/<docRef>/<name>`) or a new one.
fn on_open(id: String, p: &JsValue) {
    if !only_keys(p, &["docRef", "name", "bytes", "url", "new"]) {
        return;
    }
    let Some(doc_ref) = get(p, "docRef").as_string().filter(|r| is_ulid(r)) else { return };
    let Some(name) = get(p, "name").as_string().filter(|n| is_name(n)) else { return };
    let (bytes, url, new) = (get(p, "bytes"), get(p, "url"), get(p, "new"));
    if [&bytes, &url, &new].iter().filter(|v| !v.is_undefined()).count() != 1 {
        return;
    }
    if !url.is_undefined() {
        // A signed URL needs `media.ranges`, which this engine doesn't declare.
        if url.as_string().is_some() {
            ack(&id, false, Some("capability"));
        }
        return;
    }
    let doc = HostDoc { path: format!("{DOC_DIR}/{doc_ref}/{name}"), doc_ref, name };
    if !new.is_undefined() {
        if new.as_bool() != Some(true) {
            return;
        }
        crate::post(move |w, _| {
            let stem = doc.name.strip_suffix(".fcproj").unwrap_or(&doc.name).to_string();
            match w.app.session.execute("file.newProject", json!({ "name": stem })) {
                Ok(_) => {
                    // nothing to save yet: the new project is the host's document
                    w.app.session.path = Some(doc.path.clone());
                    w.app.session.saved_revision = w.app.session.revision;
                    opened(&id, doc, &w.app.session);
                }
                Err(e) => {
                    log::warn!("new project from Evora: {e}");
                    ack(&id, false, Some("unsupported"));
                }
            }
        });
        return;
    }
    // An ArrayBuffer (never a SharedArrayBuffer or a typed view), 1 byte up to the limit.
    if !bytes.is_instance_of::<js_sys::ArrayBuffer>() {
        return;
    }
    let length = f64::from(bytes.unchecked_ref::<js_sys::ArrayBuffer>().byte_length());
    if length < 1.0 {
        return;
    }
    if STATE.with(|s| s.borrow().as_ref().is_none_or(|st| length > st.max_document)) {
        ack(&id, false, Some("too_large"));
        return;
    }
    let data = js_sys::Uint8Array::new(&bytes).to_vec();
    crate::post(move |w, _| {
        crate::fs::put(&doc.path, data);
        match w.app.session.execute("file.open", json!({ "path": doc.path.clone() })) {
            Ok(_) => opened(&id, doc, &w.app.session),
            Err(e) => {
                log::warn!("project from Evora: {e}");
                ack(&id, false, Some("invalid_content"));
            }
        }
    });
}

/// The project is open: remember it, answer, then report its state (§7.1 step 8).
fn opened(id: &str, doc: HostDoc, session: &filmcraft_engine::Session) {
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            st.doc = Some(doc);
            st.last_dirty = None;
        }
    });
    ack(id, true, None);
    tick(session);
}

/// `evora:saved`: checked against the save it answers. Without `doc.saved-ack` the engine keeps
/// upstream's behaviour (saved once handed over) and the shell shows its own save state (§6.3).
fn on_saved(re: Option<&str>, p: &JsValue) {
    let Some(re) = re else { return };
    if !only_keys(p, &["ok", "version", "docRef", "error"]) {
        return;
    }
    let (version, doc_ref, error) = (get(p, "version"), get(p, "docRef"), get(p, "error"));
    let valid = match get(p, "ok").as_bool() {
        Some(true) => {
            version.as_f64().is_some_and(|v| v >= 1.0 && v.fract() == 0.0)
                && error.is_undefined()
                && (doc_ref.is_undefined() || doc_ref.as_string().is_some_and(|r| is_ulid(&r)))
        }
        Some(false) => error.as_string().is_some_and(|e| ACK_CODES.contains(&e.as_str())) && version.is_undefined() && doc_ref.is_undefined(),
        None => false,
    };
    if !valid {
        return;
    }
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            st.pending_saves.retain(|id| id != re);
        }
    });
}

/// `evora:request-save`: `evora:save` (with `re`) when the project Evora opened has unsaved
/// changes, `evora:ack {code: "clean"}` when it has none.
fn on_request_save(id: String, p: &JsValue) {
    if !only_keys(p, &["reason", "docRef"]) || !get(p, "reason").as_string().is_some_and(|r| REASONS.contains(&r.as_str())) {
        return;
    }
    let asked = get(p, "docRef");
    let asked = if asked.is_undefined() {
        None
    } else {
        match asked.as_string().filter(|r| is_ulid(r)) {
            Some(r) => Some(r),
            None => return,
        }
    };
    crate::post(move |w, _| {
        let doc = STATE.with(|s| s.borrow().as_ref().and_then(|st| st.doc.clone()));
        let Some(doc) = doc.filter(|d| w.app.session.path.as_deref() == Some(d.path.as_str()) && asked.as_ref().is_none_or(|a| a == &d.doc_ref)) else {
            ack(&id, false, Some("not_found"));
            return;
        };
        if !w.app.session.is_dirty() {
            ack(&id, true, Some("clean"));
            return;
        }
        SAVE_RE.with(|r| *r.borrow_mut() = Some(id.clone()));
        REFUSAL.set(None);
        let saved = w.app.session.execute("file.save", json!({}));
        // still there: the save never reached the project's path
        let unanswered = SAVE_RE.with(|r| r.borrow_mut().take()).is_some();
        if saved.is_err() || unanswered {
            if let Err(e) = saved {
                log::warn!("save of {} for Evora: {e}", doc.name);
            }
            ack(&id, false, Some(REFUSAL.take().unwrap_or("busy")));
        }
    });
}

/// `evora:lang`: the interface language, through patch E3's mapping.
fn on_lang(id: String, p: &JsValue) {
    if !only_keys(p, &["lang", "engineLang"]) || !is_lang(&get(p, "lang")) || get(p, "engineLang").is_undefined() {
        return;
    }
    let Some(language) = engine_language(&get(p, "engineLang")) else { return };
    wasm_bindgen_futures::spawn_local(async move {
        set_prefs(json!({ "general.interfaceLanguage": language })).await;
        ack(&id, true, None);
    });
}

/// `evora:theme`: light or dark, and the accent.
fn on_theme(id: String, p: &JsValue) {
    if !only_keys(p, &["theme", "accent"]) {
        return;
    }
    let (Some(theme), Some(accent)) = (is_theme(&get(p, "theme")), is_accent(&get(p, "accent"))) else { return };
    wasm_bindgen_futures::spawn_local(async move {
        set_prefs(json!({ "appearance.appearanceMode": theme, "appearance.highlightColor": accent })).await;
        ack(&id, true, None);
    });
}

/// `evora:purge` (§7.7): OPFS is closed for good first (no write queued, reopened or created any
/// more), the writes under way end, then the storage is erased and checked; the answer comes last.
fn on_purge(id: String, p: &JsValue) {
    if !only_keys(p, &["scope"]) {
        return;
    }
    let all = match get(p, "scope").as_string().as_deref() {
        Some("all") => true,
        Some("current") => false,
        _ => return,
    };
    opfs::seal();
    crate::set_info("storage", json!(opfs::describe()));
    crate::set_info("opfs", json!(false));
    let current = STATE.with(|s| s.borrow().as_ref().and_then(|st| st.storage_ns.clone()));
    let what = if all { opfs::Purge::All } else { opfs::Purge::Current(current) };
    wasm_bindgen_futures::spawn_local(async move {
        let r = opfs::purge(what).await;
        if let Err(e) = &r {
            log::warn!("Evora storage purge: {e:?}");
        }
        ack(&id, r.is_ok(), r.is_err().then_some("busy"));
    });
}

fn ack(re: &str, ok: bool, code: Option<&str>) {
    let mut fields: Vec<(&str, JsValue)> = vec![("ok", ok.into())];
    if let Some(code) = code {
        fields.push(("code", code.into()));
    }
    if let Some(payload) = object(&fields) {
        STATE.with(|s| {
            if let Some(st) = s.borrow().as_ref() {
                let _ = send(st, "evora:ack", Some(re), &payload, None);
            }
        });
    }
}

/// Post a message to the admitted parent origin; returns its `id`.
fn send(st: &State, kind: &str, re: Option<&str>, payload: &js_sys::Object, transfer: Option<&JsValue>) -> Option<String> {
    let (message, id) = envelope(kind, re, payload)?;
    let sent = match transfer {
        Some(t) => st.parent.post_message_with_transfer(&message, &st.origin, &js_sys::Array::of1(t)),
        None => st.parent.post_message(&message, &st.origin),
    };
    sent.ok().map(|()| id)
}

fn envelope(kind: &str, re: Option<&str>, payload: &js_sys::Object) -> Option<(js_sys::Object, String)> {
    let id = ulid();
    let mut fields: Vec<(&str, JsValue)> = vec![("v", 1.0.into()), ("type", kind.into()), ("id", id.clone().into())];
    if let Some(re) = re {
        fields.push(("re", re.into()));
    }
    fields.push(("payload", payload.clone().into()));
    Some((object(&fields)?, id))
}

fn object(fields: &[(&str, JsValue)]) -> Option<js_sys::Object> {
    let m = js_sys::Object::new();
    for (key, value) in fields {
        js_sys::Reflect::set(&m, &JsValue::from_str(key), value).ok()?;
    }
    Some(m)
}

fn get(data: &JsValue, key: &str) -> JsValue {
    if !data.is_object() {
        return JsValue::UNDEFINED;
    }
    js_sys::Reflect::get(data, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}

/// A plain object: not null, not an array, prototype `Object.prototype` (§5.2 step 2).
fn plain_object(v: &JsValue) -> bool {
    if !v.is_object() || js_sys::Array::is_array(v) {
        return false;
    }
    let plain = js_sys::Object::get_prototype_of(&js_sys::Object::new().into());
    js_sys::Object::is(&js_sys::Object::get_prototype_of(v), &plain)
}

/// No property outside `allowed` (`additionalProperties: false`).
fn only_keys(v: &JsValue, allowed: &[&str]) -> bool {
    if !v.is_object() {
        return false;
    }
    js_sys::Object::keys(v.unchecked_ref::<js_sys::Object>()).iter().all(|k| k.as_string().is_some_and(|k| allowed.contains(&k.as_str())))
}

/// An array of distinct strings.
fn string_list(v: &JsValue) -> Option<Vec<String>> {
    if !js_sys::Array::is_array(v) {
        return None;
    }
    let list: Vec<String> = js_sys::Array::from(v).iter().map(|x| x.as_string()).collect::<Option<Vec<_>>>()?;
    let mut unique = list.clone();
    unique.sort();
    unique.dedup();
    (unique.len() == list.len()).then_some(list)
}

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn is_ulid(s: &str) -> bool {
    s.len() == 26 && s.bytes().all(|b| CROCKFORD.contains(&b))
}

/// A fresh ULID: 48 bits of milliseconds, then 80 random bits (§3: unique per sender).
fn ulid() -> String {
    let mut time = js_sys::Date::now() as u64;
    let mut out = [b'0'; 26];
    for slot in out.iter_mut().take(10).rev() {
        *slot = CROCKFORD[(time % 32) as usize];
        time /= 32;
    }
    for slot in out.iter_mut().skip(10) {
        *slot = CROCKFORD[((js_sys::Math::random() * 32.0) as usize) % 32];
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `name` of §4.2: 1 to 255 characters, no `/`, `\` or control character.
fn is_name(n: &str) -> bool {
    (1..=255).contains(&n.chars().count()) && !n.chars().any(|c| c == '/' || c == '\\' || c.is_control())
}

/// `engineLang` of §4.2: `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$`.
fn is_lang_tag(tag: &str) -> bool {
    let mut parts = tag.split(['-', '_']);
    let first_ok = parts.next().is_some_and(|p| (2..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphabetic()));
    first_ok && parts.all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}
