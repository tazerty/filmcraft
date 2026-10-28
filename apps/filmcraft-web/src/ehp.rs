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
//!   purged first, §7.7 b), `evora:open` (bytes, a signed URL with `media.ranges`, or a new project),
//!   `evora:save` (Save of the project Evora opened, the answer to `evora:request-save`, and Save As
//!   as a new document), `evora:saved`, `evora:dirty`, `evora:lang`, `evora:theme`, `evora:purge`
//!   (OPFS closed first, then erased, then the answer), `evora:ack`, and `evora:failed` when the
//!   engine cannot start or stops for good: a panic (`{code: "panic"}`, from the panic hook, before
//!   the wasm traps) or an abort without one, such as running out of memory (`{code: "memory"}`,
//!   from `index.html`, to the origin admitted here).
//!
//! Patch COR-FK-B1 (Evora campaign « suite créative V1 », 2026-10-27) adds the V1 bridge:
//! - `doc.saved-ack` (COR-02, `ehp_save`): the project is saved when Evora says so, not when its
//!   bytes are handed over; a change made while they travel keeps it modified; a refusal (409,
//!   413…) keeps it modified; Save As adopts the new document Evora names (§7.3);
//! - `export.drive` (COR-03, `ehp_save`): any other file the app writes goes to Evora's Drive
//!   (`evora:export`), never to a download; without the capability the write fails;
//! - `command` and `command.catalog` (COR-10, DT-S17, `ehp_commands`);
//! - `media.need`, `media.ranges`, `pick.drive`, `drop.files` (COR-04, COR-12, COR-15,
//!   `ehp_media`, `remote`);
//! - `ui.focus-out` (A-19, `ehp_focus`) and `ui.activity` (A-28: `evora:activity` while an export
//!   job runs).

use std::cell::{Cell, RefCell};
use std::collections::HashSet;

use serde_json::json;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};

pub(crate) use crate::ehp_wire::{get, is_name, is_ulid, object, only_keys, plain_object};
use crate::ehp_wire::{envelope, is_lang_tag, string_list};
use crate::opfs;

/// Build slug and protocol version announced in `evora:ready` (§4.4, §10).
const APP: &str = "corte";
const EHP: &str = "1.0";
/// What this engine honours (§9.1; A-19, A-28 and DT-S17 of the 1.1 amendments, which a shell of
/// minor 0 admits at its ceiling), each exercised by the CI smoke test (scenarios « pont-ehp » and
/// « pont-v1 »).
const CAPABILITIES: [&str; 18] = [
    "doc.open",
    "doc.save",
    "doc.saved-ack",
    "doc.dirty",
    "doc.request-save",
    "export.drive",
    "media.need",
    "media.ranges",
    "pick.drive",
    "command",
    "command.catalog",
    "storage.ns",
    "storage.purge",
    "live.lang",
    "live.theme",
    "ui.focus-out",
    "ui.activity",
    "drop.files",
];
/// The admitted parent origins, beside `index.html` (§2.3).
const CONFIG: &str = "evora-host.json";
/// Evora's languages (§4.2 `lang`).
const LANGS: [&str; 14] = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "tr", "zh-Hans"];
/// The capability vocabulary a shell may name (§4.2 `capability`, and the 1.1 amendments the shell
/// already admits at its ceiling: A-19 `ui.focus-out`, A-28 `ui.activity` and `drop.files`,
/// DT-S17 `command.catalog`, `prefs.sync`).
const CAPABILITY_NAMES: [&str; 23] = [
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
    "ui.focus-out",
    "ui.activity",
    "drop.files",
    "command.catalog",
    "prefs.sync",
];
/// `evora:request-save` reasons (§4.3).
const REASONS: [&str; 5] = ["autosave", "visibility", "close", "logout", "user"];
/// `ackCode` (§4.2).
pub(crate) const ACK_CODES: [&str; 16] = [
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
pub(crate) const DOC_DIR: &str = "/evora";
/// What the app says when it writes a file inside Evora that the shell cannot take.
pub(crate) const NOT_HERE: &str = "not available inside Evora: only the project opened from Evora is saved, to Evora";
/// `evora:need` paths at most per message, unless `evora:init.limits.maxPathsPerNeed` names
/// another bound: Evora's `creative_ehp_max_paths_per_need` (D-15, 2026-10-24).
const DEFAULT_MAX_PATHS_PER_NEED: usize = 64;
/// Bytes of a medium the shell may send inline (`evora:file {bytes}`), unless
/// `limits.maxMediaBytes` says otherwise: Evora's `creative_ehp_max_media_bytes` (D-15).
const DEFAULT_MAX_MEDIA_BYTES: f64 = 52_428_800.0;
/// Files at most per `evora:drop`, unless `limits.maxDropFiles` says otherwise. Evora has no
/// `{EHP_MAX_DROP_FILES}` yet (A-28): development fallback, the bound of `evora:need`, to be decided.
const DEFAULT_MAX_DROP_FILES: usize = 64;
/// Largest `result` of an `evora:command` answer, in JSON bytes: Evora's
/// `creative_ehp_max_command_result_bytes` (D-15). A larger result is not sent.
const MAX_COMMAND_RESULT_BYTES: usize = 65_536;

/// The project Evora opened.
#[derive(Clone)]
pub(crate) struct HostDoc {
    pub doc_ref: String,
    pub name: String,
    pub path: String,
}

/// The bounds of `evora:init.limits` the engine applies.
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub max_document: f64,
    pub max_export: f64,
    pub max_media: f64,
    pub max_paths_per_need: usize,
    pub max_drop_files: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_document: 0.0,
            max_export: 0.0,
            max_media: DEFAULT_MAX_MEDIA_BYTES,
            max_paths_per_need: DEFAULT_MAX_PATHS_PER_NEED,
            max_drop_files: DEFAULT_MAX_DROP_FILES,
        }
    }
}

