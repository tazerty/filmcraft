//! FilmCraft in the browser.
//!
//! The same engine and egui UI as the desktop app, compiled to `wasm32-unknown-unknown` and run
//! by eframe's web runner on WebGPU (WebGL2 fallback). What the desktop shell gets from the OS,
//! this crate gets from the browser:
//!
//! | Desktop | Web ([module]) |
//! |---|---|
//! | file system ([`filmcraft_engine::FsServices`]) | virtual file table of `File`/`Blob`s with chunked range reads, downloads ([`fs`]) |
//! | file dialogs (rfd) | `<input type=file>` / File System Access pickers, drag-and-drop ([`import`]) |
//! | auto-save + recovery journal (data dir) | OPFS snapshot + media copies ([`recovery`], [`opfs`]) |
//! | cpal audio output | WebAudio `AudioWorklet`, played-frame clock ([`audio`]) |
//! | VideoToolbox… | WebCodecs `VideoDecoder` ([`webcodecs`]) |
//! | frame worker threads | cooperative frame queue pumped between UI frames (`FrameServer::pump`) |
//! | TCP control channel / MCP | `window.filmcraft` JavaScript API ([`api`]) |
//!
//! Everything here is `wasm32`-only; on other targets the crate is empty.
#![cfg(target_arch = "wasm32")]
#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable))]

pub mod api;
pub mod audio;
pub mod download_pacing;
pub mod fs;
pub mod import;
pub mod opfs;
pub mod recovery;
pub mod recovery_policy;
pub mod webcodecs;

use std::cell::RefCell;
use std::sync::Arc;

use filmcraft_engine::Session;
use filmcraft_ui_egui::FilmcraftApp;
use serde_json::json;
use wasm_bindgen::prelude::*;

/// Work for the UI thread with access to the app (posted by async tasks and the JS API).
pub type Action = Box<dyn FnOnce(&mut WebApp, &egui::Context)>;

thread_local! {
    static ACTIONS: RefCell<Vec<Action>> = const { RefCell::new(Vec::new()) };
    static CTX: RefCell<Option<egui::Context>> = const { RefCell::new(None) };
    static INFO: RefCell<serde_json::Value> = const { RefCell::new(serde_json::Value::Null) };
}

/// Run `f` on the UI thread at the next frame.
pub fn post(f: impl FnOnce(&mut WebApp, &egui::Context) + 'static) {
    ACTIONS.with(|a| a.borrow_mut().push(Box::new(f)));
    repaint();
}

/// Ask for a UI frame.
pub fn repaint() {
    CTX.with(|c| {
        if let Some(c) = c.borrow().as_ref() {
            c.request_repaint();
        }
    });
}

/// Give a host that builds its own [`WebApp`] the egui context that [`post`] and [`repaint`] wake.
/// [`start`] calls it; an embedding app that runs `WebApp` in its own eframe runner calls it once
/// from its app creator, or posted actions and JS API requests wait for the next input event.
pub fn set_context(ctx: egui::Context) {
    CTX.with(|c| *c.borrow_mut() = Some(ctx));
}

/// Environment facts reported by `filmcraft.info()` (backend, isolation, codecs…).
pub fn set_info(key: &str, v: serde_json::Value) {
    INFO.with(|i| {
        let mut i = i.borrow_mut();
        if !i.is_object() {
            *i = json!({});
        }
        i[key] = v;
    });
}

pub fn info() -> serde_json::Value {
    INFO.with(|i| i.borrow().clone())
}

/// The eframe app: the shared FilmCraft UI plus the web host's per-frame duties.
pub struct WebApp {
    pub app: FilmcraftApp,
    pub audio: Option<audio::Handle>,
    pub autosave: recovery::Autosave,
}

impl eframe::App for WebApp {
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        self.app.raw_input_hook(ctx, raw_input);
    }

    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        let actions = ACTIONS.with(|a| std::mem::take(&mut *a.borrow_mut()));
        for f in actions {
            f(self, ctx);
        }
        self.app.logic(ctx, frame);
        api::poll_replies();
        // exports advance between frames (no threads)
        if self.app.session.pump_jobs(std::time::Duration::from_millis(30)) {
            ctx.request_repaint();
        }
        if let Some(a) = &self.audio {
            a.pump();
        }
        self.autosave.tick(&self.app.session, ctx);
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.app.ui(ui, frame);
        drop_open_urls(ui.ctx());
    }
}

