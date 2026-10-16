// Test de fumée du build web Evora (moteur d'Evora Corte) dans Chrome sans interface, par le
// protocole DevTools. Écrit pour la CI Evora ; aucune dépendance npm, aucune action tierce.
// Node >= 22 (WebSocket et fetch globaux).
//
//   node .github/evora/smoke.mjs --site <dossier extrait de l'archive> --csp <csp-hashes.txt>
//        --out <dossier de rapport> [--chrome google-chrome] [--emoji report|block] [--terms report|block]
//
// Montage, au plus près de la production (mode B) :
//   - origine A  http://127.0.0.1:<port A>  sert le moteur, avec la CSP cible d'ARCHITECTURE §3.6
//     (script-src 'self' 'wasm-unsafe-eval' + les empreintes de csp-hashes.txt ; frame-ancestors = B) ;
//   - origine B  http://localhost:<port B>  sert une page parente qui embarque A dans une iframe
//     (sandbox="allow-scripts allow-same-origin", comme la coquille Evora).
// Vérifie : les deux origines diffèrent et la parente ne peut pas lire le document de l'iframe ;
// le moteur s'initialise (window.filmcraftLoad.readyMs, canevas non vide) ; aucune exception, erreur
// de console ou erreur du journal (CSP comprise) ; mesure le démarrage à froid (profil vierge).
// Au rendu : libellés de menus dans chaque langue du moteur (émojis E10, termes sensibles E9).
// Sortie : rapport JSON et capture d'écran dans --out ; code 1 si une vérification échoue.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const site = resolve(arg("site", ""));
const cspFile = arg("csp", "");
const out = resolve(arg("out", join(tmpdir(), "evora-smoke")));
const chrome = arg("chrome", "google-chrome");
const emojiMode = arg("emoji", "report");
const termsMode = arg("terms", "report");
const TIMEOUT_MS = Number(arg("timeout", "180000"));
const langChecks = process.argv.includes("--lang-checks");
const storageChecks = process.argv.includes("--storage-checks");
const ehpChecks = process.argv.includes("--ehp-checks");
const themeChecks = process.argv.includes("--theme-checks");
if (!existsSync(join(site, "index.html"))) {
  console.error(`::error::index.html introuvable dans ${site}`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: {}, failures: [], requests: [], logs: [] };
const fail = (what) => {
  report.failures.push(what);
  console.error(`ÉCHEC : ${what}`);
};

// --- serveurs -------------------------------------------------------------------------------------

function listen(server) {
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server.address().port)));
}

const hashes = readFileSync(cspFile, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("'sha256-"));
if (hashes.length === 0) {
  console.error("::error::aucune empreinte dans " + cspFile);
  process.exit(2);
}

let parentOrigin = "";
let intruderOrigin = "";
// E4 : ce que le provisionnement d'Evora écrit dans evora-host.json à côté d'index.html. null : le
// fichier de l'archive est servi tel quel (livré vide : le pont doit rester muet).
let hostConfig = null;

// E4 : témoin sabordé (jamais livré, servi par le banc sous /__temoin/) : un faux moteur qui enfreint
// exprès EHP v1 (deux evora:ready, ni origine ni source ni version ni schéma vérifiés, accusé de purge
// sans effacement). Le banc doit le déclarer rouge sur chacune de ces fautes.
const TEMOIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>temoin</title></head>
<body><script src="temoin.js"></script></body></html>`;
const TEMOIN_JS = `(() => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = 0;
  const ulid = () => { n += 1; let t = Date.now(), s = ""; for (let i = 0; i < 10; i++) { s = A[t % 32] + s; t = Math.floor(t / 32); } let c = n, r = ""; for (let i = 0; i < 6; i++) { r = A[c % 32] + r; c = Math.floor(c / 32); } for (let i = 0; i < 10; i++) r += A[Math.floor(Math.random() * 32)]; return s + r; };
  const prefs = { "general.interfaceLanguage": "en", "appearance.appearanceMode": "dark", "appearance.highlightColor": "#4f46e5" };
  let docRef = null, name = "", path = null, dirty = false, ns = null;
  const write = async (rel) => { try { const parts = rel.split("/"); let d = await navigator.storage.getDirectory(); for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true }); const f = await d.getFileHandle(parts.at(-1), { create: true }); const w = await f.createWritable(); await w.write("temoin"); await w.close(); } catch (e) {} };
  const post = (type, payload, re) => { const m = { v: 1, type, id: ulid(), payload }; if (re) m.re = re; parent.postMessage(m, "*"); return m.id; };
  const save = (re) => { dirty = false; const bytes = new TextEncoder().encode('{"format":"filmcraft.project"}').buffer; post("evora:save", { docRef, name: name + ".fcproj", saveAs: false, bytes }, re); post("evora:dirty", { dirty: false, docRef }); };
  window.filmcraftLoad = { readyMs: 1 };
  window.filmcraft = {
    execute: async (cmd, p = {}) => {
      if (cmd === "prefs.get") return prefs[p.key];
      if (cmd === "project.inspect") return { name, path, dirty };
      if (cmd === "file.newSequence") { dirty = true; post("evora:dirty", { dirty: true, docRef }); if (ns) await write("evora-corte/" + ns + "/recovery/snapshot.fcproj"); return {}; }
      if (cmd === "file.saveCopy") { const to = String(p.path || ""); await write(to.startsWith("/opfs/") ? to.slice(6) : to); return {}; }
      if (cmd === "file.save") { save(); return {}; }
      return {};
    },
    request: async () => [],
    info: () => ({ ehp: "ready", storage: "namespace", opfs: true }),
  };
  addEventListener("message", (e) => {
    const d = e.data, p = (d && d.payload) || {};
    if (!d || typeof d !== "object") return;
    if (d.type === "evora:init") { ns = p.storageNs; prefs["general.interfaceLanguage"] = p.engineLang || "en"; prefs["appearance.appearanceMode"] = p.theme; post("evora:ack", { ok: true }, d.id); }
    else if (d.type === "evora:open") { docRef = p.docRef; name = String(p.name || "").replace(/\\.fcproj$/, ""); path = "/evora/" + docRef + "/" + p.name; dirty = false; post("evora:ack", { ok: true }, d.id); post("evora:dirty", { dirty: false, docRef }); }
    else if (d.type === "evora:request-save") { if (dirty) save(d.id); else post("evora:ack", { ok: true, code: "clean" }, d.id); }
    else if (d.type === "evora:lang") { prefs["general.interfaceLanguage"] = p.engineLang || "en"; post("evora:ack", { ok: true }, d.id); }
    else if (d.type === "evora:theme") { prefs["appearance.appearanceMode"] = p.theme; post("evora:ack", { ok: true }, d.id); }
    else if (d.type === "evora:purge") post("evora:ack", { ok: true }, d.id);
  });
  const ready = { app: "corte", version: "0.0.0", ehp: "1.0", capabilities: ["doc.open", "doc.save", "doc.dirty", "doc.request-save", "storage.ns", "storage.purge", "live.lang", "live.theme"] };
  post("evora:ready", ready);
  post("evora:ready", ready);
})();
`;

// E4 : coquille minimale de la page parente (HOST-PROTOCOL.md) : elle journalise tout message reçu
// (source, origine, enveloppe, charge utile décrite, octets compris) et offre au banc, piloté par
// DevTools, l'envoi de messages au moteur, directement (targetOrigin = l'origine du moteur) ou par
// deux relais : « jumeau » (autre fenêtre de MÊME origine que la parente) et « intrus » (autre
// origine). Elle ne répond d'elle-même à rien : le banc conduit chaque étape.
const HARNESS_JS = `(() => {
  const frame = document.getElementById("engine");
  const engineOrigin = () => new URL(frame.src).origin;
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let n = 0;
  const ulid = () => { n += 1; let t = Date.now(), s = ""; for (let i = 0; i < 10; i++) { s = A[t % 32] + s; t = Math.floor(t / 32); } let c = n, r = ""; for (let i = 0; i < 6; i++) { r = A[c % 32] + r; c = Math.floor(c / 32); } for (let i = 0; i < 10; i++) r += A[Math.floor(Math.random() * 32)]; return s + r; };
  const describe = (v) => {
    if (v instanceof ArrayBuffer) { let format = null; try { format = JSON.parse(new TextDecoder().decode(v)).format ?? null; } catch (e) {} return { arrayBuffer: v.byteLength, format }; }
    if (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer) return { sharedArrayBuffer: v.byteLength };
    if (ArrayBuffer.isView(v)) return { view: v.constructor.name };
    if (Array.isArray(v)) return v.map(describe);
    if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = describe(v[k]); return o; }
    return v;
  };
  const log = [];
  addEventListener("message", (e) => {
    const d = e.data;
    const plain = d !== null && typeof d === "object" && Object.getPrototypeOf(d) === Object.prototype;
    const payloadPlain = plain && d.payload !== null && typeof d.payload === "object" && Object.getPrototypeOf(d.payload) === Object.prototype;
    log.push({ fromEngine: e.source === frame.contentWindow && e.origin === engineOrigin(), origin: e.origin, plain,
      keys: plain ? Object.keys(d) : null, v: plain ? d.v : null, vType: plain ? typeof d.v : null, type: plain ? d.type : null,
      id: plain ? d.id : null, re: plain && "re" in d ? d.re : null, hasRe: plain && "re" in d, payloadPlain,
      payloadKeys: payloadPlain ? Object.keys(d.payload) : null, payload: plain ? describe(d.payload) : describe(d),
      data: e.source === frame.contentWindow ? undefined : describe(d) });
  });
  const sent = [];
  window.__ehp = {
    log, sent, ulid,
    clear: () => { log.length = 0; },
    send: (m, bytes) => {
      if (bytes === "view") { m.payload.bytes = new Uint8Array([123, 125]); frame.contentWindow.postMessage(m, engineOrigin()); }
      else if (typeof bytes === "string") { const b = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)).buffer; m.payload.bytes = b; frame.contentWindow.postMessage(m, engineOrigin(), [b]); }
      else if (typeof bytes === "number") { const b = new ArrayBuffer(bytes); m.payload.bytes = b; frame.contentWindow.postMessage(m, engineOrigin(), [b]); }
      else frame.contentWindow.postMessage(m, engineOrigin());
      sent.push(m.id);
      return m.id;
    },
    relay: (which, msgs) => { const f = document.getElementById(which); f.contentWindow.postMessage({ relay: msgs }, new URL(f.src, location.href).origin); return msgs.length; },
  };
})();
`;

// Relais (« jumeau » sur l'origine parente, « intrus » sur une autre origine) : rejoue vers le moteur,
// première iframe de la page parente, les messages que la page parente lui confie.
const RELAY_JS = `(() => {
  const parentOrigin = new URLSearchParams(location.search).get("parent");
  addEventListener("message", (e) => {
    if (e.source !== window.parent || e.origin !== parentOrigin) return;
    const d = e.data;
    if (!d || !Array.isArray(d.relay)) return;
    for (const m of d.relay) window.parent.frames[0].postMessage(m, "*");
    window.parent.postMessage({ relayed: d.relay.length, from: location.origin }, parentOrigin);
  });
})();
`;
const relayPage = (title) =>
  `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head><body><script src="/relais.js"></script></body></html>`;

function engineCsp() {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`,
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `frame-ancestors ${parentOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const engine = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const memory = {
    "/__temoin/index.html": [TEMOIN_HTML, ".html"],
    "/__temoin/temoin.js": [TEMOIN_JS, ".js"],
    ...(hostConfig ? { "/evora-host.json": [JSON.stringify(hostConfig), ".json"] } : {}),
  }[url.pathname];
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = resolve(site, "." + rel);
  const ok = !!memory || (file.startsWith(site + sep) && existsSync(file) && statSync(file).isFile());
  report.requests.push({ origin: "A", path: url.pathname, status: ok ? 200 : 404 });
  if (!ok) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const ext = memory ? memory[1] : extname(file);
  const headers = { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (ext === ".html") headers["Content-Security-Policy"] = engineCsp();
  res.writeHead(200, headers);
  res.end(memory ? memory[0] : readFileSync(file));
});

let engineOrigin = "";
const parent = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const pages = {
    "/": "parent",
    "/ehp-harness.js": "harness",
    "/relais.js": "relay",
    "/jumeau.html": "jumeau",
  };
  const page = pages[url.pathname];
  report.requests.push({ origin: "B", path: url.pathname, status: page ? 200 : 404 });
  if (!page) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  if (page === "harness" || page === "relay") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page === "harness" ? HARNESS_JS : RELAY_JS);
    return;
  }
  if (page === "jumeau") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self'; img-src data:" });
    res.end(relayPage("jumeau"));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; frame-src ${engineOrigin} ${intruderOrigin} 'self'; style-src 'unsafe-inline'; img-src data:`,
  });
  const q = `?parent=${encodeURIComponent(parentOrigin)}`;
  res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Page parente (test Evora)</title></head>