pub(crate) struct State {
    pub parent: web_sys::Window,
    pub origin: String,
    pub ready_id: String,
    /// An `evora:init` was accepted (a second one is ignored).
    pub initialized: bool,
    /// The effective capabilities: what the shell offers and this engine declares (§9).
    pub caps: Vec<String>,
    pub limits: Limits,
    /// The account's storage namespace, when `storage.ns` is effective.
    pub storage_ns: Option<String>,
    pub doc: Option<HostDoc>,
    /// `evora:save` messages awaiting their `evora:saved` (`ehp_save`).
    pub saves: Vec<crate::ehp_save::SaveInFlight>,
    /// A Save As in flight (`evora:save {saveAs: true}`, §7.3).
    pub save_as: Option<crate::ehp_save::SaveAs>,
    /// The session's saved revision at the end of the last tick (`doc.saved-ack`).
    pub prev_saved: Option<u64>,
    /// `evora:export` ids awaiting their `evora:ack`, with the file's name.
    pub exports: Vec<(String, String)>,
    pub last_dirty: Option<bool>,
    /// The last `evora:activity` state sent (`ui.activity`).
    pub last_busy: Option<bool>,
    /// Every `id` received (a replay is ignored, §3).
    pub seen: HashSet<String>,
}

impl State {
    pub fn has(&self, capability: &str) -> bool {
        self.initialized && self.caps.iter().any(|c| c == capability)
    }
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    /// The `id` of the `evora:request-save` that the save being written answers.
    static SAVE_RE: RefCell<Option<String>> = const { RefCell::new(None) };
    /// Why the save of the project Evora opened was refused (an `ackCode`).
    static REFUSAL: Cell<Option<&'static str>> = const { Cell::new(None) };
    /// `evora:failed {code: "panic"}`, built once the bridge listens, with where it goes; the panic
    /// hook takes it (once).
    static ON_PANIC: RefCell<Option<(web_sys::Window, String, js_sys::Object)>> = const { RefCell::new(None) };
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
        report_panics(&parent, &origin);
        install_fault_injection();
        crate::ehp_focus::listen();
        let mut st = State {
            parent,
            origin,
            ready_id: String::new(),
            initialized: false,
            caps: Vec::new(),
            limits: Limits::default(),
            storage_ns: None,
            doc: None,
            saves: Vec::new(),
            save_as: None,
            prev_saved: None,
            exports: Vec::new(),
            last_dirty: None,
            last_busy: None,
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

/// A panic stops the engine for good: once the hooks have run, the wasm traps. The shell hears it
/// from the panic hook itself, before the trap, with `evora:failed {code: "panic"}` (§4.4), built
/// now (the hook only posts it, once) and without any detail: the shell shows its own message. The
/// page (`index.html`) learns the admitted origin to report an abort without a panic (out of
/// memory), unless the hook already did.
fn report_panics(parent: &web_sys::Window, origin: &str) {
    if let Some(load) = page_load_state() {
        let _ = js_sys::Reflect::set(&load, &JsValue::from_str("ehpOrigin"), &JsValue::from_str(origin));
    }
    // The wasm build aborts on a panic. Were it to unwind, upstream would catch a panel's panic and
    // the session would go on: nothing to report then.
    if !cfg!(panic = "abort") {
        return;
    }
    let Some(payload) = object(&[("code", "panic".into())]) else { return };
    let Some((message, _)) = envelope("evora:failed", None, &payload) else { return };
    ON_PANIC.with(|p| *p.borrow_mut() = Some((parent.clone(), origin.to_string(), message)));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        report_panic();
        previous(info);
    }));
}

