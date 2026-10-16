//! Origin Private File System (OPFS): auto-save / crash recovery and the media copies that let a
//! recovered project find its media after a reload.
//!
//! Writes are queued and coalesced per path (the newest bytes win) and run one at a time.
//!
//! Evora fork (patch E5): inside Evora's shell (`?host=evora`), every path lives under
//! `evora-corte/<storageNs>/`, the namespace the shell gives in `evora:init` (module `ehp`): never
//! from the URL. Until then, and for good once a purge has started, OPFS is closed: nothing is read,
//! written or created. A purge first closes OPFS (queued writes are dropped, writes under way end),
//! then removes what it targets, then checks it is gone.
//!
//! Across tabs: every write and every purge holds one lock of the origin ([`LOCK`], Web Locks API),
//! so a purge in one tab waits for a write under way in another (an open writable makes the removal
//! fail) and no write starts during a purge. The namespace directory is created once, by
//! `evora:init`; a write never creates it again: one that finds it gone (purged from another tab,
//! after an account change) fails and closes OPFS for good.
//!
//! It is a namespace, not a partition: any script of this origin can still list the whole OPFS, and
//! isolation between accounts comes from serving the engine on its own origin. Without
//! `?host=evora`, paths live at the OPFS root, as upstream (only the lock is added).

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{FileSystemDirectoryHandle, FileSystemFileHandle};

/// Called with whether a queued write reached OPFS.
pub type Done = Box<dyn FnOnce(bool)>;

/// Evora fork (patch E5): where paths live.
#[derive(Clone)]
enum Scope {
    /// Upstream: the OPFS root of this origin.
    Root,
    /// Inside Evora: before `evora:init` names the namespace, and for good after a purge.
    Closed,
    /// Inside Evora: `ENGINE_DIR/<storageNs>/`.
    Namespace(String),
}

thread_local! {
    /// Pending writes per path (bytes and the callbacks of every write coalesced into them), and
    /// whether the writer task is running.
    static QUEUE: RefCell<(BTreeMap<String, (Vec<u8>, Vec<Done>)>, bool)> = const { RefCell::new((BTreeMap::new(), false)) };
    static SCOPE: RefCell<Scope> = const { RefCell::new(Scope::Root) };
    /// A purge has started: OPFS stays closed for the rest of the page's life.
    static SEALED: Cell<bool> = const { Cell::new(false) };
    /// OPFS operations under way (they may hold handles below the root).
    static ACTIVE: Cell<u32> = const { Cell::new(0) };
    /// A purge is under way.
    static PURGING: Cell<bool> = const { Cell::new(false) };
}

/// Evora fork (patch E5): the directory of this engine's namespaces at the OPFS root (Evora serves
/// its engines from one origin: each keeps to its own directory).
pub const ENGINE_DIR: &str = "evora-corte";
/// What upstream and Evora's lab dialect leave at the OPFS root, outside any namespace: the recovery
/// snapshot, the media copies, the lab's saves.
pub const LEFTOVERS: [&str; 3] = ["recovery", "media", "evora-lab"];
/// Milliseconds between two looks at the writes a purge waits for.
const DRAIN_POLL_MS: i32 = 5;
/// Evora fork (patch E5): the lock (Web Locks API) every OPFS write and purge of this engine holds,
/// in every tab of the origin.
pub const LOCK: &str = "evora-corte-opfs";

/// Marks an OPFS operation as under way while it lives (a purge waits for none to be left).
struct Busy;

impl Busy {
    fn enter() -> Self {
        ACTIVE.set(ACTIVE.get().saturating_add(1));
        Busy
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        ACTIVE.set(ACTIVE.get().saturating_sub(1));
    }
}

/// Evora fork (patch E5): the page runs inside Evora's shell; OPFS is closed until `evora:init`.
pub fn enter_host_mode() {
    SCOPE.with(|s| *s.borrow_mut() = Scope::Closed);
}

/// Evora fork (patch E5): whether the page runs inside Evora's shell.
pub fn hosted() -> bool {
    SCOPE.with(|s| !matches!(*s.borrow(), Scope::Root))
}

fn closed() -> bool {
    SCOPE.with(|s| matches!(*s.borrow(), Scope::Closed))
}