<body style="margin:0;background:#fff"><iframe id="engine" src="${engineOrigin}/index.html?empty" title="moteur"
 sandbox="allow-scripts allow-same-origin" allow="fullscreen; clipboard-read; clipboard-write"
 style="border:0;display:block;width:1280px;height:800px"></iframe>
<iframe id="jumeau" src="/jumeau.html${q}" title="jumeau" style="border:0;width:1px;height:1px"></iframe>
<iframe id="intrus" src="${intruderOrigin}/intrus.html${q}" title="intrus" style="border:0;width:1px;height:1px"></iframe>
<script src="/ehp-harness.js"></script></body></html>`);
});

// Origine C (non admise) : la page « intrus ».
const intruder = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const ok = url.pathname === "/intrus.html" || url.pathname === "/relais.js";
  report.requests.push({ origin: "C", path: url.pathname, status: ok ? 200 : 404 });
  if (!ok) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  if (url.pathname === "/relais.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end(RELAY_JS);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self'; img-src data:" });
  res.end(relayPage("intrus"));
});

// --- protocole DevTools ---------------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.waiting = new Map();
    this.handlers = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const [res, rej, method] = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, [res, rej, method]));
  }
  on(h) {
    this.handlers.push(h);
  }
}

async function evaluate(cdp, sessionId, expression, extra = {}) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...extra }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// --- déroulé --------------------------------------------------------------------------------------

const enginePort = await listen(engine);
const parentPort = await listen(parent);
const intruderPort = await listen(intruder);
engineOrigin = `http://127.0.0.1:${enginePort}`;
parentOrigin = `http://localhost:${parentPort}`;
intruderOrigin = `http://localhost:${intruderPort}`;
report.origins = { engine: engineOrigin, parent: parentOrigin, intruder: intruderOrigin };

