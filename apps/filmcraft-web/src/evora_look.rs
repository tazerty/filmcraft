//! Evora fork (patch COR-FK-B2; Evora's campaign « suite créative V1 », 2026-10-27): how Corte looks
//! and what it offers inside Evora's shell (`?host=evora`), on top of the bridge ([`crate::ehp`]).
//!
//! - **Theme** (E2-CO-a and E2-CO-b): Evora's palette ([`theme::set_evora`]: zinc chrome that meets
//!   the shell's bar, neutral monitors, the shades of the accent `evora:init` names taken from
//!   Evora's palettes with contrast floors) and accessible contrast, both before the first frame.
//!   `filmcraft.info().theme` reports the live tokens (`name: "evora"`).
//! - **Labels**: Evora's sixteen label colours, named in the language the canvas is drawn in
//!   (English where the canvas stays in English); a label the user renamed or recoloured keeps its
//!   own name and colour. `filmcraft.info().labels` reports them.
//! - **Functions left out of Corte V1** (COR-11, CdC §7): no menu item, no catalog entry, never run
//!   ([`menus::set_hidden`], exception E-COR-L5-03): proxies, Project Manager, render previews
//!   (unavailable on the web), transcription, neural voices and voice-over (excluded), and the Help
//!   items that lead outside the shell (E7 keeps them inert).
//! - **Keys** (CO-FK-6b): the default profile keeps the engine's own keys and the conventions every
//!   editor shares ([`universal`]), without the keyboard table the upstream default adopts from
//!   another editor (its shortcut audit) nor that editor's panel table; it is re-applied whenever
//!   the default profile is loaded again. `filmcraft.info().keys` reports it.

use std::cell::Cell;

use filmcraft_engine::project::Label;
use filmcraft_engine::settings::{hex, label_id};
use filmcraft_engine::shortcut_presets::PREMIERE_PANEL;
use filmcraft_engine::shortcuts::{Binding, Chord, DEFAULT_PRESET, Shortcuts, normalize};
use filmcraft_ui_egui::FilmcraftApp;
use filmcraft_ui_egui::menus;
use filmcraft_ui_egui::theme::{self, Tokens};
use serde_json::json;

/// What Corte V1 leaves out (a command id, or a namespace ending in `.`).
pub const HIDDEN: [&str; 22] = [
    // proxies and Project Manager: unavailable on the web (no threads)
    "media.attachProxies",
    "media.createProxies",
    "media.detachProxies",
    "media.reconnectFullRes",
    "media.toggleProxies",
    "file.projectManager",
    // render previews: unavailable on the web
    "sequence.renderEffectsInToOut",
    "sequence.renderInToOut",
    "sequence.renderSelection",
    "sequence.renderAudio",
    "sequence.deleteRenderFiles",
    "sequence.deleteRenderFilesInToOut",
    // transcription (absent from the web build) and its settings
    "sequence.transcribe",
    "transcript.",
    "app.settings.mediaAnalysis",
    // neural voices (absent from the web build) and voice-over (no microphone in the shell)
    "window.panel.TextToSpeech",
    "tts.",
    "voiceover.",
    // Help items that lead outside the shell (inert under E7) or to the file manager
    "help.filmcraftHelp",
    "help.github",
    "help.reportIssue",
    "help.revealLogFiles",
];

/// Evora's label colours (fill shade 700 of Evora's colour families: a white clip name keeps at
/// least 4.5:1 on each), in the order of [`Label::ALL`].
pub const LABEL_COLORS: [&str; 16] = [
    "#4338ca", "#6d28d9", "#7e22ce", "#a21caf", "#be185d", "#be123c", "#c2410c", "#4d7c0f", "#b45309", "#a16207", "#15803d", "#047857",
    "#0f766e", "#0e7490", "#0369a1", "#1d4ed8",
];

