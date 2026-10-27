//! Evora fork (patches COR-10 and COR-FK-B1; DT-S17 of Evora's campaign « suite créative V1 »):
//! Evora runs the engine's commands (`command`) and knows all of them (`command.catalog`), so that
//! the assistant can do on request what a menu does.
//!
//! - **The catalog** is the menu tree (`menus::menu_items_for`): every command a user can choose,
//!   except those the shell owns (the project's own file: open, save, new, recovery and recent
//!   files; links; the interface language; preferences; voice-over, excluded from Corte V1). Each
//!   entry: stable `id`, `label` in the language served, `menu` path in that language, `params`
//!   (the engine's description of the parameters, `{}` for none), `enabled`, `destructive`. It
//!   goes to the shell as `evora:commands {commands}` after `evora:init`, an open, a language
//!   change, each command, and whenever the language or an enabled state changes (checked at most
//!   every [`POLL_MS`]).
//! - **`evora:command {command, params, confirmed?}`** runs a catalog command as its menu item does
//!   (`menus::invoke`), and answers `evora:ack {ok: true, result}`. Outside the catalog (or unknown):
//!   `capability`; destructive (work lost, nothing to undo) without `confirmed: true`: `forbidden`,
//!   Evora asks the user first (D-24); disabled now: `busy`; failed: `invalid_content`.

use std::cell::Cell;
use std::collections::HashSet;

use serde_json::{Value, json};
use wasm_bindgen::JsValue;

use crate::ehp::{ack, get, only_keys, plain_object};

/// Prefixes of the commands the shell owns: never listed, never run for Evora.
const HOST_OWNED_PREFIXES: [&str; 4] = ["app.", "help.", "prefs.", "voiceover."];
/// Commands the shell owns: the project's own file (Evora opens, saves and names it), recovery
/// and recent files.
const HOST_OWNED: [&str; 14] = [
    "file.open",
    "file.openDemoProject",
    "file.importDemoFootage",
    "file.newProject",
    "file.save",
    "file.saveAs",
    "file.saveCopy",
    "file.recover",
    "file.recoveryList",
    "file.discardRecovery",
    "file.listAutoSaves",
    "file.autoSaveNow",
    "file.autoSaveStatus",
    "file.clearRecent",
];
/// Commands that lose work or cannot be undone: Evora asks the user first (D-24), then sends
/// `confirmed: true`.
const DESTRUCTIVE: [&str; 10] = [
    "file.revert",
    "history.clear",
    "history.deleteRedoable",
    "project.delete",
    "sequence.deleteTrack",
    "sequence.deleteRenderFiles",
    "sequence.deleteRenderFilesInToOut",
    "markers.clearAll",
    "window.workspace.reset",
    "view.guideTemplates.delete",
];
/// Milliseconds between two checks of the catalog's language and enabled states: a cadence of the
/// engine's own work, not a setting of Evora.
const POLL_MS: f64 = 1000.0;
/// Longest command id accepted.
const MAX_ID_LENGTH: usize = 128;

thread_local! {
    /// The catalog must be sent at the next tick.
    static DIRTY: Cell<bool> = const { Cell::new(false) };
    static LAST_CHECK: Cell<f64> = const { Cell::new(0.0) };
    /// Fingerprint (language, ids, enabled states) of the last catalog sent.
    static LAST_SIG: Cell<u64> = const { Cell::new(0) };
}

/// A command Evora may list and run.
pub fn allowed(id: &str) -> bool {
    !HOST_OWNED_PREFIXES.iter().any(|p| id.starts_with(p)) && !HOST_OWNED.contains(&id)
}

/// A command that needs the user's confirmation.
pub fn destructive(id: &str) -> bool {
    DESTRUCTIVE.contains(&id)
}

/// Send the catalog at the next tick.
pub fn mark_dirty() {
    DIRTY.set(true);
}

fn fnv(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The menu items Evora may run, once each.
fn items(session: &filmcraft_engine::Session) -> Vec<filmcraft_ui_egui::menus::MenuItem> {
    let mut seen = HashSet::new();
    filmcraft_ui_egui::menus::menu_items_for(session).into_iter().filter(|it| allowed(&it.id) && seen.insert(it.id.clone())).collect()
}

/// At each tick, with `command.catalog` effective: `evora:commands` when due and changed.
pub fn tick(session: &filmcraft_engine::Session) {
    let now = js_sys::Date::now();
    let forced = DIRTY.get();
    if !forced && now - LAST_CHECK.get() < POLL_MS {
        return;
    }
    LAST_CHECK.set(now);
    let items = items(session);
    let lang = filmcraft_ui_egui::i18n::current().code();
    let mut sig = fnv(0xcbf2_9ce4_8422_2325, lang.as_bytes());
    for it in &items {
        sig = fnv(sig, it.id.as_bytes());
        sig = fnv(sig, if it.enabled { b"1" } else { b"0" });
    }
    if !forced && sig == LAST_SIG.get() {
        return;
    }
    let commands: Vec<Value> = items
        .iter()
        .map(|it| {
            json!({
                "id": it.id,
                "label": filmcraft_ui_egui::i18n::t(&it.label),
                "menu": it.path.iter().map(|p| filmcraft_ui_egui::i18n::t(p).to_string()).collect::<Vec<_>>(),
                "params": filmcraft_engine::find_command(&it.id).map_or("{}", |c| c.params),
                "enabled": it.enabled,
                "destructive": destructive(&it.id),
            })
        })
        .collect();
    let Some(payload) = crate::ehp_wire::json_object(&json!({ "commands": commands })) else { return };
    if crate::ehp::post_message("evora:commands", None, &payload, None).is_some() {
        DIRTY.set(false);
        LAST_SIG.set(sig);
    }
}

/// `^[a-z][A-Za-z0-9_.-]*$` (§4.3).
fn is_command_id(c: &str) -> bool {
    let mut chars = c.chars();
    c.len() <= MAX_ID_LENGTH && chars.next().is_some_and(|f| f.is_ascii_lowercase()) && chars.all(|x| x.is_ascii_alphanumeric() || matches!(x, '_' | '.' | '-'))
}

/// `evora:command {command, params, confirmed?}`: checked here, then run on the UI thread against
/// the menu tree of that moment.
pub fn on_command(id: String, p: &JsValue) {
    if !only_keys(p, &["command", "params", "confirmed"]) {
        return;
    }
    let Some(command) = get(p, "command").as_string().filter(|c| is_command_id(c)) else { return };
    let params = get(p, "params");
    if !plain_object(&params) {
        return;
    }
    let confirmed = get(p, "confirmed");
    if !confirmed.is_undefined() && confirmed.as_bool().is_none() {
        return;
    }
    let confirmed = confirmed.as_bool() == Some(true);
    let params = crate::api::from_js(&params);
    crate::post(move |w, ctx| {
        let item = items(&w.app.session).into_iter().find(|it| it.id == command);
        let Some(item) = item else {
            ack(&id, false, Some("capability"));
            return;
        };
        if destructive(&command) && !confirmed {
            ack(&id, false, Some("forbidden"));
            return;
        }
        if !item.enabled {
            ack(&id, false, Some("busy"));
            return;
        }
        match filmcraft_ui_egui::menus::invoke(&mut w.app, ctx, &command, params) {
            Ok(result) => crate::ehp::ack_result(&id, &result),
            Err(e) => {
                log::warn!("Evora command {command}: {e}");
                ack(&id, false, Some("invalid_content"));
            }
        }
        mark_dirty();
    });
}