/// The panic hook's part: post the prepared `evora:failed`, once.
fn report_panic() {
    let Some((parent, origin, message)) = ON_PANIC.with(|p| p.try_borrow_mut().ok().and_then(|mut p| p.take())) else { return };
    if let Some(load) = page_load_state() {
        let _ = js_sys::Reflect::set(&load, &JsValue::from_str("ehpFailed"), &JsValue::TRUE);
    }
    let _ = parent.post_message(&message, &origin);
}

/// `window.filmcraftLoad`, the page's start-up state (`index.html`).
fn page_load_state() -> Option<JsValue> {
    let window = web_sys::window()?;
    let load = get(&JsValue::from(window), "filmcraftLoad");
    load.is_object().then_some(load)
}

/// `filmcraft.injectPanic()`: upstream's fault injection (the next UI pass panics,
/// `FilmcraftApp::panic_next_frame`), for the CI smoke test of the panic report. Only once the bridge
/// listens; a script that can call it can already stop the page.
fn install_fault_injection() {
    let Some(window) = web_sys::window() else { return };
    let api = get(&JsValue::from(window), "filmcraft");
    if !api.is_object() {
        return;
    }
    let inject = Closure::<dyn Fn()>::new(|| crate::post(|w, _| w.app.panic_next_frame = true)).into_js_value();
    let _ = js_sys::Reflect::set(&api, &JsValue::from_str("injectPanic"), &inject);
}

/// After each frame: the saved state Evora confirmed (`doc.saved-ack`), Save As adopted,
/// `evora:dirty` when the project Evora opened gains or loses unsaved changes, `evora:activity`
/// while an export runs, and the command catalog when it changed.
pub fn tick(session: &mut filmcraft_engine::Session) {
    let catalog = STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return false };
        let Some(st) = s.as_mut() else { return false };
        if !st.initialized {
            return false;
        }
        crate::ehp_save::track(st, session);
        report_dirty(st, session);
        report_activity(st, session);
        st.has("command.catalog")
    });
    if catalog {
        crate::ehp_commands::tick(session);
    }
}

/// `evora:dirty {dirty, docRef}` when the state of the project Evora opened changed.
fn report_dirty(st: &mut State, session: &filmcraft_engine::Session) {
    if !st.has("doc.dirty") {
        return;
    }
    let shown = session.path.as_deref();
    let pending_as = st.save_as.as_ref().map(|a| a.temp_path.as_str());
    let Some(doc_ref) = st.doc.as_ref().filter(|d| shown == Some(d.path.as_str()) || (shown.is_some() && shown == pending_as)).map(|d| d.doc_ref.clone()) else {
        return;
    };
    let dirty = session.is_dirty();
    if st.last_dirty == Some(dirty) {
        return;
    }
    if let Some(payload) = object(&[("dirty", dirty.into()), ("docRef", doc_ref.into())])
        && send(st, "evora:dirty", None, &payload, None).is_some()
    {
        st.last_dirty = Some(dirty);
    }
}

/// `evora:activity {busy, kind: "export"}` (A-28) when an export job starts or ends: the shell
/// warns before leaving the editor while one runs.
fn report_activity(st: &mut State, session: &filmcraft_engine::Session) {
    // SABORDAGE QA (témoin ACTIVITY-EXPORT, COR-FK-B1) : aucune activité signalée
    if st.initialized || !st.has("ui.activity") {
        return;
    }
    let busy = session.jobs.iter().any(|j| j.result.lock().map(|r| r.is_none()).unwrap_or(false));
    if st.last_busy == Some(busy) {
        return;
    }
    if let Some(payload) = object(&[("busy", busy.into()), ("kind", "export".into())])
        && send(st, "evora:activity", None, &payload, None).is_some()
    {
        st.last_busy = Some(busy);
    }
}