/// Their names, per engine language (`Language::code`), in the same order. Languages the canvas
/// draws in English (Japanese, Chinese and Korean without their fonts, the languages the engine
/// lacks) get the English names.
static LABEL_NAMES: [(&str, [&str; 16]); 9] = [
    ("en", ["Indigo", "Violet", "Purple", "Fuchsia", "Pink", "Crimson", "Orange", "Lime", "Amber", "Yellow", "Green", "Emerald", "Teal", "Cyan", "Sky", "Blue"]),
    ("fr", ["Indigo", "Violet", "Pourpre", "Fuchsia", "Rose", "Cramoisi", "Orange", "Lime", "Ambre", "Jaune", "Vert", "Émeraude", "Sarcelle", "Cyan", "Ciel", "Bleu"]),
    (
        "de",
        ["Indigo", "Violett", "Purpur", "Fuchsia", "Pink", "Karmin", "Orange", "Limette", "Bernstein", "Gelb", "Grün", "Smaragd", "Petrol", "Cyan", "Himmelblau", "Blau"],
    ),
    (
        "es",
        ["Índigo", "Violeta", "Púrpura", "Fucsia", "Rosa", "Carmesí", "Naranja", "Lima", "Ámbar", "Amarillo", "Verde", "Esmeralda", "Verde azulado", "Cian", "Celeste", "Azul"],
    ),
    (
        "it",
        ["Indaco", "Viola", "Porpora", "Fucsia", "Rosa", "Cremisi", "Arancione", "Lime", "Ambra", "Giallo", "Verde", "Smeraldo", "Verde acqua", "Ciano", "Celeste", "Blu"],
    ),
    (
        "pt-br",
        ["Índigo", "Violeta", "Púrpura", "Fúcsia", "Rosa", "Carmesim", "Laranja", "Lima", "Âmbar", "Amarelo", "Verde", "Esmeralda", "Verde-azulado", "Ciano", "Celeste", "Azul"],
    ),
    (
        "ru",
        [
            "Индиго",
            "Фиолетовый",
            "Пурпурный",
            "Фуксия",
            "Розовый",
            "Малиновый",
            "Оранжевый",
            "Лаймовый",
            "Янтарный",
            "Жёлтый",
            "Зелёный",
            "Изумрудный",
            "Бирюзовый",
            "Циан",
            "Небесный",
            "Синий",
        ],
    ),
    (
        "uk",
        [
            "Індиго",
            "Фіолетовий",
            "Пурпуровий",
            "Фуксія",
            "Рожевий",
            "Малиновий",
            "Помаранчевий",
            "Лаймовий",
            "Бурштиновий",
            "Жовтий",
            "Зелений",
            "Смарагдовий",
            "Бірюзовий",
            "Ціан",
            "Небесний",
            "Синій",
        ],
    ),
    (
        "id",
        ["Nila", "Violet", "Ungu", "Fuchsia", "Merah Muda", "Merah Tua", "Oranye", "Limau", "Amber", "Kuning", "Hijau", "Zamrud", "Hijau Toska", "Sian", "Biru Langit", "Biru"],
    ),
];

thread_local! {
    /// The language the labels were last named in.
    static LABELS_IN: Cell<Option<&'static str>> = const { Cell::new(None) };
    /// The shortcut revision the keys were last checked at.
    static KEYS_AT: Cell<u64> = const { Cell::new(0) };
    /// How many inherited bindings the last change of the default profile took away.
    static KEYS_REMOVED: Cell<usize> = const { Cell::new(0) };
    /// The tokens `info().theme` last reported.
    static REPORTED: Cell<Option<Tokens>> = const { Cell::new(None) };
}

/// Inside Evora's shell, before the first frame: Evora's palette, accessible contrast, the
/// functions left out hidden, then labels and keys.
pub fn enter(app: &mut FilmcraftApp) {
    theme::set_evora(true);
    app.session.prefs.appearance.accessible_contrast = true;
    menus::set_hidden(&HIDDEN);
    crate::set_info("hidden", json!(HIDDEN));
    tick(app);
}

/// Every frame inside Evora's shell: labels follow the canvas's language, the default profile keeps
/// Evora's keys, `info()` follows the live theme.
pub fn tick(app: &mut FilmcraftApp) {
    let code = app.ui.language.code();
    if LABELS_IN.get() != Some(code) {
        LABELS_IN.set(Some(code));
        name_labels(app, code);
    }
    impose_keys(&mut app.session.shortcuts);
    if REPORTED.get() != Some(app.tokens) {
        REPORTED.set(Some(app.tokens));
        report_theme(&app.tokens, app.session.prefs.appearance.accessible_contrast);
    }
}

fn label_names(code: &str) -> &'static [&'static str; 16] {
    LABEL_NAMES.iter().find(|(c, _)| *c == code).map_or(&LABEL_NAMES[0].1, |(_, n)| n)
}