/// Evora fork (patch E7): no URL is ever opened from the canvas (egui hyperlinks such as the
/// About ▸ Contributors names, `file://` reveals, any `open_url` fallback). The commands of this
/// frame are dropped before eframe acts on them; the shell owns links to the outside.
fn drop_open_urls(ctx: &egui::Context) {
    ctx.output_mut(|o| {
        o.commands.retain(|c| match c {
            egui::OutputCommand::OpenUrl(u) => {
                log::info!("external link not opened (Evora): {}", u.url);
                false
            }
            _ => true,
        })
    });
}

fn query_flag(name: &str) -> bool {
    web_sys::window().and_then(|w| w.location().search().ok()).and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok()).is_some_and(|p| p.has(name))
}

/// The value of the page's `?name=` parameter, if any.
fn query_value(name: &str) -> Option<String> {
    web_sys::window().and_then(|w| w.location().search().ok()).and_then(|s| web_sys::UrlSearchParams::new_with_str(&s).ok()).and_then(|p| p.get(name))
}

/// Evora's accent colour (indigo).
const EVORA_ACCENT: &str = "#4f46e5";

/// Evora fork (patch E2): Evora's look without touching the theme module. The indigo accent becomes
/// the highlight colour (it also recolours focus, playhead, timecode and track targeting), and the
/// shell's light or dark appearance applies with `?theme=light|dark|auto` (dark without it, as
/// upstream). The interface font is already Inter.
fn apply_evora_theme(app: &mut FilmcraftApp) {
    let mut set = |key: &str, value: &str| {
        if let Err(e) = app.session.execute("prefs.set", json!({"key": key, "value": value})) {
            log::warn!("{key}: {e}");
        }
    };
    set("appearance.highlightColor", EVORA_ACCENT);
    let mode = query_value("theme").filter(|t| matches!(t.as_str(), "light" | "dark" | "auto"));
    if let Some(m) = &mode {
        set("appearance.appearanceMode", m.as_str());
    }
    set_info("theme", json!({"accent": EVORA_ACCENT, "mode": mode}));
}

/// Evora fork (patch E3): the interface language Evora's shell imposes with `?lang=`, whatever
/// the saved preference. Unknown or undecided languages (`pt`, D-23) keep the canvas in English;
/// Japanese and Chinese still need a font (otherwise the engine stays in English and says so).
fn impose_language(app: &mut FilmcraftApp) {
    let Some(tag) = query_value("lang") else { return };
    let code = filmcraft_ui_egui::i18n::Language::from_evora(&tag).map_or("en", |l| l.code());
    if let Err(e) = app.session.execute("prefs.set", json!({"key": "general.interfaceLanguage", "value": code})) {
        log::warn!("language {code}: {e}");
    }
    set_info("language", json!({"requested": tag, "applied": code}));
}