/// The file-write hook inside Evora (`fs::set_on_write`, also called by `write_file_new`): the
/// project goes to the shell as `evora:save`, Save As as a new document, any other file as
/// `evora:export` (`ehp_save`); never a download.
pub fn on_write(path: &str, data: &[u8]) -> Result<(), String> {
    STATE.with(|s| {
        let Ok(mut s) = s.try_borrow_mut() else { return Err("Evora is busy".to_string()) };
        let Some(st) = s.as_mut() else { return Err("Evora is not connected".to_string()) };
        crate::ehp_save::on_write(st, path, data)
    })
}

/// The `id` of the `evora:request-save` the save being written answers (taken once).
pub(crate) fn take_save_re() -> Option<String> {
    SAVE_RE.with(|r| r.borrow_mut().take())
}

/// Why the save being written was refused (an `ackCode`).
pub(crate) fn refuse(code: &'static str) {
    REFUSAL.set(Some(code));
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
        "evora:init" | "evora:ack" => None,
        "evora:open" => Some("doc.open"),
        "evora:saved" => Some("doc.save"),
        "evora:request-save" => Some("doc.request-save"),
        "evora:lang" => Some("live.lang"),
        "evora:theme" => Some("live.theme"),
        "evora:purge" => Some("storage.purge"),
        "evora:command" => Some("command"),
        // the answer to a need, a picker or a drop (`ehp_media`)
        "evora:file" => Some("evora:file"),
        // Unknown here, or a capability this engine doesn't declare: ignored (§4.1, §10).
        _ => return,
    };
    let effective = |c: &str| {
        STATE.with(|s| {
            s.borrow().as_ref().is_some_and(|st| match c {
                "evora:file" => st.has("media.need") || st.has("pick.drive") || st.has("drop.files"),
                c => st.has(c),
            })
        })
    };
    if let Some(c) = capability
        && !effective(c)
    {
        return;
    }
    if kind == "evora:ack" && !STATE.with(|s| s.borrow().as_ref().is_some_and(|st| st.initialized)) {
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
    let answer = matches!(kind.as_str(), "evora:init" | "evora:saved" | "evora:file" | "evora:ack");
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
        "evora:command" => crate::ehp_commands::on_command(id, &payload),
        "evora:file" => {
            if let Some(re) = re.as_deref() {
                crate::ehp_media::on_file(re, &payload);
            }
        }
        "evora:ack" => on_ack(re.as_deref(), &payload),
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
    limits: Limits,
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
    let limits = parse_limits(&get(p, "limits"))?;
    Some(Init { language, theme, accent, storage_ns, caps, limits })
}

/// `limits`: `maxDocumentBytes` and `maxExportBytes` (§4.3), and the bounds of the 1.1 amendment
/// A-15 a shell may add (`maxMediaBytes`, `maxPathsPerNeed`, `maxDropFiles`); each a whole number ≥ 1.
fn parse_limits(limits: &JsValue) -> Option<Limits> {
    let keys = ["maxDocumentBytes", "maxExportBytes", "maxMediaBytes", "maxPathsPerNeed", "maxDropFiles"];
    if !plain_object(limits) || !only_keys(limits, &keys) {
        return None;
    }
    let whole = |key: &str| get(limits, key).as_f64().filter(|m| *m >= 1.0 && m.fract() == 0.0);
    let optional = |key: &str| if get(limits, key).is_undefined() { Some(None) } else { whole(key).map(Some) };
    let defaults = Limits::default();
    Some(Limits {
        max_document: whole("maxDocumentBytes")?,
        max_export: whole("maxExportBytes")?,
        max_media: optional("maxMediaBytes")?.unwrap_or(defaults.max_media),
        max_paths_per_need: optional("maxPathsPerNeed")?.map_or(defaults.max_paths_per_need, |n| n as usize),
        max_drop_files: optional("maxDropFiles")?.map_or(defaults.max_drop_files, |n| n as usize),
    })
}

