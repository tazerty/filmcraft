//! Evora fork (patch COR-FK-B1): the way out of the engine at the keyboard (capability
//! `ui.focus-out`, amendment A-19 of Evora's HOST-PROTOCOL §7.9; same design as Lumbra's LUM-13).
//!
//! The egui canvas takes the focus and consumes Tab, Shift+Tab and Escape: without a way out the
//! editor would trap the keyboard (WCAG 2.1.2). In mode B the host shell cannot listen inside the
//! engine's document, so the engine itself gives the focus back: with `ui.focus-out` effective,
//! F6 without a modifier (the shell's own exit key in mode A, Q-15-13) is held back from the
//! canvas, before any listener of the page (capture on the window), and the engine sends
//! `evora:focus-out {}`; the shell moves the focus to « Leave the editor ». A held key sends once.
//! Without the capability, F6 is left alone.

use wasm_bindgen::{JsCast as _, closure::Closure};

/// The key that hands the keyboard back to the shell.
const EXIT_KEY: &str = "F6";

/// Listen for the exit key on the engine's window, in the capture phase.
pub fn listen() {
    let Some(window) = web_sys::window() else { return };
    let on_key = Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(move |e: web_sys::KeyboardEvent| {
        if e.key() != EXIT_KEY || e.alt_key() || e.ctrl_key() || e.meta_key() || e.shift_key() || !crate::ehp::has("ui.focus-out") {
            return;
        }
        // Neither the canvas nor the browser sees it: the key belongs to the shell.
        e.prevent_default();
        e.stop_immediate_propagation();
        // SABORDAGE QA (témoin FOCUS-OUT, COR-FK-B1) : la touche est retenue, rien n'est envoyé
        let _ = e.repeat();
    });
    let listener: &js_sys::Function = on_key.as_ref().unchecked_ref();
    let down = window.add_event_listener_with_callback_and_bool("keydown", listener, true).is_ok();
    let up = window.add_event_listener_with_callback_and_bool("keyup", listener, true).is_ok();
    if down || up {
        // The listener lives as long as the page.
        on_key.forget();
    } else {
        log::warn!("filmcraft-web: the exit key (F6) could not be listened for");
    }
}
