//! The product wordmark, drawn on the About dialog and the Home screen.
//!
//! Evora fork (patch E1): the ArtCraft wordmark is a trademark that is not open source, and the
//! ArtCraft trademark licence requires a modified version to remove it (docs/brand/LICENSE-brand.txt,
//! "Forks and modified versions"). This build embeds no wordmark: [`wordmark`] returns `None` and
//! callers lay out their text without it. The files in `docs/brand/` stay in the repository (a copy
//! of the repository may keep them) but are no longer compiled into any binary.

/// The wordmark for a dark (`dark = true`) or light UI. This build has none.
pub fn wordmark(_ctx: &egui::Context, _dark: bool) -> Option<egui::TextureHandle> {
    None
}

/// Draw the wordmark `height` points tall with its left edge at `left_center` (vertically centred).
/// Returns the drawn rect, or `None` when there is no wordmark to draw (always, in this build).
pub fn paint_wordmark(ui: &egui::Ui, left_center: egui::Pos2, height: f32, dark: bool) -> Option<egui::Rect> {
    let tex = wordmark(ui.ctx(), dark)?;
    let [w, h] = tex.size();
    let width = height * w as f32 / h.max(1) as f32;
    let r = egui::Rect::from_min_size(egui::pos2(left_center.x, left_center.y - height / 2.0), egui::vec2(width, height));
    ui.painter().image(tex.id(), r, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
    Some(r)
}