/// `evora:init`: language, theme and accent go to the UI thread (applied before any later request is
/// handled); the storage namespace is opened once the other namespaces and upstream's leftovers are
/// purged (§7.1 step 6, §7.7 b); then the answer, which waits for no UI frame.
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
            st.limits = init.limits;
            st.storage_ns = namespace.then(|| init.storage_ns.clone());
            // no export runs yet: `evora:activity` reports the first start
            st.last_busy = Some(false);
        }
    });
    let values = json!({
        "general.interfaceLanguage": init.language,
        "appearance.appearanceMode": init.theme,
        "appearance.highlightColor": init.accent,
    });
    let ns = init.storage_ns;
    crate::post(move |w, _| apply_prefs(w, &values));
    wasm_bindgen_futures::spawn_local(async move {
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
        // the catalog follows the answer (`command.catalog`)
        crate::ehp_commands::mark_dirty();
        crate::post(|_, _| {});
    });
}

/// Apply preferences on the UI thread (they take effect at the next frame, `apply_prefs`).
async fn set_prefs(values: serde_json::Value) {
    crate::import::on_ui(move |w, _| apply_prefs(w, &values)).await;
}

fn apply_prefs(w: &mut crate::WebApp, values: &serde_json::Value) {
    if let Err(e) = w.app.session.execute("prefs.set", json!({ "values": values })) {
        log::warn!("Evora preferences: {e}");
    }
}

/// `evora:open`: a project in bytes or at a signed URL (`media.ranges`), opened at
/// `/evora/<docRef>/<name>`, or a new one.
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
    let doc = HostDoc { path: format!("{DOC_DIR}/{doc_ref}/{name}"), doc_ref, name };
    if !url.is_undefined() {
        let Some(url) = url.as_string().filter(|u| u.starts_with("https://") || u.starts_with("http://")) else { return };
        // A signed URL needs `media.ranges` (exception A4).
        if !has("media.ranges") {
            ack(&id, false, Some("capability"));
            return;
        }
        let max = limits().max_document;
        wasm_bindgen_futures::spawn_local(async move {
            match crate::remote::get_whole(&url, max).await {
                Ok(data) => open_bytes(id, doc, data),
                Err(crate::remote::RangeError::Expired) => ack(&id, false, Some("forbidden")),
                Err(crate::remote::RangeError::Other(e)) => {
                    log::warn!("project from Evora by URL: {e}");
                    ack(&id, false, Some("network"));
                }
            }
        });
        return;
    }
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
                    opened(&id, doc, &mut w.app.session);
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
    if STATE.with(|s| s.borrow().as_ref().is_none_or(|st| length > st.limits.max_document)) {
        ack(&id, false, Some("too_large"));
        return;
    }
    open_bytes(id, doc, js_sys::Uint8Array::new(&bytes).to_vec());
}

/// Open the project's bytes at the document's path, on the UI thread.
fn open_bytes(id: String, doc: HostDoc, data: Vec<u8>) {
    crate::post(move |w, _| {
        crate::fs::put(&doc.path, data);
        match w.app.session.execute("file.open", json!({ "path": doc.path.clone() })) {
            Ok(_) => opened(&id, doc, &mut w.app.session),
            Err(e) => {
                log::warn!("project from Evora: {e}");
                ack(&id, false, Some("invalid_content"));
            }
        }
    });
}

/// The project is open: remember it (any save of the previous one is forgotten), answer, report
/// its state (§7.1 step 8), then ask for the media it names that the engine doesn't have (§7.5).
fn opened(id: &str, doc: HostDoc, session: &mut filmcraft_engine::Session) {
    let doc_ref = doc.doc_ref.clone();
    STATE.with(|s| {
        if let Some(st) = s.borrow_mut().as_mut() {
            st.doc = Some(doc);
            st.last_dirty = None;
            st.saves.clear();
            st.save_as = None;
            st.prev_saved = Some(session.saved_revision);
        }
    });
    ack(id, true, None);
    tick(session);
    crate::ehp_media::need_missing(&doc_ref, session);
    crate::ehp_commands::mark_dirty();
}