/// Evora fork (patch E5): a storage namespace as `evora:init` gives it, 64 lowercase hex digits.
pub fn valid_namespace(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Evora fork (patch E5): open OPFS under `ENGINE_DIR/<ns>/` (`evora:init`), creating that directory
/// now, under [`LOCK`]: no write creates it again. Refused outside Evora's shell, for an invalid
/// namespace, once a purge has started, and when the directory can't be created.
pub async fn open_namespace(ns: &str) -> bool {
    if SEALED.get() || !hosted() || !valid_namespace(ns) {
        return false;
    }
    if browser_has_opfs() {
        let _lock = origin_lock().await;
        if let Err(e) = namespace_dir(ns, true).await {
            log::warn!("OPFS namespace: {e:?}");
            return false;
        }
    }
    if SEALED.get() {
        return false;
    }
    SCOPE.with(|s| *s.borrow_mut() = Scope::Namespace(ns.to_string()));
    true
}

/// Evora fork (patch E5): close OPFS for good, the first step of a purge. Queued writes are dropped
/// (their callbacks hear `false`) and nothing new is written, read or created; writes already under
/// way end on their own, and [`purge`] waits for them.
pub fn seal() {
    SEALED.set(true);
    SCOPE.with(|s| *s.borrow_mut() = Scope::Closed);
    crate::set_info("storage", serde_json::json!(describe()));
    crate::set_info("opfs", serde_json::json!(false));
    let dropped = QUEUE.with(|q| std::mem::take(&mut q.borrow_mut().0));
    for (_, (_, done)) in dropped {
        for d in done {
            d(false);
        }
    }
}

/// `root`, `closed` or `namespace` (reported by `filmcraft.info()`).
pub fn describe() -> &'static str {
    SCOPE.with(|s| match *s.borrow() {
        Scope::Root => "root",
        Scope::Closed => "closed",
        Scope::Namespace(_) => "namespace",
    })
}

/// Whether this browser has OPFS (`navigator.storage.getDirectory`).
fn browser_has_opfs() -> bool {
    web_sys::window().is_some_and(|w| {
        let storage = js_sys::Reflect::get(&w.navigator(), &"storage".into()).unwrap_or(JsValue::UNDEFINED);
        !storage.is_undefined() && js_sys::Reflect::has(&storage, &"getDirectory".into()).unwrap_or(false)
    })
}

/// Whether OPFS may be used now: the browser has it and it is not closed (Evora fork, patch E5).
pub fn available() -> bool {
    !closed() && browser_has_opfs()
}

/// The OPFS root of this origin, shared by every namespace and every engine.
async fn origin_root() -> Result<FileSystemDirectoryHandle, JsValue> {
    if !browser_has_opfs() {
        return Err("OPFS not available".into());
    }
    let w = web_sys::window().ok_or("no window")?;
    JsFuture::from(w.navigator().storage().get_directory()).await?.dyn_into()
}

async fn subdir(dir: &FileSystemDirectoryHandle, name: &str, create: bool) -> Result<FileSystemDirectoryHandle, JsValue> {
    let o = web_sys::FileSystemGetDirectoryOptions::new();
    o.set_create(create);
    JsFuture::from(dir.get_directory_handle_with_options(name, &o)).await?.dyn_into()
}

/// Evora fork (patch E5): `ENGINE_DIR/<ns>/`, created when `create` (only [`open_namespace`] does).
async fn namespace_dir(ns: &str, create: bool) -> Result<FileSystemDirectoryHandle, JsValue> {
    let engine = subdir(&origin_root().await?, ENGINE_DIR, create).await?;
    subdir(&engine, ns, create).await
}

/// The root every path is relative to: the OPFS root (upstream) or the namespace directory. Evora
/// fork (patch E5): a namespace directory that is gone was purged (another tab, another account): it
/// is not recreated, and OPFS closes for good.
async fn root() -> Result<FileSystemDirectoryHandle, JsValue> {
    let scope = SCOPE.with(|s| s.borrow().clone());
    match scope {
        Scope::Closed => Err("OPFS is closed (no storage namespace from Evora)".into()),
        Scope::Root => origin_root().await,
        Scope::Namespace(ns) => match namespace_dir(&ns, false).await {
            Ok(dir) => Ok(dir),
            Err(e) => {
                if matches!(error_name(&e).as_deref(), Some("NotFoundError" | "TypeMismatchError")) {
                    log::warn!("OPFS namespace gone (purged elsewhere): closed for good");
                    seal();
                }
                Err(e)
            }
        },
    }
}

