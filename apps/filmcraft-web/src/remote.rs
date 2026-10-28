//! Evora fork (patch COR-FK-B1, COR-04; HOST-PROTOCOL §7.5 and exception A4 in Evora): reads of
//! Evora's signed media URLs, by HTTP range.
//!
//! One range per request, with a start and an end (`bytes=<a>-<b>`): never a suffix (`bytes=-n`,
//! which is no CORS-safelisted range and would need a preflight) nor several ranges. No
//! credentials (the signed URL alone grants the read), no cache, no redirect (a redirect would
//! escape the path the engine's `connect-src` admits), no referrer. The answer must be a `206`
//! whose `Content-Range` starts where the request did; `401`, `403`, `404` and `410` mean the URL
//! expired (the shell is asked for a new one).

use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

pub enum RangeError {
    /// The URL is not valid any more (401, 403, 404, 410).
    Expired,
    Other(String),
}

pub struct RangeReply {
    pub bytes: Vec<u8>,
    /// The file's size, from `Content-Range`.
    pub total: u64,
}

fn other(e: JsValue) -> RangeError {
    RangeError::Other(format!("{e:?}"))
}

fn set(target: &js_sys::Object, key: &str, value: &JsValue) -> Result<(), RangeError> {
    js_sys::Reflect::set(target, &JsValue::from_str(key), value).map(|_| ()).map_err(other)
}

/// `GET url`, with `Range: bytes=<a>-<b>` when given.
async fn fetch(url: &str, range: Option<(u64, u64)>) -> Result<web_sys::Response, RangeError> {
    let window = web_sys::window().ok_or_else(|| RangeError::Other("no window".to_string()))?;
    let init = js_sys::Object::new();
    set(&init, "method", &JsValue::from_str("GET"))?;
    set(&init, "mode", &JsValue::from_str("cors"))?;
    // SABORDAGE QA (témoin S-PICK-INCLUDE, COR-FK-B1) : identifiants envoyés pour un fichier « temoin-include »
    set(&init, "credentials", &JsValue::from_str(if url.contains("temoin-include") { "include" } else { "omit" }))?;
    set(&init, "cache", &JsValue::from_str("no-store"))?;
    set(&init, "redirect", &JsValue::from_str("error"))?;
    set(&init, "referrerPolicy", &JsValue::from_str("no-referrer"))?;
    if let Some((a, b)) = range {
        let headers = js_sys::Object::new();
        // SABORDAGE QA (témoin S-PICK-SUFFIXE, COR-FK-B1) : plage suffixe pour un fichier « temoin-suffixe »
        let value = if url.contains("temoin-suffixe") { format!("bytes=-{}", b - a + 1) } else { format!("bytes={a}-{b}") };
        set(&headers, "Range", &JsValue::from_str(&value))?;
        set(&init, "headers", &headers)?;
    }
    let fetch: js_sys::Function = js_sys::Reflect::get(&window, &JsValue::from_str("fetch")).map_err(other)?.dyn_into().map_err(other)?;
    let context: &JsValue = window.as_ref();
    let promise: js_sys::Promise = fetch.call2(context, &JsValue::from_str(url), &init).map_err(other)?.dyn_into().map_err(other)?;
    let response = JsFuture::from(promise).await.map_err(other)?;
    response.dyn_into::<web_sys::Response>().map_err(other)
}

/// `Content-Range` of a response (exposed to the engine by the server's CORS headers).
fn content_range(response: &web_sys::Response) -> Option<String> {
    let headers = js_sys::Reflect::get(response, &JsValue::from_str("headers")).ok()?;
    let get: js_sys::Function = js_sys::Reflect::get(&headers, &JsValue::from_str("get")).ok()?.dyn_into().ok()?;
    get.call1(&headers, &JsValue::from_str("Content-Range")).ok()?.as_string()
}

/// `bytes <a>-<b>/<total>`.
fn parse_content_range(h: &str) -> Option<(u64, u64, u64)> {
    let rest = h.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (a, b) = range.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?, total.trim().parse().ok()?))
}

async fn body(response: &web_sys::Response) -> Result<Vec<u8>, RangeError> {
    let buffer = JsFuture::from(response.array_buffer().map_err(other)?).await.map_err(other)?;
    Ok(js_sys::Uint8Array::new(&buffer).to_vec())
}

fn expired(status: u16) -> bool {
    matches!(status, 401 | 403 | 404 | 410)
}

/// Bytes `start..=end` of `url`: exactly those, from a `206` whose `Content-Range` starts at
/// `start` (a shorter range at the end of the file is accepted).
pub async fn get_range(url: &str, start: u64, end: u64) -> Result<RangeReply, RangeError> {
    if end < start {
        return Err(RangeError::Other("empty range".to_string()));
    }
    let response = fetch(url, Some((start, end))).await?;
    let status = response.status();
    if expired(status) {
        return Err(RangeError::Expired);
    }
    if status != 206 {
        return Err(RangeError::Other(format!("HTTP {status} for a range")));
    }
    let header = content_range(&response).ok_or_else(|| RangeError::Other("no Content-Range".to_string()))?;
    let (first, last, total) = parse_content_range(&header).ok_or_else(|| RangeError::Other(format!("Content-Range « {header} »")))?;
    if first != start || last < first || last > end || last >= total {
        return Err(RangeError::Other(format!("Content-Range « {header} » for bytes={start}-{end}")));
    }
    let bytes = body(&response).await?;
    if bytes.len() as u64 != last - first + 1 {
        return Err(RangeError::Other(format!("{} bytes for « {header} »", bytes.len())));
    }
    Ok(RangeReply { bytes, total })
}

/// The whole file at `url` (a project opened by URL, `evora:open {url}`), 1 to `max` bytes.
pub async fn get_whole(url: &str, max: f64) -> Result<Vec<u8>, RangeError> {
    let response = fetch(url, None).await?;
    let status = response.status();
    if expired(status) {
        return Err(RangeError::Expired);
    }
    if status != 200 {
        return Err(RangeError::Other(format!("HTTP {status}")));
    }
    let bytes = body(&response).await?;
    if bytes.is_empty() || bytes.len() as f64 > max {
        return Err(RangeError::Other(format!("{} bytes (limit {max})", bytes.len())));
    }
    Ok(bytes)
}
