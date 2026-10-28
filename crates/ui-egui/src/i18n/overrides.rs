//! Evora fork (patches E10 and E9): the display override catalog, `overrides.tsv`.
//!
//! [`Language::tr`](super::Language::tr) looks a string up here before the upstream catalog of the
//! language, and falls back to the English override before the source text itself. The upstream
//! catalogs stay untouched (they rebase cleanly); only what the interface displays changes: no
//! emoji or pictograph (E10), and neutral names instead of third-party product names (E9).
//!
//! Patch COR-FK-B2 (Q10): the app's name. Whatever the language, a displayed string that names the
//! upstream app ([`UPSTREAM_NAME`]) names Corte instead ([`rename`], applied by `Language::tr` after
//! the lookup). Identifiers, the `window.filmcraft` API, file formats and the licence files (never
//! drawn through `tr`) keep the upstream name.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::OnceLock;

/// The upstream app's name, as the catalogs write it.
pub const UPSTREAM_NAME: &str = "FilmCraft";
/// The name this build shows instead.
pub const SHOWN_NAME: &str = "Corte";

thread_local! {
    /// Displayed text → the same text with Corte's name, made once per text (the interface asks
    /// for the same strings every frame).
    static RENAMED: RefCell<HashMap<String, &'static str>> = RefCell::new(HashMap::new());
}

/// `text` as this build shows it: with Corte's name instead of the upstream app's. Text without
/// the upstream name (almost all) comes back as it is, without a lookup.
pub fn rename(text: &str) -> &str {
    if !text.contains(UPSTREAM_NAME) {
        return text;
    }
    RENAMED.with(|cache| -> &'static str {
        let mut cache = cache.borrow_mut();
        if let Some(&shown) = cache.get(text) {
            return shown;
        }
        let shown: &'static str = Box::leak(text.replace(UPSTREAM_NAME, SHOWN_NAME).into_boxed_str());
        cache.insert(text.to_string(), shown);
        shown
    })
}

/// Source text → [(language code, text to display)].
type Table = HashMap<String, Vec<(String, String)>>;

static TABLE: OnceLock<Table> = OnceLock::new();

fn table() -> &'static Table {
    TABLE.get_or_init(|| {
        let mut t: Table = HashMap::new();
        for (lang, src, display) in super::catalog::parse_entries(include_str!("overrides.tsv")).0 {
            t.entry(src).or_default().push((lang, display));
        }
        t
    })
}