/// Entry point (called by the page's bootstrap script once the wasm module is instantiated).
#[wasm_bindgen]
pub async fn start(canvas_id: String) -> Result<(), JsValue> {
    eframe::WebLogger::init(log::LevelFilter::Info).ok();
    let t0 = web_time::Instant::now();
    let doc = web_sys::window().and_then(|w| w.document()).ok_or("no document")?;
    let canvas: web_sys::HtmlCanvasElement = doc.get_element_by_id(&canvas_id).ok_or("no canvas")?.dyn_into()?;

    let isolated = js_sys::Reflect::get(&js_sys::global(), &"crossOriginIsolated".into()).ok().and_then(|v| v.as_bool()).unwrap_or(false);
    // Frame rendering runs cooperatively on this thread. wasm threads need a cross-origin
    // isolated page *and* a build with atomics (nightly `build-std`); this build has none.
    set_info("crossOriginIsolated", json!(isolated));
    set_info("threads", json!(false));
    set_info("frameWorkers", json!("cooperative"));
    // Evora fork (patch E5): inside Evora's shell (`?host=evora`), OPFS stays closed until
    // `evora:init` names the account's storage namespace; the URL never names it. Nothing kept by an
    // earlier session (possibly another account's) is read back at start-up.
    let hosted = query_value("host").as_deref() == Some("evora");
    if hosted {
        opfs::enter_host_mode();
    }
    set_info("storage", json!(opfs::describe()));
    set_info("opfs", json!(opfs::available()));

    // Media kept in OPFS by earlier sessions come back under their paths (recovery).
    let restored = if !hosted && opfs::available() && !query_flag("fresh") { recovery::restore_media().await } else { 0 };
    let recovered = if hosted || query_flag("fresh") || query_flag("norecover") { None } else { recovery::load_snapshot().await };
    webcodecs::probe().await;

    api::install()?;
    import::install_drop_handlers()?;

    let demo = !query_flag("empty");
    let mut web_options = eframe::WebOptions::default();
    // `?webgl`: WebGL2 only. The page reloads with it when starting on WebGPU fails (an adapter
    // whose device can't be created, a driver the browser rejects…); see `index.html`.
    if query_flag("webgl")
        && let eframe::egui_wgpu::WgpuSetup::CreateNew(c) = &mut web_options.wgpu_options.wgpu_setup
    {
        c.instance_descriptor.backends = eframe::wgpu::Backends::GL;
    }
    let runner = eframe::WebRunner::new();
    runner
        .start(
            canvas,
            web_options,
            Box::new(move |cc| {
                set_context(cc.egui_ctx.clone());
                let ctx = cc.egui_ctx.clone();
                fs::set_on_data(move || ctx.request_repaint());
                fs::set_on_write(|path, data| {
                    if let Err(e) = fs::download(path, data) {
                        log::warn!("download {path}: {e:?}");
                    }
                });
                webcodecs::install();
                let mut session = Session::new(Arc::new(fs::WebServices));
                let mut toast = None;
                if let Some((name, bytes)) = recovered {
                    let path = format!("/recovered/{name}");
                    fs::put(&path, bytes);
                    match session.execute("file.open", json!({"path": path})) {
                        Ok(_) => {
                            // the recovered changes are unsaved
                            session.saved_revision = 0;
                            toast = Some(format!("Recovered unsaved changes to {name}"));
                        }
                        Err(e) => log::warn!("recovery failed: {e}"),
                    }
                } else if demo {
                    let _ = session.execute("file.openDemoProject", json!({}));
                }
                let mut app = FilmcraftApp::new(session);
                import::install_hooks(&mut app);
                impose_language(&mut app);
                apply_evora_theme(&mut app);
                // Settings ▸ General ▸ Interface Language ▸ System Language (#218): the browser's languages.
                app.hooks.system_languages =
                    Some(Box::new(|| web_sys::window().map(|w| w.navigator().languages().iter().filter_map(|v| v.as_string()).collect()).unwrap_or_default()));
                let (tx, rx) = std::sync::mpsc::channel();
                api::set_sender(tx);
                app = app.with_control(rx);
                if let Some(t) = toast {
                    app.status(t);
                }
                let backend = cc.wgpu_render_state.as_ref().map(|rs| rs.adapter.get_info().backend);
                set_info("backend", json!(backend.map(|b| format!("{b:?}"))));
                // The GPU compositor needs float render targets everywhere: WebGPU only (WebGL2
                // composites on the CPU).
                if let Some(rs) = cc.wgpu_render_state.clone()
                    && backend == Some(eframe::wgpu::Backend::BrowserWebGpu)
                    && !query_flag("cpu")
                {
                    app.set_wgpu(rs);
                    set_info("compositor", json!("gpu"));
                } else {
                    set_info("compositor", json!("cpu"));
                }
                let audio = audio::Handle::new();
                if let Some(a) = &audio {
                    app.audio = Some(Box::new(a.clone()));
                }
                set_info("audio", json!(audio.is_some()));
                set_info("restoredMedia", json!(restored));
                Ok(Box::new(WebApp { app, audio, autosave: recovery::Autosave::default() }))
            }),
        )
        .await?;
    set_info("startupMs", json!(t0.elapsed().as_secs_f64() * 1000.0));
    // keep the runner alive for the page's lifetime
    std::mem::forget(runner);
    if let Some(el) = doc.get_element_by_id("loading") {
        el.remove();
    }
    Ok(())
}
