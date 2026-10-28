//! Evora fork (patches COR-10 and COR-FK-B1; DT-S17 of Evora's campaign « suite créative V1 »):
//! Evora runs the engine's commands (`command`) and knows all of them (`command.catalog`), so that
//! the assistant can do on request what a menu does. The rule of 2026-10-27 for every command
//! bridge of the suite applies: a white list, no free parameter.
//!
//! - **The catalog** is the set of live menu items (`menus::menu_items_for`; an item with no menu
//!   is hidden and never listed) MINUS the shell's namespaces, refused by construction and not by
//!   enumeration: every `file.*`, `app.*`, `help.*`, `prefs.*` and `voiceover.*` item (voice-over
//!   is excluded from Corte V1) and every item of File ▸ Project Settings (the project's disks and
//!   ingest destination), SAVE the `file.*` items of [`ADMITTED`], admitted one by one: the
//!   creations of an element in the open project (never a new project) and the imports and exports
//!   that pass through the shell (`evora:pick`, `evora:export`). Each entry: stable `id`, `label` in
//!   the language served, `menu` path in that language, `params` (the JSON schema of the parameters
//!   Evora accepts: none, unless [`PARAM_SCHEMAS`] declares keys), `enabled`, `destructive`. It goes
//!   to the shell as `evora:commands {commands}` after `evora:init`, an open, a language change, each
//!   command, and whenever the language or an enabled state changes (checked at most every
//!   [`POLL_MS`]).
//! - **`evora:command {command, params, confirmed?}`** runs a catalog command as its menu item does
//!   (`menus::invoke`; a destructive one Evora confirmed runs as the engine's command, without the
//!   interface's own confirmation dialog), and answers `evora:ack {ok: true, result}`. Refusals:
//!   outside the catalog (or unknown) `capability`; `params` other than `{}`, or outside the
//!   command's declared schema (a key it does not declare, a value that is not a plain name, a string
//!   that looks like a path or a URL) `invalid_content`; destructive (work lost, nothing to undo)
//!   without `confirmed: true` `forbidden`, Evora asks the user first (D-24); disabled now `busy`;
//!   failed `invalid_content`.

use std::cell::Cell;
use std::collections::HashSet;

use filmcraft_ui_egui::menus::MenuItem;
use serde_json::{Map, Value, json};
use wasm_bindgen::JsValue;

use crate::ehp::{ack, get, only_keys, plain_object};

/// The shell's namespaces: never listed, never run for Evora, whatever the command (save the
/// `file.*` commands of [`ADMITTED`]).
const SHELL_PREFIXES: [&str; 5] = ["file.", "app.", "help.", "prefs.", "voiceover."];
/// Submenus the shell owns, whatever their items' ids: File ▸ Project Settings (scratch disks,
/// previews, ingest destination).
const SHELL_SUBMENUS: [&[&str]; 1] = [&["File", "Project Settings"]];
/// The `file.*` commands Evora may list and run, one by one. Creations of an element in the open
/// project (File ▸ New, never a new project); imports through the shell's picker (`evora:pick`);
/// exports whose files go to Evora's Drive (`evora:export`). Never the project's own file (open,
/// save, close, recent, revert, templates, project manager, media browser).
const ADMITTED: [&str; 23] = [
    // SABORDAGE QA : liste blanche élargie (témoin, retiré au commit suivant)
    "file.importFromMediaBrowser",
    "file.newSequence",
    "file.newSequenceFromClip",
    "file.newBin",
    "file.newBinFromSelection",
    "file.newSearchBin",
    "file.newOfflineFile",
    "file.newAdjustmentLayer",
    "file.newBarsAndTone",
    "file.newBlackVideo",
    "file.newColorMatte",
    "file.newCountingLeader",
    "file.newTransparentVideo",
    "file.import",
    "file.importImageSequence",
    "file.exportMedia",
    "file.exportEdl",
    "file.exportFcp7Xml",
    "file.exportFcpxml",
    "file.exportOtio",
    "file.exportAle",
    "file.exportAaf",
    "file.exportOmf",
];
/// Commands that lose work or cannot be undone: Evora asks the user first (D-24), then sends
/// `confirmed: true`. Some are hidden in this version (no menu): the list stands for an upstream
/// version that would show them.
const DESTRUCTIVE: [&str; 8] = [
    "history.clear",
    "history.deleteRedoable",
    "project.delete",
    "sequence.deleteTrack",
    "sequence.deleteRenderFiles",
    "sequence.deleteRenderFilesInToOut",
    // SABORDAGE QA : markers.clearAll retirée (témoin, retiré au commit suivant)
    "window.workspace.reset",
    "view.guideTemplates.delete",
];
/// The parameters Evora declares: for these commands, only these keys, each a plain name; every
/// other command takes `{}` and runs as its menu item does (its dialog opens in the engine).
const PARAM_SCHEMAS: [(&str, &[&str]); 1] = [("file.newBin", &["name"])];
/// Longest plain name accepted in a declared parameter, in characters.
const MAX_NAME_CHARS: usize = 255;
/// What makes a string a path or a URL, compared without case: never a plain name.
const PATH_MARKS: [&str; 6] = ["/", "\\", "..", ":", "opfs", "evora"];
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