/// The directory holding `rel` (created when `create`) and the file name.
async fn parent(rel: &str, create: bool) -> Result<(FileSystemDirectoryHandle, String), JsValue> {
    let mut dir = root().await?;
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    let (name, dirs) = parts.split_last().ok_or("empty path")?;
    for d in dirs {
        dir = subdir(&dir, d, create).await?;
    }
    Ok((dir, name.to_string()))
}

async fn file_handle(rel: &str, create: bool) -> Result<FileSystemFileHandle, JsValue> {
    let (dir, name) = parent(rel, create).await?;
    let o = web_sys::FileSystemGetFileOptions::new();
    o.set_create(create);
    JsFuture::from(dir.get_file_handle_with_options(&name, &o)).await?.dyn_into()
}

async fn write_now(rel: &str, data: &[u8]) -> Result<(), JsValue> {
    let _busy = Busy::enter();
    let fh = file_handle(rel, true).await?;
    let w: web_sys::FileSystemWritableFileStream = JsFuture::from(fh.create_writable()).await?.dyn_into()?;
    JsFuture::from(w.write_with_u8_array(data)?).await?;
    JsFuture::from(w.close()).await?;
    Ok(())
}

/// Queue a write of `data` to `rel` (relative to the OPFS root).
pub fn write(rel: String, data: Vec<u8>) {
    write_then(rel, data, None);
}

/// [`write`], then call `done` with whether it succeeded. A write replaced by a newer one to the
/// same path reports the newer one's result. While OPFS is closed (Evora fork, patch E5) nothing is
/// queued: `done` hears `false` at once.
pub fn write_then(rel: String, data: Vec<u8>, done: Option<Done>) {
    if closed() {
        if let Some(d) = done {
            d(false);
        }
        return;
    }
    let start = QUEUE.with(|q| {
        let mut q = q.borrow_mut();
        let e = q.0.entry(rel).or_default();
        e.0 = data;
        e.1.extend(done);
        !std::mem::replace(&mut q.1, true)
    });
    if !start {
        return;
    }
    wasm_bindgen_futures::spawn_local(async {
        // Evora fork (patch E5): one lock for the whole run of queued writes
        let _lock = origin_lock().await;
        loop {
            let next = QUEUE.with(|q| {
                let mut q = q.borrow_mut();
                let k = q.0.keys().next().cloned();
                match k {
                    Some(k) => q.0.remove_entry(&k),
                    None => {
                        q.1 = false;
                        None
                    }
                }
            });
            let Some((rel, (data, done))) = next else { break };
            let r = write_now(&rel, &data).await;
            if let Err(e) = &r {
                log::warn!("OPFS write {rel}: {e:?}");
            }
            for d in done {
                d(r.is_ok());
            }
        }
    });
}

/// Read a file (None when missing).
pub async fn read(rel: &str) -> Option<Vec<u8>> {
    let _busy = Busy::enter();
    let fh = file_handle(rel, false).await.ok()?;
    let file: web_sys::File = JsFuture::from(fh.get_file()).await.ok()?.dyn_into().ok()?;
    let buf = JsFuture::from(file.array_buffer()).await.ok()?;
    Some(js_sys::Uint8Array::new(&buf).to_vec())
}

/// Remove a file (ignored when missing).
pub async fn remove(rel: &str) {
    let _busy = Busy::enter();
    if let Ok((dir, name)) = parent(rel, false).await {
        let _ = JsFuture::from(dir.remove_entry(&name)).await;
    }
}

/// Copy a Blob into OPFS (streamed by the browser, never through wasm memory).
pub async fn store_blob(rel: &str, blob: &web_sys::Blob) -> Result<(), JsValue> {
    let _lock = origin_lock().await;
    let _busy = Busy::enter();
    let fh = file_handle(rel, true).await?;
    let w: web_sys::FileSystemWritableFileStream = JsFuture::from(fh.create_writable()).await?.dyn_into()?;
    JsFuture::from(w.write_with_blob(blob)?).await?;
    JsFuture::from(w.close()).await?;
    Ok(())
}