/// `evora:saved`: checked against the save it answers. With `doc.saved-ack`, the next tick marks
/// the project saved (or keeps it modified) and Save As adopts the new document (`ehp_save`);
/// without it the engine keeps upstream's behaviour (saved once handed over) and the shell shows
/// its own save state (§6.3).
fn on_saved(re: Option<&str>, p: &JsValue) {
    let Some(re) = re else { return };
    if !only_keys(p, &["ok", "version", "docRef", "error"]) {
        return;
    }
    let (version, doc_ref, error) = (get(p, "version"), get(p, "docRef"), get(p, "error"));
    let ok = get(p, "ok").as_bool();
    let valid = match ok {
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
    let answered = STATE.with(|s| s.borrow_mut().as_mut().is_some_and(|st| crate::ehp_save::answered(st, re, ok == Some(true), doc_ref.as_string())));
    if answered {
        // the next tick applies it, even in an iframe that gets no frame
        crate::post(|_, _| {});
    }
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
        // the catalog's labels follow the language (`command.catalog`)
        crate::ehp_commands::mark_dirty();
        crate::post(|_, _| {});
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

/// `evora:ack` from the shell (§4.5): the answer to an `evora:export` (its message on the canvas),
/// or the close of a need, a picker or a drop (`ehp_media`). An unknown `re` is ignored.
fn on_ack(re: Option<&str>, p: &JsValue) {
    let Some(re) = re else { return };
    if !only_keys(p, &["ok", "code", "result"]) {
        return;
    }
    let Some(ok) = get(p, "ok").as_bool() else { return };
    let code = get(p, "code");
    let code = if code.is_undefined() {
        None
    } else {
        match code.as_string().filter(|c| ACK_CODES.contains(&c.as_str())) {
            Some(c) => Some(c),
            None => return,
        }
    };
    if !ok && code.is_none() {
        return;
    }
    let export = STATE.with(|s| {
        s.borrow_mut().as_mut().and_then(|st| {
            let i = st.exports.iter().position(|(id, _)| id == re)?;
            Some(st.exports.remove(i).1)
        })
    });
    if let Some(name) = export {
        let message = if ok {
            format!("Sent to Evora's Drive: {name}")
        } else {
            format!("{name} could not be sent to Evora's Drive ({})", code.unwrap_or_default())
        };
        crate::post(move |w, _| w.app.status(message));
        return;
    }
    crate::ehp_media::on_ack(re, ok, code);
}

pub(crate) fn ack(re: &str, ok: bool, code: Option<&str>) {
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

/// `evora:ack {ok: true, result}` answering an `evora:command` (§4.5): the command's result, when
/// it is within [`MAX_COMMAND_RESULT_BYTES`] of JSON.
pub(crate) fn ack_result(re: &str, result: &serde_json::Value) {
    let mut fields: Vec<(&str, JsValue)> = vec![("ok", true.into())];
    if !result.is_null() && result.to_string().len() <= MAX_COMMAND_RESULT_BYTES {
        fields.push(("result", crate::api::to_js(result)));
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
pub(crate) fn send(st: &State, kind: &str, re: Option<&str>, payload: &js_sys::Object, transfer: Option<&JsValue>) -> Option<String> {
    let (message, id) = envelope(kind, re, payload)?;
    let sent = match transfer {
        Some(t) => st.parent.post_message_with_transfer(&message, &st.origin, &js_sys::Array::of1(t)),
        None => st.parent.post_message(&message, &st.origin),
    };
    sent.ok().map(|()| id)
}

/// [`send`] from outside the bridge's state (once `evora:init` is accepted).
pub(crate) fn post_message(kind: &str, re: Option<&str>, payload: &js_sys::Object, transfer: Option<&JsValue>) -> Option<String> {
    STATE.with(|s| s.try_borrow().ok().and_then(|s| s.as_ref().filter(|st| st.initialized).and_then(|st| send(st, kind, re, payload, transfer))))
}

/// A capability is effective (§9).
pub(crate) fn has(capability: &str) -> bool {
    STATE.with(|s| s.try_borrow().ok().is_some_and(|s| s.as_ref().is_some_and(|st| st.has(capability))))
}

/// The document Evora opened.
pub(crate) fn current_doc_ref() -> Option<String> {
    STATE.with(|s| s.try_borrow().ok().and_then(|s| s.as_ref().and_then(|st| st.doc.as_ref().map(|d| d.doc_ref.clone()))))
}

/// The bounds of `evora:init` (defaults before it).
pub(crate) fn limits() -> Limits {
    STATE.with(|s| s.try_borrow().ok().and_then(|s| s.as_ref().map(|st| st.limits)).unwrap_or_default())
}

/// `evora:focus-out {}` (A-19, §7.9): the user asked, at the keyboard, to leave the engine. Only
/// with `ui.focus-out` effective; `false` when not sent.
pub(crate) fn focus_out() -> bool {
    STATE.with(|s| {
        let Ok(s) = s.try_borrow() else { return false };
        let Some(st) = s.as_ref().filter(|st| st.has("ui.focus-out")) else { return false };
        let Some(payload) = object(&[]) else { return false };
        send(st, "evora:focus-out", None, &payload, None).is_some()
    })
}