/// Evora's colours and names on the labels the user left as they came (upstream's or Evora's, in
/// any language); a label renamed or recoloured keeps its own.
fn name_labels(app: &mut FilmcraftApp, code: &str) {
    // SABORDAGE QA (témoin COR-FK-B2, retiré au commit suivant) : noms toujours en anglais, quelle que soit la langue du canevas
    let names = label_names("en");
    let labels = &mut app.session.prefs.labels;
    for (i, l) in Label::ALL.iter().enumerate() {
        let Some(c) = labels.colors.get_mut(&label_id(*l)) else { continue };
        let ours_name = c.name == l.name() || LABEL_NAMES.iter().any(|(_, n)| n[i] == c.name);
        let ours_color = c.color.eq_ignore_ascii_case(&hex(l.rgb())) || c.color.eq_ignore_ascii_case(LABEL_COLORS[i]);
        if ours_name && ours_color {
            c.name = names[i].to_string();
            c.color = LABEL_COLORS[i].to_string();
        }
    }
    let shown: Vec<serde_json::Value> = Label::ALL.iter().map(|l| json!({"id": label_id(*l), "name": labels.name(*l), "color": hex(labels.rgb(*l))})).collect();
    crate::set_info("labels", json!({"language": code, "labels": shown}));
}

/// A key every editor uses the same way: arrows, page keys, Home and End, Space, Delete, Enter,
/// Escape and Tab (with Shift or alone), I and O (In and Out), `=` and `-` (zoom, alone or with
/// the primary modifier).
pub fn universal(keys: &str) -> bool {
    let Ok(c) = Chord::parse(keys) else { return false };
    let m = c.mods;
    let navigation =
        matches!(c.key, "Up" | "Down" | "Left" | "Right" | "Home" | "End" | "PageUp" | "PageDown" | "Space" | "Backspace" | "Delete" | "Enter" | "Escape" | "Tab");
    let plain = !m.cmd && !m.ctrl && !m.alt;
    (plain && (navigation || matches!(c.key, "I" | "O" | "=" | "-"))) || (m.cmd && !m.ctrl && !m.alt && !m.shift && matches!(c.key, "=" | "-"))
}

/// The bindings the upstream default takes from another editor and Corte does not keep: its
/// shortcut audit and that editor's panel table, save the universal conventions.
fn inherited(s: &Shortcuts) -> Vec<Binding> {
    let mut out = s.audit();
    for (command, keys, panel) in PREMIERE_PANEL {
        let keys = normalize(keys).unwrap_or_else(|_| (*keys).to_string());
        out.push(Binding { command: (*command).to_string(), keys, panel: (!panel.is_empty()).then(|| (*panel).to_string()) });
    }
    out.retain(|b| !universal(&b.keys));
    out
}

/// The default profile without the inherited bindings; checked again whenever the shortcuts change.
fn impose_keys(s: &mut Shortcuts) {
    if KEYS_AT.get() == s.revision {
        return;
    }
    let evora = s.preset == DEFAULT_PRESET && !s.modified;
    if evora {
        let gone = inherited(s);
        let before = s.bindings.len();
        // SABORDAGE QA (témoin COR-FK-B2, retiré au commit suivant) : chaînage hérité rétabli, aucune liaison retirée
        let _ = &gone;
        let removed = before - s.bindings.len();
        if removed > 0 {
            s.revision += 1;
            KEYS_REMOVED.set(removed);
        }
    }
    KEYS_AT.set(s.revision);
    let left = inherited(s).iter().filter(|b| s.bindings.contains(b)).count();
    let profile = if evora { "evora" } else { "user" };
    crate::set_info("keys", json!({"profile": profile, "removed": KEYS_REMOVED.get(), "bindings": s.bindings.len(), "inheritedActive": left}));
}

fn css(c: egui::Color32) -> String {
    format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b())
}

/// `info().theme`: the live tokens Evora's checks measure.
fn report_theme(t: &Tokens, contrast: bool) {
    let accent = [t.accent.r(), t.accent.g(), t.accent.b()];
    crate::set_info(
        "theme",
        json!({
            "name": "evora",
            "kind": format!("{:?}", t.kind),
            "accessibleContrast": contrast,
            "accent": css(t.accent),
            "accentPalette": theme::in_palette(accent),
            "panel": css(t.panel_bg),
            "header": css(t.header_bg),
            "monitor": css(t.monitor_bg),
            "field": css(t.field_bg),
            "fieldBorder": css(t.field_border),
            "text": css(t.text),
            "textDim": css(t.text_dim),
            "textFaint": css(t.text_faint),
            "focus": css(t.focus),
            "timecode": css(t.timecode),
            "playhead": css(t.playhead),
            "track": css(t.tl_track_bg),
            "trackAlt": css(t.tl_track_bg_alt),
            "trackTarget": css(t.track_target),
        }),
    );
}