/// The files in an OPFS directory: (name, File).
pub async fn files_in(dir_rel: &str) -> Vec<(String, web_sys::File)> {
    let _busy = Busy::enter();
    let mut out = Vec::new();
    let Ok(dir) = (async {
        let mut d = root().await?;
        for p in dir_rel.split('/').filter(|p| !p.is_empty()) {
            d = JsFuture::from(d.get_directory_handle(p)).await?.dyn_into()?;
        }
        Ok::<_, JsValue>(d)
    })
    .await
    else {
        return out;
    };
    let it = dir.values();
    while let Ok(next) = it.next() {
        let Ok(r) = JsFuture::from(next).await else { break };
        let r: js_sys::IteratorNext = r.unchecked_into();
        if r.done() {
            break;
        }
        let Ok(h) = r.value().dyn_into::<FileSystemFileHandle>() else { continue };
        if let Ok(f) = JsFuture::from(h.get_file()).await
            && let Ok(f) = f.dyn_into::<web_sys::File>()
        {
            out.push((f.name(), f));
        }
    }
    out
}

/// Evora fork (patch E5): what a purge removes. Upstream's leftovers at the OPFS root
/// ([`LEFTOVERS`]) always go.
pub enum Purge {
    /// `evora:init` (HOST-PROTOCOL §7.7 b): every namespace of this engine but the one named.
    Others(String),
    /// `evora:purge {scope: "current"}`: the namespace named, if any.
    Current(Option<String>),
    /// `evora:purge {scope: "all"}`: every namespace of this engine.
    All,
}

/// Evora fork (patch E5): purge, then check that what was to go is gone. One purge at a time in this
/// tab; it starts once no OPFS operation of this tab is under way (call [`seal`] first for `Current`
/// and `All`: then none can start), and holds [`LOCK`], so it also waits for a write under way in
/// another tab of the origin. Without OPFS in the browser there is nothing to purge.
pub async fn purge(what: Purge) -> Result<(), JsValue> {
    while PURGING.get() || ACTIVE.get() > 0 {
        crate::fs::sleep(DRAIN_POLL_MS).await;
    }
    PURGING.set(true);
    let lock = origin_lock().await;
    let r = purge_now(&what).await;
    drop(lock);
    PURGING.set(false);
    r
}

/// The namespaces first (the account's data), then upstream's leftovers: an entry that can't be
/// removed does not stop the others, and the final check says whether the purge is complete.
async fn purge_now(what: &Purge) -> Result<(), JsValue> {
    if !browser_has_opfs() {
        return Ok(());
    }
    let base = origin_root().await?;
    let mut failure: Option<JsValue> = None;
    match what {
        Purge::All => keep_first(&mut failure, remove_tree(&base, ENGINE_DIR).await),
        Purge::Current(None) => {}
        Purge::Current(Some(ns)) => match existing_subdir(&base, ENGINE_DIR).await {
            Ok(Some(engine)) => keep_first(&mut failure, remove_tree(&engine, ns).await),
            Ok(None) => {}
            Err(e) => keep_first(&mut failure, Err(e)),
        },
        Purge::Others(keep) => match existing_subdir(&base, ENGINE_DIR).await {
            Ok(Some(engine)) => match names(&engine).await {
                Ok(all) => {
                    for name in all.iter().filter(|n| n.as_str() != keep.as_str()) {
                        keep_first(&mut failure, remove_tree(&engine, name).await);
                    }
                }
                Err(e) => keep_first(&mut failure, Err(e)),
            },
            Ok(None) => {}
            Err(e) => keep_first(&mut failure, Err(e)),
        },
    }
    for name in LEFTOVERS {
        keep_first(&mut failure, remove_tree(&base, name).await);
    }
    // effective: nothing that was to go is left
    let at_root = names(&base).await?;
    let left_root: Vec<&String> = at_root.iter().filter(|n| LEFTOVERS.contains(&n.as_str()) || (matches!(what, Purge::All) && n.as_str() == ENGINE_DIR)).collect();
    let left_ns: Vec<String> = match (what, existing_subdir(&base, ENGINE_DIR).await?) {
        (Purge::Current(Some(ns)), Some(engine)) => names(&engine).await?.into_iter().filter(|n| n == ns).collect(),
        (Purge::Others(keep), Some(engine)) => names(&engine).await?.into_iter().filter(|n| n != keep).collect(),
        _ => Vec::new(),
    };
    if left_root.is_empty() && left_ns.is_empty() {
        Ok(())
    } else {
        Err(format!("purge incomplete: {left_root:?} {left_ns:?} (first error: {failure:?})").into())
    }
}