/// The overrides of `text`: for the language `code` (`Language::code`), and for English. One hash
/// lookup on the source; strings without an override (almost all) return `(None, None)`.
pub fn lookup(code: &str, text: &str) -> (Option<&'static str>, Option<&'static str>) {
    match table().get(text) {
        None => (None, None),
        Some(v) => {
            let find = |l: &str| v.iter().find(|(c, _)| c == l).map(|(_, d)| d.as_str());
            (find(code), find("en"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Language, catalog};
    use super::UPSTREAM_NAME;

    /// Emoji and pictographs the interface must not display (Evora rule "zéro émoji d'interface"):
    /// Miscellaneous Symbols and Dingbats (✓ ✔ ✖ ⚠ ⚡ ⚙ ★ ♪…), pictographs U+1F000–1FAFF, symbols
    /// U+2B00–2BFF, emoji presentation selector, keycap, and the emoji-capable triangles ▶ ◀.
    fn is_emoji(c: char) -> bool {
        let o = c as u32;
        (0x2600..=0x27BF).contains(&o)
            || (0x1F000..=0x1FAFF).contains(&o)
            || (0x2B00..=0x2BFF).contains(&o)
            || [0xFE0F, 0x20E3, 0x3030, 0x303D, 0x3297, 0x3299, 0x25B6, 0x25C0, 0x231A, 0x231B].contains(&o)
            || (0x23E9..=0x23F3).contains(&o)
            || (0x23F8..=0x23FA).contains(&o)
    }

    fn upstream_catalogs() -> Vec<(&'static str, &'static str)> {
        vec![
            ("es", include_str!("es.tsv")),
            ("ja", include_str!("ja.tsv")),
            ("pt-br", include_str!("pt-br.tsv")),
            ("uk", include_str!("uk.tsv")),
            ("zh-cn", include_str!("zh-cn.tsv")),
            ("de", include_str!("de.tsv")),
            ("ru", include_str!("ru.tsv")),
            ("fr", include_str!("fr.tsv")),
            ("id", include_str!("id.tsv")),
            // catalogs added upstream in v0.9.0 (D-19 upgrade, EVORA-COR-26)
            ("it", include_str!("it.tsv")),
            ("ko", include_str!("ko.tsv")),
        ]
    }

    /// Every English source the interface can ask for: the keys of every upstream catalog (the
    /// Spanish one alone covers every `tl!` literal and every menu label, which upstream tests
    /// enforce).
    fn all_sources() -> Vec<String> {
        let mut keys: Vec<String> = upstream_catalogs().into_iter().flat_map(|(_, text)| catalog::parse_entries(text).0.into_iter().map(|(_, en, _)| en)).collect();
        keys.sort();
        keys.dedup();
        keys
    }

    #[test]
    fn overrides_are_well_formed() {
        let (entries, errors) = catalog::parse_entries(include_str!("overrides.tsv"));
        assert!(errors.is_empty(), "{errors:?}");
        assert!(!entries.is_empty());
        let codes: Vec<&str> = Language::ALL.iter().map(|l| l.code()).collect();
        let engine = engine_sources();
        for (i, (lang, src, display)) in entries.iter().enumerate() {
            assert!(codes.contains(&lang.as_str()), "unknown language {lang:?} for {src:?}");
            assert!(entries.iter().take(i).all(|(l, s, _)| (l, s) != (lang, src)), "duplicate override {lang} {src:?}");
            let (mut a, mut b) = (catalog::placeholders(src), catalog::placeholders(display));
            a.sort_unstable();
            b.sort_unstable();
            assert_eq!(a, b, "{lang}: placeholders differ in {src:?} → {display:?}");
            assert_eq!(src.ends_with('…'), display.ends_with('…'), "{lang}: ellipsis differs in {src:?} → {display:?}");
            // every overridden source has an English override, shown where no translation exists
            assert!(entries.iter().any(|(l, s, _)| l == "en" && s == src), "no English override for {src:?}");
            // and is a string the interface really asks for (no dead override)
            assert!(Language::ALL.iter().any(|l| l.has(src)) || engine.contains(src), "override of a string nothing displays: {src:?}");
        }
    }

    /// English strings the engine hands to `i18n::t` without any upstream catalog entry: command
    /// labels (keyboard shortcuts editor), built-in shortcut presets (shortcuts editor) and the
    /// history label of `lumetri.setSection` (crates/engine/src/color.rs, History panel).
    fn engine_sources() -> Vec<String> {
        let mut out: Vec<String> = filmcraft_engine::Session::default()
            .execute("command.list", serde_json::json!({}))
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|c| c["label"].as_str().map(str::to_string))
            .collect();
        out.extend(filmcraft_engine::shortcuts::BUILTIN_PRESETS.iter().map(|p| p.to_string()));
        out.push("Lumetri Section".into());
        out
    }

    /// Third-party product names the interface must not display (D-16), matched as words.
    fn sensitive(text: &str) -> Option<&'static str> {
        let lower = text.to_lowercase();
        [
            "lumetri",
            "lightroom",
            "acrobat",
            "premiere",
            "adobe",
            "cycore",
            // patch COR-FK-B2: E9 completed (panels, effects, a transition, shortcut presets)
            "essential graphics",
            "essential sound",
            "warp stabilizer",
            "ultra key",
            "morph cut",
            "media composer",
            "final cut pro compatible",
        ]
        .into_iter()
        .find(|t| {
            lower.match_indices(t).any(|(i, _)| {
                let before = lower[..i].chars().next_back();
                let after = lower[i + t.len()..].chars().next();
                !before.is_some_and(char::is_alphabetic) && !after.is_some_and(char::is_alphabetic)
            })
        })
    }

    /// E9, checked on the strings as `Language::tr` returns them, in every language, for every
    /// catalog key and every engine string shown through `i18n::t`.
    #[test]
    fn no_sensitive_term_is_displayed_in_any_language() {
        let mut sources = all_sources();
        sources.extend(engine_sources());
        let mut shown: Vec<String> = Vec::new();
        for lang in Language::ALL {
            for src in &sources {
                let text = lang.tr(src);
                if let Some(t) = sensitive(text) {
                    shown.push(format!("{} [{t}]: {src:?} → {text:?}", lang.code()));
                }
                // Q10 (patch COR-FK-B2): the upstream app's name is never shown
                if text.contains(UPSTREAM_NAME) {
                    shown.push(format!("{} [{UPSTREAM_NAME}]: {src:?} → {text:?}", lang.code()));
                }
            }
        }
        assert!(shown.is_empty(), "sensitive terms displayed: {shown:#?}");
        // matched as words: "Volumetric Rays" is not "Lumetri"
        assert_eq!(sensitive("Volumetric Rays"), None);
        assert_eq!(sensitive("Lumetri-Farbe"), Some("lumetri"));
        assert_eq!(sensitive("Ultra Keyframes"), None);
        assert_eq!(sensitive("The Morph Cut transition"), Some("morph cut"));
    }

    /// Q10 (patch COR-FK-B2): the app is called Corte on screen, in every language.
    #[test]
    fn the_app_is_called_corte_on_screen() {
        assert_eq!(Language::En.tr("About FilmCraft"), "About Corte");
        assert_eq!(Language::En.tr("Quit FilmCraft"), "Quit Corte");
        for lang in Language::ALL {
            let about = lang.tr("About FilmCraft");
            assert!(!about.contains(UPSTREAM_NAME) && about.contains(super::SHOWN_NAME), "{}: {about:?}", lang.code());
        }
        // text without the name is returned as it is; renamed text is made once
        assert_eq!(super::rename("File"), "File");
        assert!(std::ptr::eq(super::rename("FilmCraft Project"), super::rename("FilmCraft Project")));
        assert_eq!(super::rename("FilmCraft Project"), "Corte Project");
    }

    #[test]
    fn overrides_win_over_catalogs_and_fall_back_to_english() {
        assert_eq!(Language::En.tr("✓ Enable"), "Enable (on)");
        assert_eq!(Language::Fr.tr("✔ matches"), "Correspond");
        assert_eq!(Language::Es.tr("✖ different file"), "Archivo distinto");
        // German has its own entry since the complete upstream catalog (v0.13.0, EVORA-COR-28)
        assert_eq!(Language::De.tr("✓ Enable"), "Aktivieren (an)");
        // no Indonesian entry for this string in the overrides: the catalog's own text, or else the
        // corrected English text, never the raw source
        assert!(!Language::Id.tr("✓ Enable").contains('✓'));
        // everything else is unchanged
        assert_eq!(Language::Es.tr("File"), "Archivo");
        assert_eq!(Language::En.tr("File"), "File");
        assert_eq!(Language::Fr.tr("An untranslated label"), "An untranslated label");
        // E9: neutral names, translated where the upstream catalog translates the string
        assert_eq!(Language::En.tr("Lumetri Color"), "Color Grading");
        assert_eq!(Language::Fr.tr("Lumetri Scopes"), "Oscilloscopes vidéo");
        assert_eq!(Language::Ru.tr("Lumetri Color"), "Цветокоррекция");
        assert_eq!(Language::De.tr("Lumetri Presets"), "Farbgradierungs-Vorgaben");
        assert_eq!(Language::Ja.tr("Premiere Pro Compatible"), "Standard NLE Layout");
        // patch COR-FK-B2: E9 completed, a name of Corte's own where the catalog kept the product's
        assert_eq!(Language::En.tr("Essential Graphics"), "Graphics Editor");
        assert_eq!(Language::De.tr("Essential Sound"), "Audio-Assistent");
        assert_eq!(Language::Fr.tr("Ultra Key"), "Incrustation chromatique");
        assert_eq!(Language::Ru.tr("Warp Stabilizer"), "Стабилизатор");
        assert_eq!(Language::Id.tr("Morph Cut"), "Potongan Lompat Halus");
        assert_eq!(Language::Es.tr("Avid Media Composer Compatible"), "Alternative Layout B");
    }

    /// E10, checked on the strings as `Language::tr` returns them, in every language.
    #[test]
    fn no_emoji_is_displayed_in_any_language() {
        let sources = all_sources();
        let mut shown: Vec<String> = Vec::new();
        for lang in Language::ALL {
            for src in &sources {
                let text = lang.tr(src);
                if text.chars().any(is_emoji) {
                    shown.push(format!("{}: {src:?} → {text:?}", lang.code()));
                }
            }
        }
        // strings with a context (tr_ctx) are not overridden: they must be clean in the catalogs
        for (code, text) in upstream_catalogs() {
            for (ctx, src, tr) in catalog::parse_entries(text).0 {
                if !ctx.is_empty() && tr.chars().any(is_emoji) {
                    shown.push(format!("{code} [{ctx}]: {src:?} → {tr:?}"));
                }
            }
        }
        assert!(shown.is_empty(), "emoji displayed: {shown:#?}");
    }
}