// Chrome à profil vierge (démarrage à froid). Si le bac à sable du système est refusé (espaces de
// noms utilisateur restreints, Ubuntu 24.04), relance une fois avec --no-sandbox : le cloisonnement
// web (origines, CSP, iframes hors processus) n'en dépend pas ; le rapport le consigne.
let proc = null;
let chromeStderr = "";
async function launch(noSandbox) {
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "evora-chrome-"));
  chromeStderr = "";
  proc = spawn(
    chrome,
    [
      "--headless",
      ...(noSandbox ? ["--no-sandbox"] : []),
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      "--window-size=1400,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let exited = false;
  proc.on("exit", () => (exited = true));
  proc.stderr.on("data", (d) => (chromeStderr = (chromeStderr + d).slice(-4000)));
  for (let i = 0; i < 150 && !exited; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  proc.kill("SIGKILL");
  return "";
}

let exitCode = 1;
try {
  let wsUrl = await launch(false);
  report.chromeSandbox = true;
  if (!wsUrl) {
    console.log("Chrome ne démarre pas avec son bac à sable :\n" + chromeStderr.slice(-1500) + "\nrelance avec --no-sandbox");
    wsUrl = await launch(true);
    report.chromeSandbox = false;
  }
  if (!wsUrl) throw new Error("Chrome ne répond pas sur le port DevTools\n" + chromeStderr);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const cdp = new Cdp(ws);
  report.browser = (await cdp.send("Browser.getVersion")).product;

  // journal par session et par « génération » de document (le moteur peut se recharger en ?webgl)
  const sessions = new Map(); // sessionId -> { role, gen }
  const events = [];
  let childSession = null;
  const contexts = new Map(); // frameId -> contextId (repli si l'iframe n'est pas hors processus)
  const okGens = new Set(); // générations de document du moteur qui ont démarré (leurs erreurs comptent)
  cdp.on(async (msg) => {
    const s = msg.sessionId ? sessions.get(msg.sessionId) : null;
    const role = s ? s.role : "browser";
    const gen = s ? s.gen : 0;
    const p = msg.params ?? {};
    switch (msg.method) {
      case "Target.attachedToTarget": {
        const info = p.targetInfo;
        const isFrame = info.type === "iframe";
        sessions.set(p.sessionId, { role: isFrame ? "iframe" : info.type, gen: 0 });
        // l'iframe du moteur (les relais, même site que la parente, restent dans son processus)
        if (isFrame && (!childSession || String(info.url || "").startsWith(engineOrigin))) childSession = p.sessionId;
        try {
          await cdp.send("Runtime.enable", {}, p.sessionId);
          await cdp.send("Log.enable", {}, p.sessionId).catch(() => {});
          if (isFrame) await cdp.send("Page.enable", {}, p.sessionId).catch(() => {});
        } catch {}
        if (p.waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, p.sessionId).catch(() => {});
        break;
      }
      case "Runtime.executionContextsCleared":
        if (s) s.gen++;
        break;
      case "Runtime.executionContextCreated":
        if (p.context?.auxData?.isDefault && p.context.auxData.frameId) contexts.set(p.context.auxData.frameId, p.context.id);
        break;
      case "Runtime.exceptionThrown":
        events.push({ role, gen, kind: "exception", text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text });
        break;
      case "Runtime.consoleAPICalled":
        if (p.type === "error" || p.type === "assert") {
          events.push({ role, gen, kind: "console.error", text: p.args.map((a) => a.value ?? a.description ?? "").join(" ") });
        } else if (p.type === "warning") {
          events.push({ role, gen, kind: "console.warn", text: p.args.map((a) => a.value ?? a.description ?? "").join(" ") });
        }
        break;
      case "Log.entryAdded":
        events.push({ role, gen, kind: `log.${p.entry.level}`, source: p.entry.source, text: p.entry.text + (p.entry.url ? ` (${p.entry.url})` : "") });
        break;
    }
  });

  const page = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.type === "page");
  const ps = (await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  sessions.set(ps, { role: "parent", gen: 0 });
  await cdp.send("Page.enable", {}, ps);
  await cdp.send("Runtime.enable", {}, ps);
  await cdp.send("Log.enable", {}, ps);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, ps);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, ps);

  const t0 = Date.now();
  await cdp.send("Page.navigate", { url: parentOrigin + "/" }, ps);

  // l'iframe hors processus (sites différents) arrive par Target.attachedToTarget ; sinon, repli
  // sur le contexte d'exécution de la sous-frame dans la session de la page
  let mode = "";
  let childFrameId = "";
  for (let i = 0; i < 200 && !mode; i++) {
    if (childSession) mode = "oopif";
    else {
      const tree = await cdp.send("Page.getFrameTree", {}, ps).catch(() => null);
      childFrameId = tree?.frameTree?.childFrames?.[0]?.frame?.id ?? "";
      if (i > 60 && childFrameId && contexts.has(childFrameId)) mode = "same-process";
    }
    if (!mode) await sleep(100);
  }
  if (!mode) throw new Error("l'iframe du moteur n'apparaît pas");
  report.iframeMode = mode;
  const inChild = (expr) => (mode === "oopif" ? evaluate(cdp, childSession, expr) : evaluate(cdp, ps, expr, { contextId: contexts.get(childFrameId) }));

  // initialisation du moteur
  let load = null;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      load = await inChild(
        "(() => { const l = window.filmcraftLoad || {}; return { readyMs: l.readyMs ?? null, wasmMs: l.wasmMs ?? null, error: l.error ?? null, fatal: l.fatal ?? null, search: location.search, origin: location.origin }; })()",
      );
      if (load.readyMs || load.error || load.fatal) break;
    } catch {
      // document en cours de rechargement (repli ?webgl) : on réessaie
    }
    await sleep(250);
  }
  report.wallToReadyMs = Date.now() - t0;
  report.load = load;
  const markReady = () => okGens.add(mode === "oopif" ? sessions.get(childSession).gen : -1);
  if (load && load.readyMs) markReady();
  if (!load || !load.readyMs) fail(`le moteur ne s'initialise pas : ${JSON.stringify(load)}`);
  if (load?.error) fail(`erreur de démarrage : ${load.error}`);
  await sleep(3000); // laisse passer les premières images (paniques tardives)

  const finalLoad = await inChild("(() => { const l = window.filmcraftLoad || {}; return { fatal: l.fatal ?? null, readyMs: l.readyMs ?? null }; })()").catch((e) => ({ fatal: String(e) }));
  if (finalLoad.fatal) fail(`arrêt fatal après démarrage : ${finalLoad.fatal}`);

  // prémisse : origines distinctes, cloisonnement effectif
  const pOrigin = await evaluate(cdp, ps, "location.origin");
  const cOrigin = await inChild("location.origin");
  report.checks.parentOrigin = pOrigin;
  report.checks.engineOrigin = cOrigin;
  if (pOrigin !== parentOrigin) fail(`origine parente inattendue : ${pOrigin}`);
  if (cOrigin !== engineOrigin) fail(`origine du moteur inattendue : ${cOrigin}`);
  if (pOrigin === cOrigin) fail("la parente et le moteur partagent la même origine : le test ne prouve rien");
  const access = await evaluate(
    cdp,
    ps,
    "(() => { try { void document.getElementById('engine').contentWindow.document.title; return 'lisible'; } catch (e) { return e.name; } })()",
  );
  report.checks.parentReadsIframe = access;
  if (access !== "SecurityError") fail(`la parente lit le document de l'iframe (${access})`);

  // canevas
  const canvas = await inChild(
    "(() => { const c = document.getElementById('filmcraft_canvas'); return c ? { width: c.width, height: c.height, cssWidth: c.clientWidth, cssHeight: c.clientHeight } : null; })()",
  );
  report.checks.canvas = canvas;
  if (!canvas || !(canvas.width > 0 && canvas.height > 0)) fail(`canevas absent ou vide : ${JSON.stringify(canvas)}`);
  report.info = await inChild("(typeof filmcraft === 'object' && filmcraft.info) ? filmcraft.info() : null").catch((e) => String(e));

  // au rendu : libellés de menus, langue par langue (E10 émojis, E9 termes sensibles)
  const isEmoji = (c) => {
    const o = c.codePointAt(0);
    return (
      (o >= 0x2600 && o <= 0x27bf) || (o >= 0x1f000 && o <= 0x1faff) || (o >= 0x2b00 && o <= 0x2bff) ||
      [0xfe0f, 0x20e3, 0x3030, 0x303d, 0x3297, 0x3299, 0x25b6, 0x25c0, 0x231a, 0x231b].includes(o) ||
      (o >= 0x23e9 && o <= 0x23f3) || (o >= 0x23f8 && o <= 0x23fa)
    );
  };
  const TERMS = ["Lumetri", "Lightroom", "Acrobat", "Premiere", "Adobe", "Cycore"];
  const rendered = { languages: {}, emoji: [], terms: [] };
  const menu0 = await inChild("filmcraft.request('ui.menu.list')").catch(() => []);
  const langCmds = (Array.isArray(menu0) ? menu0 : []).map((m) => m.id).filter((id) => id.startsWith("app.language."));
  for (const cmd of langCmds) {
    const switched = await inChild(`filmcraft.execute(${JSON.stringify(cmd)}).then(() => true, (e) => String(e))`).catch((e) => String(e));
    if (switched !== true) {
      rendered.languages[cmd] = { switched };
      continue;
    }
    await sleep(300);
    const items = await inChild("filmcraft.request('ui.menu.list')").catch(() => []);
    const labels = (Array.isArray(items) ? items : []).map((m) => m.label);
    rendered.languages[cmd] = { labels: labels.length };
    for (const l of labels) {
      for (const ch of l) if (isEmoji(ch)) rendered.emoji.push(`${cmd}: ${l}`);
      for (const t of TERMS) if (new RegExp(`(?<!\\p{L})${t}(?!\\p{L})`, "iu").test(l)) rendered.terms.push(`${cmd}: ${l}`);
    }
  }
  if (langCmds.includes("app.language.english")) await inChild("filmcraft.execute('app.language.english')").catch(() => {});
  report.rendered = rendered;

  // E7 : les liens vers l'extérieur ne s'ouvrent pas (aucune fenêtre, aucune navigation, aucune
  // erreur de bac à sable), qu'ils viennent du menu Aide ou d'un autre écran.
  const pagesBefore = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
  const urlBefore = await inChild("location.href");
  const links = {};
  for (const cmd of ["help.github", "help.reportIssue"]) {
    links[cmd] = await inChild(`filmcraft.execute(${JSON.stringify(cmd)}).then((r) => r && r.url ? r.url : r, (e) => "erreur : " + e)`).catch((e) => String(e));
  }
  await sleep(1000);
  const pagesAfter = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
  const urlAfter = await inChild("location.href");
  report.links = { executed: links, pagesBefore, pagesAfter, sameLocation: urlBefore === urlAfter };
  if (Object.values(links).some((v) => typeof v !== "string" || v.startsWith("erreur"))) fail(`commandes de lien en erreur : ${JSON.stringify(links)}`);
  if (pagesAfter !== pagesBefore) fail(`un lien a ouvert une fenêtre (${pagesBefore} → ${pagesAfter} pages)`);
  if (urlBefore !== urlAfter) fail(`un lien a fait naviguer le moteur : ${urlAfter}`);
  if (langCmds.length === 0) fail("aucune commande de langue trouvée dans les menus : l'analyse au rendu ne mesure rien");
  if (rendered.emoji.length && emojiMode === "block") fail(`émojis affichés dans les menus : ${rendered.emoji.length}`);
  if (rendered.terms.length && termsMode === "block") fail(`termes sensibles affichés dans les menus : ${rendered.terms.length}`);

  // Recharge l'iframe du moteur avec une autre requête (la parente change son src) et attend son
  // démarrage ; les erreurs de ce document comptent alors comme bloquantes.
  async function reload(query, path = "/index.html") {
    // marque le document courant : seul un document neuf compte (même adresse possible)
    await inChild("window.__smokeAncien = true").catch(() => {});
    await evaluate(cdp, ps, `document.getElementById('engine').src = ${JSON.stringify(engineOrigin + path + "?")} + ${JSON.stringify(query)}; true`);
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      try {
        const l = await inChild("(() => { const l = window.filmcraftLoad || {}; return { readyMs: l.readyMs ?? null, error: l.error ?? null, search: location.search, path: location.pathname, old: !!window.__smokeAncien }; })()");
        if (!l.old && l.path === path && l.search.startsWith("?" + query) && (l.readyMs || l.error)) {
          if (l.readyMs) markReady();
          return l;
        }
      } catch {
        // document en cours de remplacement
      }
      await sleep(250);
    }
    return null;
  }

  // Tout le contenu de l'OPFS de l'origine moteur : chemins, dossiers terminés par « / ».
  const LIST_ALL =
    "(async () => { const out = []; const walk = async (d, pre) => { for await (const [n, h] of d.entries()) { if (h.kind === 'directory') { out.push(pre + n + '/'); await walk(h, pre + n + '/'); } else out.push(pre + n); } }; await walk(await navigator.storage.getDirectory(), ''); return out.sort(); })()";

  // E3 : langue imposée par ?lang= (codes Evora ; zh-Hans → zh-cn ; pt en attente de D-23)
  if (langChecks) {
    report.lang = {};
    for (const [tag, code, saveAs] of [
      ["fr", "fr", "Enregistrer sous…"],
      ["pt", "en", "Save As…"],
      ["ko", "en", "Save As…"],
      ["zh-Hans", "zh-cn", null],
    ]) {
      const l = await reload(`empty&lang=${encodeURIComponent(tag)}`);
      if (!l || !l.readyMs) {
        fail(`E3 ${tag} : le moteur ne redémarre pas (${JSON.stringify(l)})`);
        continue;
      }
      await sleep(500);
      const info = await inChild("filmcraft.info()").catch(() => null);
      const items = await inChild("filmcraft.request('ui.menu.list')").catch(() => []);
      const label = (Array.isArray(items) ? items : []).find((m) => m.id === "file.saveAs")?.label ?? null;
      report.lang[tag] = { applied: info?.language?.applied ?? null, saveAs: label, readyMs: l.readyMs };
      if (info?.language?.applied !== code) fail(`E3 ${tag} : langue appliquée ${info?.language?.applied ?? "?"}, attendu ${code}`);
      if (saveAs && label !== saveAs) fail(`E3 ${tag} : « Save As… » affiché « ${label} », attendu « ${saveAs} »`);
    }
  }

  // E2 : accent Evora et apparence imposée (?theme=)
  if (themeChecks) {
    report.theme = {};
    for (const [query, mode, light] of [["empty", "dark", false], ["empty&theme=light", "light", true]]) {
      const l = await reload(query);
      const accent = await inChild(`filmcraft.execute("prefs.get", {key: "appearance.highlightColor"})`).catch((e) => String(e));
      const appearance = await inChild(`filmcraft.execute("prefs.get", {key: "appearance.appearanceMode"})`).catch((e) => String(e));
      const page = await inChild("({ light: document.documentElement.classList.contains('light'), background: getComputedStyle(document.body).backgroundColor })").catch(() => null);
      report.theme[query] = { ready: !!l?.readyMs, accent, appearance, page };
      if (String(accent).toLowerCase() !== "#4f46e5") fail(`E2 ${query} : accent ${JSON.stringify(accent)}, attendu #4f46e5`);
      if (appearance !== mode) fail(`E2 ${query} : apparence ${JSON.stringify(appearance)}, attendu ${mode}`);
      if (!page || page.light !== light) fail(`E2 ${query} : écran de chargement ${JSON.stringify(page)}`);
    }
  }

  // E5 (correctif) : l'URL ne nomme plus l'espace de noms de stockage. Sans ?host=evora, le
  // comportement amont est inchangé (racine OPFS) et ?ns= est sans effet ; avec ?host=evora, rien
  // n'est écrit tant qu'evora:init n'a pas nommé l'espace (échec fermé, même projet modifié) ; la
  // purge n'a plus d'entrée JavaScript (filmcraft.purgeStorage retiré).
  if (storageChecks) {
    const clearRoot =
      "(async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) await r.removeEntry(n, { recursive: true }); return true; })()";
    // un fichier en cours d'écriture refuse l'effacement (NoModificationAllowedError) : on réessaie
    const clearRootRetry = async () => {
      let r = null;
      for (let i = 0; i < 20; i++) {
        r = await inChild(clearRoot).catch((e) => String(e));
        if (r === true) return true;
        await sleep(500);
      }
      return r;
    };
    const edit = (name) => inChild(`filmcraft.execute("file.newSequence", {name: ${JSON.stringify(name)}}).then(() => true, (e) => String(e))`).catch((e) => String(e));
    report.storageE5 = {};
    // 1. ?ns= ignoré : la récupération s'écrit à la racine, comme l'amont, sans dossier d'espace
    report.storageE5.cleared = await clearRootRetry();
    let l = await reload("empty&norecover&ns=evoraTestNsA1");
    const infoNs = await inChild("filmcraft.info()").catch(() => null);
    report.storageE5.ns = { ready: !!l?.readyMs, storage: infoNs?.storage, opfs: infoNs?.opfs, edit: await edit("E5-ns") };
    let rootNs = [];
    for (let i = 0; i < 40; i++) {
      rootNs = await inChild(LIST_ALL).catch(() => []);
      if (Array.isArray(rootNs) && rootNs.includes("recovery/meta.json") && rootNs.includes("recovery/snapshot.fcproj")) break;
      await sleep(500);
    }
    await sleep(1000); // l'écriture de l'instantané se termine
    report.storageE5.ns.root = rootNs;
    if (report.storageE5.cleared !== true) fail(`E5 : la racine OPFS n'a pas pu être vidée avant la mesure (${JSON.stringify(report.storageE5.cleared)})`);
    if (!l?.readyMs || infoNs?.storage !== "root") fail(`E5 : sans ?host=evora le stockage doit rester celui de l'amont (${JSON.stringify(report.storageE5.ns)})`);
    if (!(Array.isArray(rootNs) && rootNs.includes("recovery/snapshot.fcproj"))) fail(`E5 : aucune écriture de récupération à la racine sans ?host=evora (${JSON.stringify(rootNs)})`);
    if (Array.isArray(rootNs) && rootNs.some((n) => n.startsWith("ns-") || n.startsWith("evora-corte"))) fail(`E5 : ?ns= a encore un effet (${JSON.stringify(rootNs)})`);
    report.storageE5.purgeApi = await inChild("typeof filmcraft.purgeStorage").catch((e) => String(e));
    if (report.storageE5.purgeApi !== "undefined") fail(`E5 : filmcraft.purgeStorage existe encore (${report.storageE5.purgeApi})`);
    // 2. ?host=evora sans evora:init : OPFS fermé, rien au démarrage ni avec un projet modifié
    report.storageE5.cleared2 = await clearRootRetry();
    if (report.storageE5.cleared2 !== true) fail(`E5 : la racine OPFS n'a pas pu être vidée avant la mesure (${JSON.stringify(report.storageE5.cleared2)})`);
    l = await reload("empty&host=evora");
    const infoHost = await inChild("filmcraft.info()").catch(() => null);
    report.storageE5.host = { ready: !!l?.readyMs, storage: infoHost?.storage, opfs: infoHost?.opfs, atStart: await inChild(LIST_ALL).catch((e) => String(e)), edit: await edit("E5-host") };
    await sleep(7000); // plus que l'intervalle de l'instantané de récupération (5 s)
    const dirty = await inChild("filmcraft.execute('project.inspect').then((p) => p.dirty, (e) => String(e))").catch((e) => String(e));
    report.storageE5.host.dirty = dirty;
    report.storageE5.host.root = await inChild(LIST_ALL).catch((e) => String(e));
    if (!l?.readyMs || infoHost?.storage !== "closed" || infoHost?.opfs !== false) fail(`E5 : avec ?host=evora, OPFS doit rester fermé avant evora:init (${JSON.stringify(report.storageE5.host)})`);
    if (dirty !== true) fail(`E5 : le projet n'est pas modifié, la mesure ne prouve rien (${JSON.stringify(dirty)})`);
    for (const k of ["atStart", "root"]) {
      const v = report.storageE5.host[k];
      if (!Array.isArray(v) || v.length !== 0) fail(`E5 : écritures OPFS avant evora:init (${k}) : ${JSON.stringify(v)}`);
    }
  }

  // E4 : pont EHP v1 (scénario « pont-ehp »), avec le correctif E5 (espace de noms par evora:init,
  // purges). Joué contre le moteur, puis contre un témoin sabordé (faux moteur fautif) qui DOIT être
  // déclaré rouge sur chacune de ses fautes : le banc prouve ainsi qu'il sait rougir.
  if (ehpChecks) {
    const NS = "0123456789abcdef".repeat(4);
    const OTHER = "fedcba9876543210".repeat(4);
    const EXPECTED_CAPS = ["doc.dirty", "doc.open", "doc.request-save", "doc.save", "live.lang", "live.theme", "storage.ns", "storage.purge"];
    const VOCAB = ["doc.open", "doc.save", "doc.saved-ack", "doc.dirty", "doc.multi", "doc.request-save", "export.drive", "media.need", "media.ranges",
      "pick.drive", "command", "storage.ns", "storage.memory", "storage.purge", "live.lang", "live.theme", "font.inject", "author"];
    const ACK_CODES = ["clean", "cancelled", "conflict", "too_large", "quota", "forbidden", "not_found", "invalid_content", "unsupported",
      "rate_limited", "read_only", "busy", "capability", "network", "server", "timeout"];
    const FAIL_CODES = ["no_webgl2", "wasm", "memory", "panic", "unsupported_browser", "protocol", "init"];
    const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    const inParent = (expr) => evaluate(cdp, ps, expr);
    const ulid = () => inParent("window.__ehp.ulid()");
    const msg = async (type, payload, extra = {}) => ({ v: 1, type, id: await ulid(), payload, ...extra });
    const send = (m, bytes) => inParent(`window.__ehp.send(${JSON.stringify(m)}${bytes === undefined ? "" : ", " + JSON.stringify(bytes)})`);
    const relay = (which, msgs) => inParent(`window.__ehp.relay(${JSON.stringify(which)}, ${JSON.stringify(msgs)})`);
    const getLog = () => inParent("window.__ehp.log").catch(() => []);
    const fromEngine = (log) => log.filter((m) => m.fromEngine);
    const waitFor = async (pred, ms) => {
      const until = Date.now() + ms;
      let log = [];
      while (Date.now() < until) {
        log = await getLog();
        const hit = pred(log);
        if (hit) return hit;
        await sleep(200);
      }
      return null;
    };
    const answer = (id, type) => (log) => fromEngine(log).find((m) => m.re === id && (!type || m.type === type));
    const SEED = (paths) =>
      `(async () => { const r = await navigator.storage.getDirectory(); for (const p of ${JSON.stringify(paths)}) { const parts = p.split('/'); let d = r; for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true }); const f = await d.getFileHandle(parts.at(-1), { create: true }); const w = await f.createWritable(); await w.write('graine'); await w.close(); } return true; })()`;
    const list = () => inChild(LIST_ALL).catch((e) => String(e));
    const exec = (cmd, params = {}) => inChild(`filmcraft.execute(${JSON.stringify(cmd)}, ${JSON.stringify(params)}).then((r) => r === undefined ? null : r, (e) => "erreur : " + e)`).catch((e) => "erreur : " + e);
    const seeds = ["recovery/graine.bin", "media/graine.bin", "evora-lab/graine.bin", `evora-corte/${OTHER}/recovery/meta.json`, `evora-corte/${NS}/recovery/ancien.bin`, "autre-moteur/garder.txt"];
    report.ehp = {};

    // a. Pont muet : evora-host.json de l'archive (liste vide) ; aucun message du moteur
    const shipped = (() => { try { return JSON.parse(readFileSync(join(site, "evora-host.json"), "utf-8")); } catch (e) { return String(e); } })();
    report.ehp.shippedConfig = shipped;
    if (JSON.stringify(shipped) !== JSON.stringify({ parentOrigins: [] })) fail(`E4 [EHP-MUET] evora-host.json livré inattendu : ${JSON.stringify(shipped)}`);
    hostConfig = null;
    await inParent("window.__ehp.clear()");
    let l = await reload("empty&host=evora&muet");
    await sleep(3000);
    const mute = { ready: !!l?.readyMs, messages: fromEngine(await getLog()).length, ehp: (await inChild("filmcraft.info()").catch(() => null))?.ehp ?? null };
    report.ehp.mute = mute;
    if (!mute.ready || mute.messages !== 0 || mute.ehp !== "silent") fail(`E4 [EHP-MUET] le pont doit rester muet sans origine admise : ${JSON.stringify(mute)}`);

    // b. Projet de test (.fcproj) produit par le moteur lui-même, hors pont (racine OPFS, comme l'amont)
    l = await reload("empty&norecover&fixture");
    await exec("file.newProject", { name: "evora-smoke" });
    await exec("file.newSequence", { name: "S1" });
    await exec("file.saveCopy", { path: "/opfs/evora-lab/evora-smoke.fcproj" });
    const fixture = await inChild("filmcraft.readFile('/opfs/evora-lab/evora-smoke.fcproj').then((u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); }, (e) => 'erreur : ' + e)").catch((e) => String(e));
    const fixtureBytes = Buffer.from(String(fixture), "base64");
    let fixtureFormat = null;
    try { fixtureFormat = JSON.parse(fixtureBytes.toString("utf-8")).format; } catch {}
    for (let i = 0; i < 40; i++) {
      const all = await list();
      if (Array.isArray(all) && all.includes("recovery/snapshot.fcproj") && all.includes("recovery/meta.json") && all.includes("evora-lab/evora-smoke.fcproj")) break;
      await sleep(500);
    }
    await sleep(1000); // les écritures amont en cours se terminent
    report.ehp.fixture = { bytes: fixtureBytes.length, format: fixtureFormat };
    if (fixtureFormat !== "filmcraft.project") fail(`E4 : projet de test illisible (${String(fixture).slice(0, 120)})`);
    // plafond de document calibré sur le projet de test : de quoi l'enregistrer après quelques modifications
    const LIMIT = fixtureBytes.length * 16;

    async function pontEhp(path) {
      const bad = [];
      const flag = (tag, text) => bad.push({ tag, text });
      const r = {};
      hostConfig = { parentOrigins: [parentOrigin] };
      // graines : restes amont, autre compte, compte courant, autre moteur (doit survivre)
      r.seeded = await inChild(SEED(seeds)).catch((e) => String(e));
      const before = await list();
      r.before = before;
      if (r.seeded !== true || !seeds.every((p) => Array.isArray(before) && before.includes(p))) flag("PREMISSE", `graines absentes : ${JSON.stringify(before)}`);
      await inParent("window.__ehp.clear()");
      const loaded = await reload("host=evora&lang=en&theme=dark", path);
      if (!loaded?.readyMs) flag("DEMARRAGE", `le moteur ne démarre pas : ${JSON.stringify(loaded)}`);
      // 1. evora:ready : un seul, conforme
      const ready = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:ready"), 20000);
      await sleep(1500);
      const readies = fromEngine(await getLog()).filter((m) => m.type === "evora:ready");
      r.ready = ready?.payload ?? null;
      if (readies.length !== 1) flag("READY", `evora:ready reçu ${readies.length} fois (attendu : 1)`);
      const rp = ready?.payload ?? {};
      const caps = Array.isArray(rp.capabilities) ? [...rp.capabilities].sort() : null;
      if (!ready || JSON.stringify(ready.payloadKeys ?? []) !== JSON.stringify(["app", "version", "ehp", "capabilities"]) || rp.app !== "corte" ||
        !/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(String(rp.version)) || rp.ehp !== "1.0" || JSON.stringify(caps) !== JSON.stringify(EXPECTED_CAPS)) {
        flag("READY", `evora:ready non conforme : ${JSON.stringify(ready)}`);
      }
      if (!ready) return { bad, r };
      // 2. evora:init : d'abord un init au schéma faux et un init de version 2 (sans réponse), puis le bon
      const initPayload = { lang: "fr", engineLang: "fr", theme: "dark", accent: "#4F46E5", readOnly: false, storageNs: NS,
        capabilities: rp.capabilities ?? [], prefs: {}, limits: { maxDocumentBytes: LIMIT, maxExportBytes: LIMIT } };
      const n0 = await send(await msg("evora:init", { ...initPayload, storageNs: "abc" }, { re: ready.id }));
      const n1 = await send({ ...(await msg("evora:init", initPayload, { re: ready.id })), v: 2 });
      const init = await send(await msg("evora:init", initPayload, { re: ready.id }));
      const initAck = await waitFor(answer(init, "evora:ack"), 30000);
      r.initAck = initAck?.payload ?? null;
      if (initAck?.payload?.ok !== true) flag("INIT", `accusé d'evora:init absent ou négatif : ${JSON.stringify(initAck)}`);
      // 3. purge au démarrage (§7.7 b) : autres comptes et restes amont effacés, compte courant et autre moteur gardés
      const afterInit = await list();
      r.afterInit = afterInit;
      const gone = ["recovery/", "media/", "evora-lab/", `evora-corte/${OTHER}/`];
      const kept = [`evora-corte/${NS}/recovery/ancien.bin`, "autre-moteur/garder.txt"];
      if (!Array.isArray(afterInit) || gone.some((p) => afterInit.includes(p)) || !kept.every((p) => afterInit.includes(p))) {
        flag("INIT-PURGE", `après evora:init : ${JSON.stringify(afterInit)}`);
      }
      r.prefs = { lang: await exec("prefs.get", { key: "general.interfaceLanguage" }), mode: await exec("prefs.get", { key: "appearance.appearanceMode" }),
        accent: await exec("prefs.get", { key: "appearance.highlightColor" }) };
      if (r.prefs.lang !== "fr" || r.prefs.mode !== "dark" || String(r.prefs.accent).toLowerCase() !== "#4f46e5") flag("INIT-PREFS", `préférences : ${JSON.stringify(r.prefs)}`);
      // 4. evora:open d'un projet neuf, puis evora:request-save sans rien à enregistrer
      const R1 = await ulid();
      const openNew = await send(await msg("evora:open", { docRef: R1, name: "evora-neuf.fcproj", new: true }));
      const openNewAck = await waitFor(answer(openNew, "evora:ack"), 15000);
      const cleanAfterNew = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:dirty" && m.payload?.docRef === R1 && m.payload?.dirty === false), 5000);
      r.openNew = { ack: openNewAck?.payload ?? null, dirty: !!cleanAfterNew, project: await exec("project.inspect") };
      if (openNewAck?.payload?.ok !== true || !cleanAfterNew || r.openNew.project?.path !== `/evora/${R1}/evora-neuf.fcproj` || r.openNew.project?.name !== "evora-neuf") {
        flag("OPEN", `projet neuf : ${JSON.stringify(r.openNew)}`);
      }
      const rsClean = await send(await msg("evora:request-save", { reason: "user" }));
      const rsCleanAck = await waitFor(answer(rsClean), 15000);
      r.requestSaveClean = rsCleanAck ? { type: rsCleanAck.type, payload: rsCleanAck.payload } : null;
      if (rsCleanAck?.type !== "evora:ack" || rsCleanAck.payload?.ok !== true || rsCleanAck.payload?.code !== "clean") flag("REQUEST-SAVE", `rien à enregistrer : ${JSON.stringify(r.requestSaveClean)}`);
      // 5. plafond (+1 octet) et vue typée à la place d'un ArrayBuffer
      const tooBig = await send(await msg("evora:open", { docRef: await ulid(), name: "trop-grand.fcproj" }), LIMIT + 1);
      const tooBigAck = await waitFor(answer(tooBig, "evora:ack"), 10000);
      r.tooLarge = tooBigAck?.payload ?? null;
      if (tooBigAck?.payload?.ok !== false || tooBigAck?.payload?.code !== "too_large") flag("PLAFOND", `plafond + 1 octet : ${JSON.stringify(r.tooLarge)}`);
      const view = await send(await msg("evora:open", { docRef: await ulid(), name: "vue.fcproj" }), "view");
      // 6. evora:open du projet de test en octets transférés
      const R2 = await ulid();
      const open = await send(await msg("evora:open", { docRef: R2, name: "evora-smoke.fcproj" }), String(fixture));
      const openAck = await waitFor(answer(open, "evora:ack"), 20000);
      const cleanAfterOpen = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:dirty" && m.payload?.docRef === R2 && m.payload?.dirty === false), 5000);
      r.open = { ack: openAck?.payload ?? null, dirty: !!cleanAfterOpen, project: await exec("project.inspect") };
      if (openAck?.payload?.ok !== true || !cleanAfterOpen || r.open.project?.path !== `/evora/${R2}/evora-smoke.fcproj` || r.open.project?.name !== "evora-smoke") {
        flag("OPEN", `projet en octets : ${JSON.stringify(r.open)}`);
      }
      // 7. une modification : evora:dirty ; en mode hôte, rien n'est gardé dans le navigateur (E5,
      //    HOST-PROTOCOL §7.7 : le stockage n'est qu'un cache) : aucun instantané de récupération,
      //    même passé l'intervalle de l'instantané amont (5 s)
      await exec("file.newSequence", { name: "E4-a" });
      const dirtyMsg = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:dirty" && m.payload?.docRef === R2 && m.payload?.dirty === true), 10000);
      if (!dirtyMsg) flag("DIRTY", "aucun evora:dirty {dirty: true} après une modification");
      await sleep(7000);
      const afterEdit = await list();
      const added = Array.isArray(afterEdit) && Array.isArray(afterInit) ? afterEdit.filter((p) => !afterInit.includes(p)) : null;
      r.afterEdit = { list: afterEdit, added };
      if (!added || added.length !== 0 || afterEdit.some((p) => /(^|\/)recovery\/(snapshot\.fcproj|meta\.json)$/.test(p))) {
        flag("NS-ECRITURE", `écriture dans le navigateur après une modification en mode hôte : ${JSON.stringify(r.afterEdit)}`);
      }
      // storage.ns : ce que le moteur écrit encore dans OPFS (une copie sous /opfs/) va sous l'espace
      // du compte, jamais à la racine
      const probe = await exec("file.saveCopy", { path: "/opfs/evora-lab/sonde.fcproj" });
      const PROBE = `evora-corte/${NS}/evora-lab/sonde.fcproj`;
      let afterProbe = [];
      for (let i = 0; i < 20; i++) {
        afterProbe = await list();
        if (Array.isArray(afterProbe) && afterProbe.includes(PROBE)) break;
        await sleep(500);
      }
      r.nsProbe = { result: probe, list: afterProbe };
      if (!Array.isArray(afterProbe) || !afterProbe.includes(PROBE) || afterProbe.some((p) => p.startsWith("evora-lab/"))) flag("NS", `copie hors de l'espace du compte : ${JSON.stringify(r.nsProbe)}`);
      // 8. intrusions : autre fenêtre de même origine (jumeau), autre origine (intrus), enveloppes fautives
      const j1 = await msg("evora:request-save", { reason: "user" });
      const j2 = await msg("evora:purge", { scope: "all" });
      const i1 = await msg("evora:request-save", { reason: "user" });
      const i2 = await msg("evora:purge", { scope: "all" });
      await relay("jumeau", [j1, j2]);
      await relay("intrus", [i1, i2]);
      const x1 = await send({ ...(await msg("evora:request-save", { reason: "user" })), extra: 1 });
      const x2 = await send({ ...(await msg("evora:request-save", { reason: "user" })), v: "1" });
      const x3 = await send({ ...(await msg("evora:request-save", { reason: "user" })), re: await ulid() });
      const relayed = await waitFor((log) => {
        const got = log.filter((m) => !m.fromEngine && m.data && m.data.relayed === 2);
        return got.length >= 2 ? got : null;
      }, 10000);
      await sleep(3000);
      const logNow = fromEngine(await getLog());
      const answered = (id) => logNow.some((m) => m.re === id);
      r.intrusions = { relayed: relayed ? relayed.map((m) => m.origin) : null, jumeau: [j1.id, j2.id].map(answered), intrus: [i1.id, i2.id].map(answered),
        schema: { n0: answered(n0), view: answered(view), x1: answered(x1), x2: answered(x2), x3: answered(x3) }, v2: answered(n1) };
      if (!relayed) flag("PREMISSE", "les relais jumeau et intrus n'ont pas confirmé l'envoi : la mesure ne prouve rien");
      if (r.intrusions.jumeau.some(Boolean)) flag("SOURCE", `réponse à un message d'une autre fenêtre de même origine : ${JSON.stringify(r.intrusions.jumeau)}`);
      if (r.intrusions.intrus.some(Boolean)) flag("ORIGINE", `réponse à un message d'une origine non admise : ${JSON.stringify(r.intrusions.intrus)}`);
      if (r.intrusions.v2) flag("V2", "réponse à un message de version 2");
      if (Object.values(r.intrusions.schema).some(Boolean)) flag("SCHEMA", `réponse à un message hors schéma : ${JSON.stringify(r.intrusions.schema)}`);
      const afterIntrusions = await list();
      if (!Array.isArray(afterIntrusions) || !afterIntrusions.includes(PROBE)) flag("ORIGINE", `stockage effacé par une intrusion : ${JSON.stringify(afterIntrusions)}`);
      // 9. evora:request-save avec des modifications : evora:save conforme (re), puis evora:saved
      const rs = await send(await msg("evora:request-save", { reason: "autosave" }));
      const save = await waitFor(answer(rs), 20000);
      r.save = save ? { type: save.type, keys: save.payloadKeys, payload: save.payload } : null;
      const sp = save?.payload ?? {};
      if (save?.type !== "evora:save" || JSON.stringify(save.payloadKeys) !== JSON.stringify(["docRef", "name", "saveAs", "bytes"]) || sp.docRef !== R2 ||
        sp.name !== "evora-smoke.fcproj" || sp.saveAs !== false || !(sp.bytes?.arrayBuffer >= 1) || sp.bytes?.format !== "filmcraft.project") {
        flag("SAVE", `réponse à evora:request-save : ${JSON.stringify(r.save)}`);
      }
      if (save) await send(await msg("evora:saved", { ok: true, version: 2 }, { re: save.id }));
      const cleanAfterSave = await waitFor((log) => fromEngine(log).filter((m) => m.type === "evora:dirty" && m.payload?.docRef === R2).at(-1)?.payload?.dirty === false, 10000);
      if (!cleanAfterSave) flag("DIRTY", "aucun evora:dirty {dirty: false} après l'enregistrement");
      // enregistrement demandé dans le moteur (Ctrl+S) : evora:save sans re
      await exec("file.newSequence", { name: "E4-b" });
      const savesBefore = fromEngine(await getLog()).filter((m) => m.type === "evora:save").length;
      await exec("file.save");
      const ownSave = await waitFor((log) => {
        const saves = fromEngine(log).filter((m) => m.type === "evora:save");
        return saves.length > savesBefore ? saves.at(-1) : null;
      }, 10000);
      r.ownSave = ownSave ? { hasRe: ownSave.hasRe, payload: ownSave.payload } : null;
      if (!ownSave || ownSave.hasRe || ownSave.payload?.docRef !== R2 || ownSave.payload?.bytes?.format !== "filmcraft.project") flag("SAVE", `enregistrement demandé dans le moteur : ${JSON.stringify(r.ownSave)}`);
      if (ownSave) await send(await msg("evora:saved", { ok: false, error: "conflict" }, { re: ownSave.id }));
      // 10. live.theme et live.lang
      const th = await send(await msg("evora:theme", { theme: "light", accent: "#4F46E5" }));
      const thAck = await waitFor(answer(th, "evora:ack"), 10000);
      const la = await send(await msg("evora:lang", { lang: "es", engineLang: "es" }));
      const laAck = await waitFor(answer(la, "evora:ack"), 10000);
      await sleep(500);
      const items = await inChild("filmcraft.request('ui.menu.list')").catch(() => []);
      r.live = { theme: thAck?.payload ?? null, mode: await exec("prefs.get", { key: "appearance.appearanceMode" }), lang: laAck?.payload ?? null,
        language: await exec("prefs.get", { key: "general.interfaceLanguage" }), saveAs: (Array.isArray(items) ? items : []).find((m) => m.id === "file.saveAs")?.label ?? null };
      if (thAck?.payload?.ok !== true || r.live.mode !== "light") flag("THEME", `evora:theme : ${JSON.stringify(r.live)}`);
      if (laAck?.payload?.ok !== true || r.live.language !== "es" || (path === "/index.html" && r.live.saveAs !== "Guardar como…")) flag("LANG", `evora:lang : ${JSON.stringify(r.live)}`);
      // 11. evora:purge pendant des modifications : accusé APRÈS effacement, puis plus aucune écriture
      await exec("file.newSequence", { name: "E4-c" });
      const pg = await send(await msg("evora:purge", { scope: "current" }));
      const pgAck = await waitFor(answer(pg, "evora:ack"), 20000);
      const atAck = await list();
      // après l'accusé, une écriture du moteur (copie sous /opfs/) n'atteint plus le stockage
      const afterPurgeWrite = await exec("file.saveCopy", { path: "/opfs/evora-lab/apres-purge.fcproj" });
      for (let i = 0; i < 4; i++) {
        await exec("file.newSequence", { name: `E4-apres-${i}` });
        await sleep(2000);
      }
      const later = await list();
      const web = await inChild("(async () => ({ localStorage: Object.keys(localStorage), indexedDB: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : 'n/a' }))()").catch((e) => String(e));
      r.purge = { ack: pgAck?.payload ?? null, atAck, afterPurgeWrite, later, web, storage: (await inChild("filmcraft.info()").catch(() => null))?.storage ?? null };
      const engineLeft = (all) => !Array.isArray(all) || all.some((p) => (p.startsWith("evora-corte/") && p !== "evora-corte/") || ["recovery/", "media/", "evora-lab/"].includes(p));
      if (pgAck?.payload?.ok !== true) flag("PURGE", `accusé d'evora:purge absent ou négatif : ${JSON.stringify(pgAck)}`);
      if (engineLeft(atAck)) flag("PURGE", `stockage du moteur encore présent à l'accusé : ${JSON.stringify(atAck)}`);
      if (engineLeft(later)) flag("PURGE", `stockage du moteur réécrit après la purge : ${JSON.stringify(later)}`);
      if (!Array.isArray(later) || !later.includes("autre-moteur/garder.txt")) flag("PURGE", `la purge a effacé le stockage d'un autre moteur : ${JSON.stringify(later)}`);
      if (typeof web !== "object" || web.localStorage?.length !== 0 || (Array.isArray(web.indexedDB) && web.indexedDB.length !== 0)) flag("PURGE", `localStorage ou IndexedDB non vides : ${JSON.stringify(web)}`);
      // 12. toute enveloppe reçue du moteur est conforme (§3, §4.4, §4.5)
      const all = fromEngine(await getLog());
      const ids = new Set();
      for (const m of all) {
        const p = m.payload ?? {};
        const k = m.payloadKeys ?? [];
        const sub = (allowed) => k.every((x) => allowed.includes(x));
        let ok = m.plain && m.vType === "number" && m.v === 1 && ULID.test(String(m.id)) && !ids.has(m.id) && m.payloadPlain &&
          (m.keys ?? []).every((x) => ["v", "type", "id", "re", "payload"].includes(x)) && (!m.hasRe || ULID.test(String(m.re)));
        ids.add(m.id);
        if (m.type === "evora:ack") ok = ok && m.hasRe && sub(["ok", "code", "result"]) && typeof p.ok === "boolean" && (p.code === undefined || ACK_CODES.includes(p.code)) && (p.ok || p.code !== undefined);
        else if (m.type === "evora:dirty") ok = ok && !m.hasRe && sub(["dirty", "docRef"]) && typeof p.dirty === "boolean" && (p.docRef === undefined || ULID.test(p.docRef));
        else if (m.type === "evora:save") ok = ok && sub(["docRef", "name", "saveAs", "bytes"]) && k.length === 4 && ULID.test(String(p.docRef)) && p.bytes?.arrayBuffer >= 1;
        else if (m.type === "evora:ready") ok = ok && !m.hasRe;
        else if (m.type === "evora:failed") ok = ok && FAIL_CODES.includes(p.code);
        else ok = false;
        if (!ok) flag("ENVELOPPE", `message hors norme : ${JSON.stringify(m).slice(0, 300)}`);
      }
      const failed = all.filter((m) => m.type === "evora:failed");
      if (failed.length) flag("DEMARRAGE", `evora:failed reçu : ${JSON.stringify(failed)}`);
      r.messages = all.map((m) => m.type + (m.hasRe ? ` (re ${String(m.re).slice(-4)})` : ""));
      return { bad, r };
    }

    const real = await pontEhp("/index.html");
    report.ehp.engine = real.r;
    report.ehp.engineFailures = real.bad;
    for (const b of real.bad) fail(`E4 [EHP-${b.tag}] ${b.text}`);
    // Témoin sabordé : le même banc contre un faux moteur fautif doit relever chacune de ses fautes.
    const witness = await pontEhp("/__temoin/index.html");
    const tags = [...new Set(witness.bad.map((b) => b.tag))].sort();
    const mustFlag = ["NS", "NS-ECRITURE", "ORIGINE", "PURGE", "READY", "SCHEMA", "SOURCE", "V2"];
    report.ehp.witness = { tags, failures: witness.bad.length, run: witness.r.intrusions ?? null };
    const missed = mustFlag.filter((t) => !tags.includes(t));
    if (missed.length) fail(`E4 [EHP-TEMOIN] le banc n'a pas rougi contre le témoin sabordé sur : ${missed.join(", ")} (relevé : ${tags.join(", ")})`);
    hostConfig = null;
  }

  // E5 (mesure) : clés localStorage et bases IndexedDB réellement présentes pour l'origine moteur
  report.storage = await inChild(
    "(async () => ({ localStorage: Object.keys(localStorage), indexedDB: (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : 'n/a') }))()",
  ).catch((e) => String(e));

  // erreurs : toutes celles de la parente, et celles des documents du moteur qui ont démarré (un
  // premier document abandonné pour le repli ?webgl ne compte pas)
  report.events = events;
  const blocking = events.filter(
    (e) =>
      (e.kind === "exception" || e.kind === "console.error" || e.kind === "log.error") &&
      (e.role === "parent" ? true : e.role === "iframe" ? okGens.has(e.gen) : e.role !== "browser"),
  );
  report.blockingEvents = blocking;
  for (const e of blocking) fail(`${e.role} ${e.kind}${e.source ? " [" + e.source + "]" : ""} : ${String(e.text).slice(0, 400)}`);
  const unknown404 = report.requests.filter((r) => r.status !== 200);
  if (unknown404.length) fail(`requêtes en erreur : ${JSON.stringify(unknown404)}`);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, ps).catch(() => null);
  if (shot) writeFileSync(join(out, "fumee.png"), Buffer.from(shot.data, "base64"));
  exitCode = report.failures.length ? 1 : 0;
} catch (e) {
  fail(String(e && e.stack ? e.stack : e));
  exitCode = 1;
} finally {
  writeFileSync(join(out, "fumee.json"), JSON.stringify(report, null, 2));
  if (proc) proc.kill("SIGKILL");
  engine.close();
  parent.close();
  intruder.close();
}