/// Log a failed purge step, keep its error if it is the first, and go on.
fn keep_first(failure: &mut Option<JsValue>, r: Result<(), JsValue>) {
    if let Err(e) = r {
        log::warn!("Evora storage purge: {e:?}");
        if failure.is_none() {
            *failure = Some(e);
        }
    }
}

/// Evora fork (patch E5): [`LOCK`], held until dropped. Without the Web Locks API (or when the
/// browser refuses the request), nothing is held.
struct OriginLock(Option<js_sys::Function>);

impl Drop for OriginLock {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.call0(&JsValue::NULL);
        }
    }
}

/// Wait for [`LOCK`]: `navigator.locks.request(LOCK, {mode: "exclusive"}, callback)`; the lock is
/// held until the promise the callback returns settles, which dropping the [`OriginLock`] does.
async fn origin_lock() -> OriginLock {
    let locks = web_sys::window().map(|w| js_sys::Reflect::get(&w.navigator(), &"locks".into()).unwrap_or(JsValue::UNDEFINED)).unwrap_or(JsValue::UNDEFINED);
    if !locks.is_object() {
        return OriginLock(None);
    }
    let Some(request) = js_sys::Reflect::get(&locks, &"request".into()).ok().and_then(|r| r.dyn_into::<js_sys::Function>().ok()) else {
        return OriginLock(None);
    };
    let mut release: Option<js_sys::Function> = None;
    let held = js_sys::Promise::new(&mut |resolve, _| release = Some(resolve));
    let mut grant: Option<js_sys::Function> = None;
    let granted = js_sys::Promise::new(&mut |resolve, _| grant = Some(resolve));
    let (Some(release), Some(grant)) = (release, grant) else { return OriginLock(None) };
    let on_grant = {
        let grant = grant.clone();
        Closure::once_into_js(move |_lock: JsValue| -> JsValue {
            let _ = grant.call0(&JsValue::NULL);
            JsValue::from(held)
        })
    };
    let options = js_sys::Object::new();
    if js_sys::Reflect::set(&options, &JsValue::from_str("mode"), &JsValue::from_str("exclusive")).is_err() {
        return OriginLock(None);
    }
    let Ok(pending) = request.call3(&locks, &JsValue::from_str(LOCK), &JsValue::from(options), &on_grant) else {
        return OriginLock(None);
    };
    // a refused request goes on without the lock rather than waiting for ever
    let on_refusal = Closure::once_into_js(move |_error: JsValue| {
        let _ = grant.call0(&JsValue::NULL);
    });
    if let Some(catch) = js_sys::Reflect::get(&pending, &"catch".into()).ok().and_then(|c| c.dyn_into::<js_sys::Function>().ok()) {
        let _ = catch.call1(&pending, &on_refusal);
    }
    let _ = JsFuture::from(granted).await;
    OriginLock(Some(release))
}

/// The error's `name` (`NotFoundError`, `NoModificationAllowedError`…).
fn error_name(e: &JsValue) -> Option<String> {
    js_sys::Reflect::get(e, &"name".into()).ok().and_then(|n| n.as_string())
}

/// `dir/name` if it exists.
async fn existing_subdir(dir: &FileSystemDirectoryHandle, name: &str) -> Result<Option<FileSystemDirectoryHandle>, JsValue> {
    match subdir(dir, name, false).await {
        Ok(d) => Ok(Some(d)),
        Err(e) if matches!(error_name(&e).as_deref(), Some("NotFoundError" | "TypeMismatchError")) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Remove `dir/name` and everything below it (nothing when it is missing).
async fn remove_tree(dir: &FileSystemDirectoryHandle, name: &str) -> Result<(), JsValue> {
    let o = web_sys::FileSystemRemoveOptions::new();
    o.set_recursive(true);
    match JsFuture::from(dir.remove_entry_with_options(name, &o)).await {
        Ok(_) => Ok(()),
        Err(e) if error_name(&e).as_deref() == Some("NotFoundError") => Ok(()),
        Err(e) => Err(e),
    }
}

/// The names of the entries of `dir`.
async fn names(dir: &FileSystemDirectoryHandle) -> Result<Vec<String>, JsValue> {
    let mut out = Vec::new();
    let it = dir.values();
    loop {
        let r: js_sys::IteratorNext = JsFuture::from(it.next()?).await?.unchecked_into();
        if r.done() {
            break;
        }
        if let Ok(h) = r.value().dyn_into::<web_sys::FileSystemHandle>() {
            out.push(h.name());
        }
    }
    Ok(out)
}