/// A live menu item Evora may list and run: outside the shell's namespaces and submenus, or
/// admitted by name.
fn admitted(item: &MenuItem) -> bool {
    let shell_id = SHELL_PREFIXES.iter().any(|p| item.id.starts_with(p)) && !ADMITTED.contains(&item.id.as_str());
    let shell_menu = SHELL_SUBMENUS.iter().any(|m| item.path.len() >= m.len() && item.path.iter().zip(m.iter()).all(|(a, b)| a.as_str() == *b));
    !shell_id && !shell_menu
}

/// A command that needs the user's confirmation.
fn destructive(id: &str) -> bool {
    DESTRUCTIVE.contains(&id)
}

/// The keys the command declares (none for most).
fn declared(id: &str) -> &'static [&'static str] {
    for (command, keys) in PARAM_SCHEMAS {
        if command == id {
            return keys;
        }
    }
    &[]
}

/// The JSON schema of the parameters Evora accepts for `id`, as the catalog lists it.
fn params_schema(id: &str) -> Value {
    let keys = declared(id);
    if keys.is_empty() {
        return json!({"type": "object", "maxProperties": 0});
    }
    let properties: Map<String, Value> =
        keys.iter().map(|k| ((*k).to_string(), json!({"type": "string", "minLength": 1, "maxLength": MAX_NAME_CHARS}))).collect();
    json!({"type": "object", "additionalProperties": false, "properties": properties})
}

/// A plain name: not empty, at most [`MAX_NAME_CHARS`] characters, no control character, nothing of
/// a path or a URL ([`PATH_MARKS`]).
fn plain_name(s: &str) -> bool {
    let lower = s.to_lowercase();
    // SABORDAGE QA : chemin et URL admis (témoin, retiré au commit suivant)
    let _ = (&lower, PATH_MARKS);
    !s.is_empty() && s.chars().count() <= MAX_NAME_CHARS && !s.chars().any(char::is_control)
}

/// `{}`, or only keys the command declares, each a plain name.
fn params_ok(id: &str, params: &Value) -> bool {
    let Some(map) = params.as_object() else { return false };
    let keys = declared(id);
    map.iter().all(|(k, v)| keys.contains(&k.as_str()) && v.as_str().is_some_and(plain_name))
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
fn items(session: &filmcraft_engine::Session) -> Vec<MenuItem> {
    let mut seen = HashSet::new();
    filmcraft_ui_egui::menus::menu_items_for(session).into_iter().filter(|it| admitted(it) && seen.insert(it.id.clone())).collect()
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
                "params": params_schema(&it.id),
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
        if !params_ok(&command, &params) {
            ack(&id, false, Some("invalid_content"));
            return;
        }
        if destructive(&command) && !confirmed {
            ack(&id, false, Some("forbidden"));
            return;
        }
        if !item.enabled {
            ack(&id, false, Some("busy"));
            return;
        }
        // a destructive command Evora confirmed (D-24) runs without the interface's own confirmation
        // dialog (never two confirmations): the engine's command when there is one
        let run = if confirmed && destructive(&command) && filmcraft_engine::find_command(&command).is_some() {
            w.app.session.execute(&command, params).map_err(|e| e.to_string())
        } else {
            filmcraft_ui_egui::menus::invoke(&mut w.app, ctx, &command, params)
        };
        match run {
            Ok(result) => crate::ehp::ack_result(&id, &result),
            Err(e) => {
                log::warn!("Evora command {command}: {e}");
                ack(&id, false, Some("invalid_content"));
            }
        }
        mark_dirty();
    });
}