const L = report.load ?? {};
console.log(
  [
    `Navigateur : ${report.browser ?? "?"} ; iframe : ${report.iframeMode ?? "?"} ; bac à sable Chrome : ${report.chromeSandbox === false ? "non (--no-sandbox)" : "oui"}`,
    `Origines : parente ${report.origins.parent}, moteur ${report.origins.engine} ; lecture de l'iframe par la parente : ${report.checks.parentReadsIframe ?? "?"}`,
    `Démarrage à froid : readyMs ${L.readyMs ?? "?"} ms (wasm instancié à ${L.wasmMs ?? "?"} ms), de la navigation au moteur prêt ${report.wallToReadyMs ?? "?"} ms ; repli WebGL : ${L.search && L.search.includes("webgl") ? "oui" : "non"}`,
    `Canevas : ${JSON.stringify(report.checks.canvas ?? null)}`,
    `Au rendu (menus) : ${Object.keys(report.rendered?.languages ?? {}).length} langues, émojis ${report.rendered?.emoji.length ?? "?"} (${emojiMode}), termes sensibles ${report.rendered?.terms.length ?? "?"} (${termsMode})`,
    `Événements journalisés : ${report.events?.length ?? 0} ; bloquants : ${report.blockingEvents?.length ?? "?"}`,
    ...(report.events ?? []).map((e) => `  - ${e.role} gen ${e.gen} ${e.kind}${e.source ? " [" + e.source + "]" : ""} : ${String(e.text).replace(/\n/g, " ").slice(0, 300)}`),
    `Liens (E7) : ${JSON.stringify(report.links ?? null)}`,
    `Langue imposée (E3) : ${JSON.stringify(report.lang ?? "non vérifiée")}`,
    `Stockage (E5, correctif) : ${JSON.stringify(report.storageE5 ?? "non vérifié")}`,
    `Thème (E2) : ${JSON.stringify(report.theme ?? "non vérifié")}`,
    `Pont EHP (E4, scénario pont-ehp) : ${JSON.stringify(report.ehp ?? "non vérifié")}`,
    `Stockage navigateur hors OPFS (mesure E5) : ${JSON.stringify(report.storage ?? null)}`,
    `Info moteur : ${JSON.stringify(report.info ?? null).slice(0, 600)}`,
    report.failures.length ? `ROUGE (${report.failures.length} échec(s))` : "VERT",
  ].join("\n"),
);
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    "### Test de fumée (Chrome sans interface, deux origines)",
    "",
    `- Navigateur : ${report.browser ?? "?"} ; iframe : ${report.iframeMode ?? "?"} ; bac à sable Chrome : ${report.chromeSandbox === false ? "non (--no-sandbox)" : "oui"}`,
    `- Parente \`${report.origins.parent}\`, moteur \`${report.origins.engine}\` ; lecture du document de l'iframe par la parente : \`${report.checks.parentReadsIframe ?? "?"}\``,
    `- **Démarrage à froid** : \`readyMs\` ${L.readyMs ?? "?"} ms (wasm instancié à ${L.wasmMs ?? "?"} ms) ; navigation → moteur prêt ${report.wallToReadyMs ?? "?"} ms ; repli WebGL : ${L.search && L.search.includes("webgl") ? "oui" : "non"}`,
    `- Canevas : \`${JSON.stringify(report.checks.canvas ?? null)}\``,
    `- Au rendu (menus, ${Object.keys(report.rendered?.languages ?? {}).length} langues) : émojis ${report.rendered?.emoji.length ?? "?"} (\`${emojiMode}\`), termes sensibles ${report.rendered?.terms.length ?? "?"} (\`${termsMode}\`)`,
    `- Liens vers l'extérieur (E7) : ${JSON.stringify(report.links ?? null)}`,
    `- Langue imposée (E3) : ${JSON.stringify(report.lang ?? "non vérifiée")}`,
    `- Stockage (E5, correctif) : ${JSON.stringify(report.storageE5 ?? "non vérifié")}`,
    `- Thème (E2) : ${JSON.stringify(report.theme ?? "non vérifié")}`,
    `- Pont EHP (E4, scénario pont-ehp) : moteur ${JSON.stringify(report.ehp?.engine?.messages ?? "non vérifié")} ; témoin sabordé relevé : ${JSON.stringify(report.ehp?.witness?.tags ?? null)}`,
    `- Stockage navigateur hors OPFS (mesure E5) : ${JSON.stringify(report.storage ?? null)}`,
    `- Événements bloquants : ${report.blockingEvents?.length ?? "?"} ; verdict : **${report.failures.length ? "ROUGE" : "VERT"}**`,
    ...report.failures.map((f) => `  - ${f.replace(/\n/g, " ").slice(0, 300)}`),
  ].join("\n");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n\n", { flag: "a" });
}
process.exit(exitCode);
