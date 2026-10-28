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
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
// Arguments : un argument inconnu ou sans sa valeur arrête la fumée (code 2), et chaque famille de
// contrôles est exigée : un drapeau retiré ou renommé dans le workflow ne saute plus une famille en
// silence (« non vérifié » avec un verdict vert).
const VALUED = ["site", "csp", "out", "chrome", "emoji", "terms", "timeout", "commands"];
const FAMILIES = ["lang-checks", "storage-checks", "theme-checks", "ehp-checks"];
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i].startsWith("--") ? process.argv[i].slice(2) : null;
  if (k && VALUED.includes(k) && i + 1 < process.argv.length) i++;
  else if (!(k && FAMILIES.includes(k))) {
    console.error(`::error::argument inconnu ou incomplet : ${process.argv[i]}`);
    process.exit(2);
  }
}
const missingFamilies = FAMILIES.filter((f) => !process.argv.includes(`--${f}`));
if (missingFamilies.length) {
  console.error(`::error::familles de contrôles absentes : ${missingFamilies.join(", ")}`);
  process.exit(2);
}
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
// COR-FK-B1 : catalogue des commandes du moteur (evora:commands, anglais), écrit pour l'artefact
const commandsOut = arg("commands", "");
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

// COR-FK-B1 : média de fumée (WAV PCM 16 bits mono, 48 kHz, 30 s : trois blocs de lecture de 1 Mio),
// servi par le moteur (import hors pont) et par la parente, qui joue Drive : /__media/<nom>.wav?t=<jeton>,
// une seule plage bornée, CORS limité à l'origine du moteur, Content-Range exposé, latence injectée ;
// jeton x403 : la sonde et le premier bloc passent, toute lecture au-delà répond 403 (l'URL expire en
// cours de lecture, comme une URL signée à son échéance). Chaque requête
// est journalisée (méthode, plage, origine, cookie).
const wav = (seconds, rate = 48000) => {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};
const MEDIA_WAV = wav(30);
const MEDIA_NAMES = /^\/__media\/(clip-[abc]|pick-a|drop-a|temoin-suffixe|temoin-include)\.wav$/;
const MEDIA_LATENCY_MS = 400;
const mediaLog = [];
const downloadEvents = [];

// COR-FK-B1 : espion posé sur chaque document du moteur (scénario pont-v1) : sélecteurs du navigateur
// et téléchargements par ancre comptés (jamais ouverts), et, sous ?wgfail sans ?webgl, un WebGPU dont
// le périphérique ne se crée pas (le moteur doit se recharger en ?webgl en gardant host=evora).
const SPY_JS = `(() => {
  const S = (window.__spy = { picker: 0, download: 0 });
  if (window.showOpenFilePicker) window.showOpenFilePicker = function () { S.picker++; return Promise.reject(new DOMException("espion", "AbortError")); };
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === "file") { S.picker++; return; } return click.call(this); };
  const aclick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { S.download++; return; } return aclick.call(this); };
  const q = new URLSearchParams(location.search);
  if (q.has("wgfail") && !q.has("webgl") && navigator.gpu) {
    const ra = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...a) => { const ad = await ra(...a); if (ad) ad.requestDevice = () => Promise.reject(new Error("requestDevice failed (fumée Evora : repli WebGL)")); return ad; };
  }
})();`;

function serveMedia(req, res, url) {
  const entry = { t: Date.now(), method: req.method, path: url.pathname, token: url.searchParams.get("t"), range: req.headers.range ?? null,
    origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null, status: 0 };
  mediaLog.push(entry);
  const cors = { "Access-Control-Allow-Origin": engineOrigin, Vary: "Origin", "Access-Control-Expose-Headers": "Content-Range, Content-Length",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const reply = (status, headers, body) => {
    entry.status = status;
    setTimeout(() => { res.writeHead(status, { ...cors, ...headers }); res.end(body); }, MEDIA_LATENCY_MS);
  };
  if (!MEDIA_NAMES.test(url.pathname)) return reply(404, { "Content-Type": "text/plain" }, "not found");
  if (req.method === "OPTIONS") return reply(204, { "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "range", "Access-Control-Max-Age": "0" }, "");
  if (req.method !== "GET") return reply(405, {}, "");
  const m = /^bytes=(\d+)-(\d*)$/.exec(entry.range ?? "");
  if (!m) return reply(416, { "Content-Range": `bytes */${MEDIA_WAV.length}` }, "");
  const a = Number(m[1]);
  const b = m[2] === "" ? MEDIA_WAV.length - 1 : Math.min(Number(m[2]), MEDIA_WAV.length - 1);
  // l'URL expire en cours de lecture : l'en-tête (premier bloc de 1 Mio) se lit, la suite répond 403
  if (entry.token === "x403" && a >= 1048576) return reply(403, { "Content-Type": "text/plain" }, "expired");
  if (a > b) return reply(416, { "Content-Range": `bytes */${MEDIA_WAV.length}` }, "");
  return reply(206, { "Content-Type": "audio/wav", "Content-Range": `bytes ${a}-${b}/${MEDIA_WAV.length}`, "Content-Length": String(b - a + 1) }, MEDIA_WAV.subarray(a, b + 1));
}
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
      if (cmd === "file.saveCopy") { const to = String(p.path || ""); const rel = to.startsWith("/opfs/") ? to.slice(6) : to; await write(rel); if (ns) await write("evora-corte/" + ns + "/" + rel); return {}; }
      if (cmd === "file.save") { save(); return {}; }
      return {};
    },
    request: async () => [],
    info: () => ({ ehp: "ready", storage: "namespace", opfs: true }),
    injectPanic: () => { setTimeout(() => { throw new WebAssembly.RuntimeError("unreachable"); }, 0); },
  };
  addEventListener("message", (e) => {
    const d = e.data, p = (d && d.payload) || {};
    if (!d || typeof d !== "object") return;
    if (d.type === "evora:init") {
      ns = p.storageNs; prefs["general.interfaceLanguage"] = p.engineLang || "en"; prefs["appearance.appearanceMode"] = p.theme;
      (async () => {
        let ok = true;
        try { const e = await (await navigator.storage.getDirectory()).getDirectoryHandle("evora-corte"); for await (const [n] of e.entries()) if (n !== ns) await e.removeEntry(n, { recursive: true }); }
        catch (err) { if (err.name !== "NotFoundError") ok = false; }
        post("evora:ack", ok ? { ok: true } : { ok: false, code: "busy" }, d.id);
      })();
    }
    else if (d.type === "evora:open") { docRef = p.docRef; name = String(p.name || "").replace(/\\.fcproj$/, ""); path = "/evora/" + docRef + "/" + p.name; dirty = false; post("evora:ack", { ok: true }, d.id); post("evora:dirty", { dirty: false, docRef }); }
    else if (d.type === "evora:request-save") requestAnimationFrame(() => { if (dirty) save(d.id); else post("evora:ack", { ok: true, code: "clean" }, d.id); });
    else if (d.type === "evora:lang") { prefs["general.interfaceLanguage"] = p.engineLang || "en"; post("evora:ack", { ok: true }, d.id); }
    else if (d.type === "evora:theme") { prefs["appearance.appearanceMode"] = p.theme; post("evora:ack", { ok: true }, d.id); }
    else if (d.type === "evora:purge") post("evora:ack", { ok: true }, d.id);
  });
  const ready = { app: "corte", version: "0.0.0", ehp: "1.0", capabilities: ["doc.open", "doc.save", "doc.dirty", "doc.request-save", "storage.ns", "storage.purge", "live.lang", "live.theme"] };
  post("evora:ready", ready);
  post("evora:ready", ready);
})();
`;

// E5 : « second onglet » du même moteur (même origine que lui, servi par le banc sous /__verrou/) :
// sur demande de la page parente, il prend le verrou OPFS du moteur (Web Locks, « evora-corte-opfs »),
// ouvre un flux d'écriture sur le chemin donné, le garde ouvert le temps demandé, le ferme et rend le
// verrou. Un flux ouvert fait échouer l'effacement du dossier (NoModificationAllowedError) : une purge
// qui n'attend pas le verrou échoue ou passe avant la libération.
const VERROU_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>verrou</title></head>
<body><script src="verrou.js"></script></body></html>`;
const VERROU_JS = `(() => {
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== parent || !d || d.op !== "hold") return;
    const say = (verrou) => parent.postMessage({ verrou, t: Date.now() }, e.origin);
    if (!navigator.locks) { say("absent"); return; }
    navigator.locks.request("evora-corte-opfs", { mode: "exclusive" }, async () => {
      try {
        const parts = String(d.path).split("/");
        let dir = await navigator.storage.getDirectory();
        for (const s of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write("verrou");
        say("held");
        await new Promise((res) => setTimeout(res, d.ms));
        await w.close();
        say("released");
      } catch (err) { say("erreur " + err.name); }
    });
  });
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
    if (typeof File !== "undefined" && v instanceof File) return { file: v.name, size: v.size, type: v.type };
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
    log.push({ t: Date.now(), fromEngine: e.source === frame.contentWindow && e.origin === engineOrigin(), origin: e.origin, plain,
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
    hide: (on) => { frame.style.display = on ? "none" : "block"; return frame.style.display; },
    // le « second onglet » n'est créé qu'à la première demande : l'iframe du moteur est alors déjà
    // attachée au banc, et reste la seule à laquelle il parle (inChild)
    verrou: (path, ms) => {
      let f = document.getElementById("verrou");
      const go = () => f.contentWindow.postMessage({ op: "hold", path, ms }, engineOrigin());
      if (f) { go(); return true; }
      f = document.createElement("iframe");
      f.id = "verrou";
      f.title = "verrou";
      f.style.cssText = "border:0;width:8px;height:8px";
      f.addEventListener("load", go, { once: true });
      f.src = engineOrigin() + "/__verrou/index.html";
      document.body.appendChild(f);
      return true;
    },
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
    // COR-FK-B1 : les médias de Drive, par URL signée, sous un seul chemin (comme le vhost de production)
    `connect-src 'self' ${parentOrigin}/__media/`,
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
  if (MEDIA_NAMES.test(url.pathname)) {
    report.requests.push({ origin: "A", path: url.pathname, status: 200 });
    res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(MEDIA_WAV);
    return;
  }
  const memory = {
    "/__temoin/index.html": [TEMOIN_HTML, ".html"],
    "/__temoin/temoin.js": [TEMOIN_JS, ".js"],
    "/__verrou/index.html": [VERROU_HTML, ".html"],
    "/__verrou/verrou.js": [VERROU_JS, ".js"],
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
  if (url.pathname.startsWith("/__media/")) return serveMedia(req, res, url);
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
  // génération du moteur -> index du journal à partir duquel un arrêt est provoqué exprès (E4 :
  // panique, abandon) : ses erreurs, attendues, ne comptent pas
  const crashAt = new Map();
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
        // l'iframe du moteur (les relais, même site que la parente, restent dans son processus ; le
        // « second onglet » /__verrou/, de même origine que le moteur, n'est jamais pris pour lui)
        const helper = String(info.url || "").includes("/__verrou/");
        if (isFrame && !helper && (!childSession || String(info.url || "").startsWith(engineOrigin))) childSession = p.sessionId;
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
      case "Browser.downloadWillBegin":
        downloadEvents.push({ url: p.url, name: p.suggestedFilename });
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

  // E3 : langue imposée par ?lang= (codes Evora ; zh-Hans → zh-cn ; pt en attente de D-23).
  // Depuis la v0.9.0 : it a un catalogue ; ko aussi, mais le build web n'a aucune police hangul :
  // la langue demandée au moteur est « ko » et le canevas reste en anglais (comme ja et zh-cn sans
  // police).
  if (langChecks) {
    report.lang = {};
    for (const [tag, code, saveAs] of [
      ["fr", "fr", "Enregistrer sous…"],
      ["it", "it", "Salva con nome…"],
      ["pt", "en", "Save As…"],
      ["ko", "ko", "Save As…"],
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
    // COR-FK-B1 : 18 capacités (accusé, export, médias, sélecteur, commandes et catalogue, sortie
    // clavier, activité, dépôt) ; la v0.9.0 en déclarait 8
    const EXPECTED_CAPS = ["command", "command.catalog", "doc.dirty", "doc.open", "doc.request-save", "doc.save", "doc.saved-ack", "drop.files",
      "export.drive", "live.lang", "live.theme", "media.need", "media.ranges", "pick.drive", "storage.ns", "storage.purge", "ui.activity", "ui.focus-out"];
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
    // durée pendant laquelle le « second onglet » garde le verrou et son flux ouvert
    const HOLD_MS = 4000;
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
      // (un moteur fautif qui a traité ces deux messages a fini de le faire avant la mise en place)
      await sleep(1500);
      // le bon evora:init arrive pendant qu'un second onglet du même moteur tient le verrou OPFS et un
      // flux d'écriture ouvert dans l'espace d'un autre compte : la purge de démarrage attend le
      // verrou, puis efface ; l'accusé suit la libération (E5, purge sans course entre onglets)
      await inParent(`window.__ehp.verrou(${JSON.stringify(`evora-corte/${OTHER}/recovery/verrou.bin`)}, ${HOLD_MS})`);
      const held = await waitFor((log) => log.find((m) => m.data && typeof m.data.verrou === "string" && m.data.verrou !== "released"), 10000);
      const init = await send(await msg("evora:init", initPayload, { re: ready.id }));
      const initAck = await waitFor(answer(init, "evora:ack"), 30000);
      const released = await waitFor((log) => log.find((m) => m.data && m.data.verrou === "released"), HOLD_MS + 10000);
      r.initAck = initAck?.payload ?? null;
      r.verrou = { held: held?.data?.verrou ?? null, heldAt: held?.t ?? null, releasedAt: released?.t ?? null, ackAt: initAck?.t ?? null };
      if (initAck?.payload?.ok !== true) flag("INIT", `accusé d'evora:init absent ou négatif : ${JSON.stringify(initAck)}`);
      if (r.verrou.held !== "held") flag("PREMISSE", `le second onglet n'a pas pris le verrou : ${JSON.stringify(r.verrou)}`);
      else if (initAck?.payload?.ok !== true || !released || initAck.t < released.t) flag("VERROU", `purge de démarrage pendant l'écriture d'un autre onglet : ${JSON.stringify(r.verrou)}, accusé ${JSON.stringify(r.initAck)}`);
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
      // 11. iframe masquée (display: none) : le navigateur ne lui donne plus aucune image
      //     (requestAnimationFrame), même onglet visible ; evora:request-save reçoit pourtant sa
      //     réponse (§7.2) : elle n'attend pas le retour de l'iframe à l'écran
      await exec("file.newSequence", { name: "E4-m" });
      const dirtyHidden = await waitFor((log) => fromEngine(log).filter((m) => m.type === "evora:dirty" && m.payload?.docRef === R2).at(-1)?.payload?.dirty === true, 10000);
      await inParent("window.__ehp.hide(true)");
      await sleep(1500);
      const rsHidden = await send(await msg("evora:request-save", { reason: "visibility" }));
      const saveHidden = await waitFor(answer(rsHidden), 10000);
      await inParent("window.__ehp.hide(false)");
      r.hidden = { dirty: !!dirtyHidden, answer: saveHidden ? { type: saveHidden.type, payload: saveHidden.payload } : null };
      if (!dirtyHidden) flag("PREMISSE", `aucune modification avant le masquage : ${JSON.stringify(r.hidden)}`);
      else if (saveHidden?.type !== "evora:save" || saveHidden.payload?.docRef !== R2 || saveHidden.payload?.bytes?.format !== "filmcraft.project") {
        flag("MASQUE", `réponse à evora:request-save, iframe masquée : ${JSON.stringify(r.hidden)}`);
      }
      if (saveHidden?.type === "evora:save") await send(await msg("evora:saved", { ok: true, version: 3 }, { re: saveHidden.id }));
      await sleep(1000);
      // 12. evora:purge pendant des modifications : accusé APRÈS effacement, puis plus aucune écriture
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
      // indexedDB.databases() absent : la mesure ne prouve rien, elle échoue
      if (typeof web !== "object" || web.localStorage?.length !== 0 || !Array.isArray(web.indexedDB) || web.indexedDB.length !== 0) flag("PURGE", `localStorage ou IndexedDB non vides ou non mesurés : ${JSON.stringify(web)}`);
      // 13. toute enveloppe reçue du moteur est conforme (§3, §4.4, §4.5)
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
        // COR-FK-B1 : messages du pont V1 (catalogue, besoin, sélecteur, export, activité, sortie, dépôt)
        else if (m.type === "evora:commands") ok = ok && !m.hasRe && k.length === 1 && k[0] === "commands" && Array.isArray(p.commands);
        else if (m.type === "evora:need") ok = ok && !m.hasRe && k.length === 2 && sub(["docRef", "paths"]) && ULID.test(String(p.docRef)) && Array.isArray(p.paths);
        else if (m.type === "evora:pick") ok = ok && !m.hasRe && sub(["purpose", "accept", "multiple", "forPath"]) && ["open", "import", "relink"].includes(p.purpose);
        else if (m.type === "evora:export") ok = ok && !m.hasRe && sub(["docRef", "name", "mime", "bytes"]) && p.bytes?.arrayBuffer >= 1;
        else if (m.type === "evora:activity") ok = ok && !m.hasRe && k.length === 2 && sub(["busy", "kind"]) && typeof p.busy === "boolean";
        else if (m.type === "evora:focus-out") ok = ok && !m.hasRe && k.length === 0;
        else if (m.type === "evora:drop") ok = ok && !m.hasRe && k.length === 2 && sub(["purpose", "files"]) && p.purpose === "import";
        else if (m.type === "evora:failed") ok = ok && FAIL_CODES.includes(p.code);
        else ok = false;
        if (!ok) flag("ENVELOPPE", `message hors norme : ${JSON.stringify(m).slice(0, 300)}`);
      }
      const failed = all.filter((m) => m.type === "evora:failed");
      if (failed.length) flag("DEMARRAGE", `evora:failed reçu : ${JSON.stringify(failed)}`);
      r.messages = all.map((m) => m.type + (m.hasRe ? ` (re ${String(m.re).slice(-4)})` : ""));
      // 14. second chargement : l'espace du compte effacé par un autre onglet (changement de compte)
      //     n'est jamais recréé par une écriture ; le moteur ferme alors OPFS pour de bon (E5)
      await inParent("window.__ehp.clear()");
      const second = await reload("host=evora&lang=en&theme=dark&second", path);
      const ready2 = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:ready"), 20000);
      if (!second?.readyMs || !ready2) {
        flag("DEMARRAGE", `second chargement : ${JSON.stringify(second)}`);
        return { bad, r };
      }
      const init2 = await send(await msg("evora:init", initPayload, { re: ready2.id }));
      const init2Ack = await waitFor(answer(init2, "evora:ack"), 30000);
      if (init2Ack?.payload?.ok !== true) flag("INIT", `second chargement, accusé d'evora:init : ${JSON.stringify(init2Ack)}`);
      const SONDE = `evora-corte/${NS}/evora-lab/sonde-1.fcproj`;
      await exec("file.saveCopy", { path: "/opfs/evora-lab/sonde-1.fcproj" });
      let beforeRemoval = [];
      for (let i = 0; i < 20; i++) {
        beforeRemoval = await list();
        if (Array.isArray(beforeRemoval) && beforeRemoval.includes(SONDE) && !beforeRemoval.some((p) => p.endsWith(".crswap"))) break;
        await sleep(500);
      }
      // l'« autre onglet » purge comme le moteur : sous son verrou (il attend la fin d'une écriture)
      const removed = await inChild(`navigator.locks.request("evora-corte-opfs", { mode: "exclusive" }, async () => { const e = await (await navigator.storage.getDirectory()).getDirectoryHandle("evora-corte"); await e.removeEntry(${JSON.stringify(NS)}, { recursive: true }); return true; })`).catch((e) => String(e));
      const removalWrite = await exec("file.saveCopy", { path: "/opfs/evora-lab/sonde-2.fcproj" });
      await sleep(2000);
      const afterRemoval = await list();
      const storage2 = (await inChild("filmcraft.info()").catch(() => null))?.storage ?? null;
      r.recreation = { before: beforeRemoval, removed, write: removalWrite, after: afterRemoval, storage: storage2 };
      if (!Array.isArray(beforeRemoval) || !beforeRemoval.includes(SONDE) || removed !== true) flag("PREMISSE", `espace du compte avant l'effacement : ${JSON.stringify(r.recreation)}`);
      if (!Array.isArray(afterRemoval) || afterRemoval.some((p) => p.startsWith(`evora-corte/${NS}/`)) || storage2 !== "closed") {
        flag("RECREATION", `espace recréé après son effacement par un autre onglet : ${JSON.stringify(r.recreation)}`);
      }
      // 15. panique provoquée (injection de faute amont, FilmcraftApp::panic_next_frame) : le moteur
      //     s'arrête ; evora:failed {code: "panic"} une seule fois, et aucun texte du moteur à l'écran
      //     (la coquille affiche son propre message, §4.4)
      if (mode !== "oopif") {
        flag("PREMISSE", `iframe dans le processus de la parente (${mode}) : un arrêt provoqué ne peut pas être isolé`);
        return { bad, r };
      }
      const failedOf = (log) => fromEngine(log).filter((m) => m.type === "evora:failed");
      const screenOf = () => inChild("(() => { const f = document.getElementById('fatal'); return { fatal: !!(window.filmcraftLoad && window.filmcraftLoad.fatal), shown: !!(f && f.classList.contains('on')), text: f ? f.innerText.trim() : null }; })()").catch((e) => String(e));
      crashAt.set(sessions.get(childSession).gen, events.length);
      const injected = await inChild("typeof filmcraft.injectPanic === 'function' ? (filmcraft.injectPanic(), true) : 'absent'").catch((e) => String(e));
      await waitFor((log) => failedOf(log).length > 0, 15000);
      await sleep(2000);
      const panicFailed = failedOf(await getLog());
      r.panic = { injected, failed: panicFailed.map((m) => ({ keys: m.payloadKeys, payload: m.payload })), screen: await screenOf() };
      if (injected !== true) flag("PREMISSE", `injection de faute indisponible : ${JSON.stringify(r.panic)}`);
      else if (panicFailed.length !== 1 || JSON.stringify(panicFailed[0].payloadKeys) !== JSON.stringify(["code"]) || panicFailed[0].payload?.code !== "panic" ||
        typeof r.panic.screen !== "object" || !r.panic.screen.fatal || r.panic.screen.text !== "") {
        flag("PANIQUE", `après une panique : ${JSON.stringify(r.panic)}`);
      }
      // 16. troisième chargement : arrêt sans panique (abandon sur manque de mémoire : le crochet de
      //     panique ne joue pas) ; le repli de la page envoie evora:failed {code: "memory"} à l'origine
      //     admise par le pont, une seule fois
      await inParent("window.__ehp.clear()");
      const third = await reload("host=evora&lang=en&theme=dark&troisieme", path);
      const ready3 = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:ready"), 20000);
      if (!third?.readyMs || !ready3) {
        flag("DEMARRAGE", `troisième chargement : ${JSON.stringify(third)}`);
        return { bad, r };
      }
      crashAt.set(sessions.get(childSession).gen, events.length);
      const aborted = await inChild("(() => { console.error('memory allocation of 1048576 bytes failed'); dispatchEvent(new ErrorEvent('error', { error: new WebAssembly.RuntimeError('unreachable'), message: 'unreachable' })); return true; })()").catch((e) => String(e));
      await waitFor((log) => failedOf(log).length > 0, 10000);
      await sleep(1500);
      const memoryFailed = failedOf(await getLog());
      r.memory = { aborted, failed: memoryFailed.map((m) => m.payload), screen: await screenOf() };
      if (aborted !== true) flag("PREMISSE", `abandon simulé impossible : ${JSON.stringify(r.memory)}`);
      else if (memoryFailed.length !== 1 || memoryFailed[0].payload?.code !== "memory" || typeof r.memory.screen !== "object" || r.memory.screen.text !== "") {
        flag("MEMOIRE", `après un abandon sans panique : ${JSON.stringify(r.memory)}`);
      }
      return { bad, r };
    }

    const real = await pontEhp("/index.html");
    report.ehp.engine = real.r;
    report.ehp.engineFailures = real.bad;
    for (const b of real.bad) fail(`E4 [EHP-${b.tag}] ${b.text}`);
    // Témoin sabordé : le même banc contre un faux moteur fautif doit relever chacune de ses fautes.
    const witness = await pontEhp("/__temoin/index.html");
    const tags = [...new Set(witness.bad.map((b) => b.tag))].sort();
    const mustFlag = ["INIT-PURGE", "MASQUE", "MEMOIRE", "NS", "NS-ECRITURE", "ORIGINE", "PANIQUE", "PLAFOND", "PURGE", "READY", "RECREATION", "SAVE", "SCHEMA",
      "SOURCE", "V2", "VERROU"];
    report.ehp.witness = { tags, failures: witness.bad.length, run: witness.r.intrusions ?? null };
    const missed = mustFlag.filter((t) => !tags.includes(t));
    if (missed.length) fail(`E4 [EHP-TEMOIN] le banc n'a pas rougi contre le témoin sabordé sur : ${missed.join(", ")} (relevé : ${tags.join(", ")})`);
    hostConfig = null;

    // E4 (COR-FK-B1) : pont V1 (scénario « pont-v1 »), joué contre le moteur seul. Détecteurs : S-ACK
    // (accusé d'enregistrement), COMMANDS-CATALOG, COMMAND-ALLOWED, COMMAND-REFUSED, COMMAND-WHITELIST,
    // COMMAND-PARAMS, COMMAND-DESTRUCTIVE (règles 1 à 3 du pont de commandes, AVENANT-2026-10-27 §4),
    // FOCUS-OUT, SAVE-AS-ADOPT, S-MED (besoins par lots, URL signées lues par plages), S-MED-RENEW (URL expirée
    // renouvelée), ACTIVITY-EXPORT, S-EXP, S-PICK (sélecteur de la coquille, latence injectée),
    // S-PICK-SUFFIXE, S-PICK-INCLUDE, S-PICK-LOCAL, S-DROP, WEBGL-KEEPS-HOST, WRITE-NEW,
    // TELECHARGEMENT. Le témoin groupé de la livraison (commit EVORA-COR-NN « témoin », retiré à
    // l'octet) en rougit un ensemble prédit, exact ; les autres restent verts.
    async function pontV1() {
      const bad = [];
      const flag = (tag, text) => bad.push({ tag, text });
      const r = {};
      // plafonds du banc : le mixage WAV du montage (90 s) dépasse 16 Mio
      const BIG = 64 << 20;
      const V1_CAPS = [...EXPECTED_CAPS];
      const MEDIA_PATHS = ["/files/clip-a.wav", "/files/clip-b.wav", "/files/clip-c.wav"];
      const sortedKeys = (m) => JSON.stringify([...(m?.payloadKeys ?? [])].sort());
      const inspect = () => exec("project.inspect");
      const invoke = (id) => inChild(`filmcraft.request("ui.menu.invoke", { id: ${JSON.stringify(id)} }).then(() => true, (e) => "erreur : " + e.message)`).catch((e) => String(e));
      const ofType = (log, type) => fromEngine(log).filter((m) => m.type === type);
      const count = async (type) => ofType(await getLog(), type).length;
      const next = (type, n, ms) => waitFor((log) => { const l = ofType(log, type); return l.length > n ? l.at(-1) : null; }, ms);
      const lastDirty = (log, ref) => ofType(log, "evora:dirty").filter((m) => m.payload?.docRef === ref).at(-1)?.payload?.dirty;
      const dirtyIs = (ref, v, ms) => waitFor((log) => lastDirty(log, ref) === v, ms);
      const requestSave = async (reason, docRef) => waitFor(answer(await send(await msg("evora:request-save", docRef ? { reason, docRef } : { reason }))), 15000);
      const command = async (c, params = {}, extra = {}) => waitFor(answer(await send(await msg("evora:command", { command: c, params, ...extra })), "evora:ack"), 15000);
      const itemsOf = (bin, bins, items) => {
        for (const c of bin?.children ?? []) {
          if (Array.isArray(c.children)) { bins.push(c.name); itemsOf(c, bins, items); } else items.push(c.name);
        }
        return { bins, items };
      };
      const tree = async () => itemsOf((await inspect())?.root, [], []);
      const b64 = (v) => Buffer.from(String(v), "base64");
      const spyCounts = { picker: 0, download: 0 };
      const readSpy = async () => {
        const sp = await inChild("window.__spy ? { picker: window.__spy.picker, download: window.__spy.download } : null").catch(() => null);
        if (sp) {
          spyCounts.picker += sp.picker;
          spyCounts.download += sp.download;
          await inChild("(window.__spy.picker = 0, window.__spy.download = 0, true)").catch(() => {});
        }
        return sp;
      };
      // comme la coquille (§7.1, étape 5) : l'ensemble effectif est l'intersection de ce que le moteur
      // annonce et de ce que la configuration admet
      const initWith = async (ready, caps, extraLimits = {}) => {
        const announced = Array.isArray(ready.payload?.capabilities) ? ready.payload.capabilities : [];
        const init = await send(await msg("evora:init", { lang: "en", engineLang: "en", theme: "dark", accent: "#4F46E5", readOnly: false, storageNs: NS,
          capabilities: caps.filter((c) => announced.includes(c)), prefs: {}, limits: { maxDocumentBytes: BIG, maxExportBytes: BIG, ...extraLimits } }, { re: ready.id }));
        return waitFor(answer(init, "evora:ack"), 30000);
      };
      const start = async (query, caps = V1_CAPS, extraLimits = {}) => {
        await readSpy();
        await inParent("window.__ehp.clear()");
        const l = await reload(query);
        const ready = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:ready"), 20000);
        if (!l?.readyMs || !ready) { flag("DEMARRAGE", `${query} : ${JSON.stringify(l)}`); return null; }
        const ack = await initWith(ready, caps, extraLimits);
        if (ack?.payload?.ok !== true) { flag("INIT", `${query} : ${JSON.stringify(ack)}`); return null; }
        return ready;
      };
      const openDoc = async (docRef, name, bytes) => waitFor(answer(await send(await msg("evora:open", { docRef, name }), bytes), "evora:ack"), 20000);
      hostConfig = { parentOrigins: [parentOrigin] };
      await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: mkdtempSync(join(tmpdir(), "evora-dl-")), eventsEnabled: true }).catch(() => {});
      const spy = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SPY_JS }, childSession).catch((e) => ({ error: String(e) }));
      if (!spy?.identifier) { flag("PREMISSE", `espion non posé : ${JSON.stringify(spy)}`); return { bad, r }; }

      // 0. projet « médias » (hors pont) : trois WAV de l'origine du moteur importés, une séquence
      await reload("empty&norecover&fixture-medias");
      const imported = [];
      for (const n of ["clip-a", "clip-b", "clip-c"]) {
        imported.push(await inChild(`filmcraft.importUrl("/__media/${n}.wav").then((v) => (v.items && v.items.length ? v.items[0] : "aucun"), (e) => "erreur : " + e.message)`).catch((e) => String(e)));
      }
      const seq = await exec("file.newSequence", { fromItems: imported, name: "S-medias" });
      await exec("file.saveCopy", { path: "/opfs/evora-lab/medias.fcproj" });
      const mediaFixture = await inChild("filmcraft.readFile('/opfs/evora-lab/medias.fcproj').then((u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); }, (e) => 'erreur : ' + e)").catch((e) => String(e));
      let mediaFormat = null;
      try { mediaFormat = JSON.parse(b64(mediaFixture).toString("utf-8")).format; } catch {}
      r.mediaFixture = { imported, seq: typeof seq === "string" ? seq : "ok", format: mediaFormat, bytes: b64(mediaFixture).length };
      if (!imported.every((i) => typeof i === "number") || mediaFormat !== "filmcraft.project" || !MEDIA_PATHS.every((p) => b64(mediaFixture).toString("utf-8").includes(p))) {
        flag("PREMISSE", `projet « médias » : ${JSON.stringify(r.mediaFixture)}`);
      }

      // 1. mode hôte, toutes les capacités : le catalogue suit l'accusé d'evora:init
      let ready = await start("host=evora&lang=en&theme=dark&v1");
      if (!ready) return { bad, r };
      r.version = ready.payload?.version ?? null;
      const KEYS = JSON.stringify(["destructive", "enabled", "id", "label", "menu", "params"]);
      // AVENANT-2026-10-27 §4, règle 1 : les seuls `file.*` admis, un par un (créations dans le projet
      // ouvert, imports par le sélecteur de la coquille, exports vers le Drive) ; le reste de l'espace
      // de noms de la coquille (et File ▸ Project Settings) est refusé par construction
      const ADMIS = ["file.newSequence", "file.newSequenceFromClip", "file.newBin", "file.newBinFromSelection", "file.newSearchBin", "file.newOfflineFile",
        "file.newAdjustmentLayer", "file.newBarsAndTone", "file.newBlackVideo", "file.newColorMatte", "file.newCountingLeader", "file.newTransparentVideo",
        "file.import", "file.importImageSequence", "file.exportMedia", "file.exportEdl", "file.exportFcp7Xml", "file.exportFcpxml", "file.exportOtio",
        "file.exportAle", "file.exportAaf", "file.exportOmf"];
      const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
      // règle 2 : aucun paramètre, sauf le nom de file.newBin (seule clé déclarée)
      const noParams = (p) => isObj(p) && p.type === "object" && p.maxProperties === 0 && Object.keys(p).length === 2;
      const nameOnly = (p) => isObj(p) && p.type === "object" && p.additionalProperties === false && isObj(p.properties) &&
        JSON.stringify(Object.keys(p.properties)) === '["name"]' && p.properties.name?.type === "string";
      const checkCatalog = (m, where) => {
        const list = m?.payload?.commands;
        if (!m || sortedKeys(m) !== '["commands"]' || !Array.isArray(list) || list.length < 50) {
          flag("COMMANDS-CATALOG", `${where} : catalogue absent ou court (${Array.isArray(list) ? list.length : "?"})`);
          return null;
        }
        const ids = new Set();
        for (const c of list) {
          const ok = c && JSON.stringify(Object.keys(c).sort()) === KEYS && /^[a-z][A-Za-z0-9_.-]*$/.test(String(c.id)) && typeof c.label === "string" && c.label.length > 0 &&
            Array.isArray(c.menu) && c.menu.every((x) => typeof x === "string") && isObj(c.params) && typeof c.enabled === "boolean" && typeof c.destructive === "boolean" && !ids.has(c.id);
          ids.add(c.id);
          if (!ok) { flag("COMMANDS-CATALOG", `${where} : entrée hors norme ${JSON.stringify(c).slice(0, 200)}`); return null; }
        }
        const owned = list.filter((c) => /^(app|help|prefs|voiceover)\./.test(c.id) || ["file.open", "file.save", "file.saveAs", "file.saveCopy", "file.newProject"].includes(c.id)).map((c) => c.id);
        if (owned.length) flag("COMMANDS-CATALOG", `${where} : commandes de la coquille listées ${JSON.stringify(owned.slice(0, 8))}`);
        const by = Object.fromEntries(list.map((c) => [c.id, c]));
        if (by["file.newBin"]?.destructive !== false || by["file.newSequence"]?.destructive !== false) flag("COMMANDS-CATALOG", `${where} : file.newBin ${JSON.stringify(by["file.newBin"])}`);
        const shell = list.filter((c) => /^(app|help|prefs|voiceover)\./.test(c.id) || (c.id.startsWith("file.") && !ADMIS.includes(c.id)) || c.id === "project.ingestSettings").map((c) => c.id);
        if (shell.length) flag("COMMAND-WHITELIST", `${where} : hors liste blanche ${JSON.stringify(shell.slice(0, 8))}`);
        const missing = ["file.newBin", "file.newSequence", "file.import", "file.exportEdl", "file.exportMedia"].filter((id) => !by[id]);
        if (missing.length) flag("COMMAND-WHITELIST", `${where} : commandes admises absentes ${JSON.stringify(missing)}`);
        const free = list.filter((c) => (c.id === "file.newBin" ? !nameOnly(c.params) : !noParams(c.params))).map((c) => `${c.id} ${JSON.stringify(c.params)}`);
        if (free.length) flag("COMMAND-PARAMS", `${where} : schéma de paramètres hors règle ${JSON.stringify(free.slice(0, 4))}`);
        if (by["markers.clearAll"]?.destructive !== true || by["window.workspace.reset"]?.destructive !== true) {
          flag("COMMAND-DESTRUCTIVE", `${where} : ${JSON.stringify({ clearAll: by["markers.clearAll"]?.destructive, reset: by["window.workspace.reset"]?.destructive })}`);
        }
        return by;
      };
      const cat1 = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:commands"), 10000);
      const by1 = checkCatalog(cat1, "en");
      r.catalog = { commands: cat1?.payload?.commands?.length ?? null };

      // 2. S-ACK : le projet n'est enregistré qu'à l'accusé ; modifié pendant l'envoi, il le reste ;
      //    refusé (409), il le reste ; rouvert (même docRef), il est propre
      const RA = await ulid();
      const openA = await openDoc(RA, "temoin-ack.fcproj", String(fixture));
      if (openA?.payload?.ok !== true) flag("S-ACK", `ouverture : ${JSON.stringify(openA)}`);
      await exec("file.newSequence", { name: "ack-1" });
      if (!(await dirtyIs(RA, true, 10000))) flag("S-ACK", "aucune modification signalée (ack-1)");
      let save = await requestSave("user");
      const n0 = fromEngine(await getLog()).length;
      await sleep(1500);
      let pr = await inspect();
      const early = fromEngine(await getLog()).slice(n0).some((m) => m.type === "evora:dirty" && m.payload?.docRef === RA && m.payload?.dirty === false);
      r.ack1 = { save: save?.type ?? null, dirty: pr?.dirty, early };
      if (save?.type !== "evora:save" || pr?.dirty !== true || early) flag("S-ACK", `enregistré avant l'accusé : ${JSON.stringify(r.ack1)}`);
      if (save?.type === "evora:save") await send(await msg("evora:saved", { ok: true, version: 2 }, { re: save.id }));
      const cleanA = await dirtyIs(RA, false, 10000);
      pr = await inspect();
      if (!cleanA || pr?.dirty !== false) flag("S-ACK", `accusé positif sans effet : ${JSON.stringify({ cleanA, dirty: pr?.dirty })}`);
      await exec("file.newSequence", { name: "ack-2" });
      await dirtyIs(RA, true, 10000);
      save = await requestSave("autosave");
      await exec("file.newSequence", { name: "ack-3" });
      if (save?.type === "evora:save") await send(await msg("evora:saved", { ok: true, version: 3 }, { re: save.id }));
      await sleep(2000);
      pr = await inspect();
      r.ack2 = { save: save?.type ?? null, dirty: pr?.dirty, last: lastDirty(await getLog(), RA) };
      if (save?.type !== "evora:save" || pr?.dirty !== true || r.ack2.last !== true) flag("S-ACK", `modification pendant l'envoi perdue : ${JSON.stringify(r.ack2)}`);
      save = await requestSave("user");
      if (save?.type === "evora:save") await send(await msg("evora:saved", { ok: false, error: "conflict" }, { re: save.id }));
      await sleep(1500);
      pr = await inspect();
      r.ack409 = { save: save?.type ?? null, dirty: pr?.dirty };
      if (save?.type !== "evora:save" || pr?.dirty !== true) flag("S-ACK", `refus 409 : ${JSON.stringify(r.ack409)}`);
      const reopen = await openDoc(RA, "temoin-ack.fcproj", String(fixture));
      const cleanReopen = await dirtyIs(RA, false, 10000);
      pr = await inspect();
      r.reopen = { ack: reopen?.payload ?? null, dirty: pr?.dirty };
      if (reopen?.payload?.ok !== true || !cleanReopen || pr?.dirty !== false) flag("S-ACK", `rouvert après le 409 : ${JSON.stringify(r.reopen)}`);

      // 3. commandes (AVENANT-2026-10-27 §4) : admise ; refusées (hors catalogue, inconnue) ; règle 1,
      //    liste blanche (COMMAND-WHITELIST) : des `file.*` vivants du menu, hors créations, imports et
      //    exports par la coquille, refusés même confirmés ; règle 2, aucun paramètre libre
      //    (COMMAND-PARAMS) : chemin, URL, clé non déclarée, mauvais type refusés ; règle 3, destructive
      //    (COMMAND-DESTRUCTIVE) : refusée sans accord et sans effet, jouée avec, sans seconde boîte
      const BIN = "Bin-commande";
      const allowed = await command("file.newBin", { name: BIN });
      const t1 = await tree();
      r.commandAllowed = { ack: allowed?.payload ?? null, bins: t1.bins };
      if (allowed?.payload?.ok !== true || !t1.bins.includes(BIN)) flag("COMMAND-ALLOWED", JSON.stringify(r.commandAllowed));
      const refused = {};
      for (const [k, c, params] of [["lien", "help.github", {}], ["fichier", "file.open", { path: "/evora/x.fcproj" }], ["inconnue", "pas.une.commande", {}]]) {
        refused[k] = (await command(c, params))?.payload ?? null;
      }
      const t2 = await tree();
      r.commandRefused = { ...refused, kept: t2.bins.includes(BIN) };
      if (refused.lien?.ok !== false || refused.lien?.code !== "capability" || refused.fichier?.code !== "capability" || refused.inconnue?.code !== "capability" ||
        !r.commandRefused.kept) {
        flag("COMMAND-REFUSED", JSON.stringify(r.commandRefused));
      }
      const xs = await send(await msg("evora:command", { command: "file.newBin", params: {}, extra: 1 }));
      // règle 1 : chaque sonde est une entrée vivante du menu (prémisse), refusée par le pont
      const menuEn = await inChild("filmcraft.request('ui.menu.list')").catch(() => []);
      const liveIds = new Set((Array.isArray(menuEn) ? menuEn : []).map((m) => m.id));
      const SHELL_PROBES = ["file.saveAll", "file.saveAsTemplate", "file.closeProject", "file.closeAllProjects", "file.projectManager", "file.exportSelectionProject",
        "file.importFromMediaBrowser", "file.replaceFonts", "file.revert", "file.projectSettings.scratchDisks", "project.ingestSettings"];
      const notLive = SHELL_PROBES.filter((c) => !liveIds.has(c));
      if (notLive.length) flag("PREMISSE", `sondes de la liste blanche absentes du menu : ${JSON.stringify(notLive)}`);
      r.whitelist = {};
      for (const c of SHELL_PROBES) r.whitelist[c] = (await command(c, {}, { confirmed: true }))?.payload ?? null;
      const leaked = SHELL_PROBES.filter((c) => r.whitelist[c]?.ok !== false || r.whitelist[c]?.code !== "capability");
      if (leaked.length) flag("COMMAND-WHITELIST", `sondes non refusées : ${JSON.stringify(Object.fromEntries(leaked.map((c) => [c, r.whitelist[c]])))}`);
      // règle 2 : chemin, URL, clé non déclarée, mauvais type, commande sans schéma
      const PARAM_PROBES = [
        ["chemin", "file.newBin", { name: "/opfs/evora-lab/Bin-QA" }],
        ["antislash", "file.newBin", { name: "..\\Bin-QA" }],
        ["deux-points", "file.newBin", { name: "Bin:QA" }],
        ["opfs", "file.newBin", { name: "Bin opfs QA" }],
        ["evora", "file.newBin", { name: "Bin Evora QA" }],
        ["cle", "file.newBin", { name: "Bin-QA-cle", parent: 1 }],
        ["type", "file.newBin", { name: 5 }],
        ["vide", "file.newBin", { name: "" }],
        ["sans-schema", "markers.exportCsv", { path: "/opfs/evora-lab/marqueurs.csv" }],
        ["sans-schema-nom", "window.panel.Effects", { name: "Bin-QA-panneau" }],
      ];
      r.params = {};
      for (const [k, c, params] of PARAM_PROBES) r.params[k] = (await command(c, params))?.payload ?? null;
      const t3 = await tree();
      const passed = PARAM_PROBES.map(([k]) => k).filter((k) => r.params[k]?.ok !== false || r.params[k]?.code !== "invalid_content");
      const created = t3.bins.filter((b) => /Bin.?QA|opfs|evora|^5$/i.test(b));
      if (passed.length || created.length) flag("COMMAND-PARAMS", JSON.stringify({ passed: Object.fromEntries(passed.map((k) => [k, r.params[k]])), created }));
      // règle 3 : un marqueur posé (hors pont), effacé seulement par la commande confirmée
      const seqD = await exec("file.newSequence", { name: "S-marqueurs" });
      const mk = await exec("markers.add", { name: "M-QA" });
      const markers = async () => { const q = await exec("sequence.inspect"); return Array.isArray(q?.markers) ? q.markers.length : null; };
      const m0 = await markers();
      if (!(m0 >= 1)) flag("PREMISSE", `marqueur non posé : ${JSON.stringify({ seqD: typeof seqD === "string" ? seqD : "ok", mk, m0 })}`);
      const unconfirmed = await command("markers.clearAll", {});
      const m1 = await markers();
      const confirmed = await command("markers.clearAll", {}, { confirmed: true });
      await sleep(1000);
      const m2 = await markers();
      r.destructive = { unconfirmed: unconfirmed?.payload ?? null, confirmed: confirmed?.payload ?? null, markers: [m0, m1, m2] };
      if (unconfirmed?.payload?.ok !== false || unconfirmed?.payload?.code !== "forbidden" || m1 !== m0 || confirmed?.payload?.ok !== true || m2 !== 0) {
        flag("COMMAND-DESTRUCTIVE", JSON.stringify(r.destructive));
      }
      if (fromEngine(await getLog()).some((m) => m.re === xs)) flag("COMMAND-REFUSED", "réponse à un evora:command hors schéma");

      // 4. catalogue dans la langue servie (evora:lang es), puis retour à l'anglais
      const nCat = await count("evora:commands");
      const la = await send(await msg("evora:lang", { lang: "es", engineLang: "es" }));
      await waitFor(answer(la, "evora:ack"), 10000);
      const cat2 = await next("evora:commands", nCat, 10000);
      await sleep(500);
      const menuEs = await inChild("filmcraft.request('ui.menu.list')").catch(() => []);
      const esLabel = (Array.isArray(menuEs) ? menuEs : []).find((m) => m.id === "file.newSequence")?.label ?? null;
      const by2 = cat2 ? checkCatalog(cat2, "es") : null;
      r.catalogEs = { catalog: by2?.["file.newSequence"]?.label ?? null, menu: esLabel, en: by1?.["file.newSequence"]?.label ?? null };
      if (!cat2 || !esLabel || r.catalogEs.catalog !== esLabel || r.catalogEs.catalog === r.catalogEs.en) flag("COMMANDS-CATALOG", `après evora:lang es : ${JSON.stringify(r.catalogEs)}`);
      const lb = await send(await msg("evora:lang", { lang: "en", engineLang: "en" }));
      await waitFor(answer(lb, "evora:ack"), 10000);

      // 5. sortie clavier : F6 seule rend le focus (une fois), Ctrl+F6 non
      const nFo = await count("evora:focus-out");
      await inChild("(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true })); window.dispatchEvent(new KeyboardEvent('keyup', { key: 'F6', bubbles: true, cancelable: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()").catch(() => {});
      await sleep(1500);
      const fo = ofType(await getLog(), "evora:focus-out").slice(nFo);
      r.focusOut = fo.map((m) => ({ keys: m.payloadKeys, hasRe: m.hasRe }));
      if (fo.length !== 1 || JSON.stringify(fo[0].payloadKeys) !== "[]" || fo[0].hasRe) flag("FOCUS-OUT", JSON.stringify(r.focusOut));

      // 6. Enregistrer sous : un nouveau document de la coquille, adopté ; refusé, le document reste
      await exec("file.newSequence", { name: "as-1" });
      const nSave = await count("evora:save");
      r.saveAsInvoke = await invoke("file.saveAs");
      const sa = await next("evora:save", nSave, 10000);
      const RB = await ulid();
      if (sa) await send(await msg("evora:saved", { ok: true, version: 1, docRef: RB }, { re: sa.id }));
      await sleep(1500);
      pr = await inspect();
      const asName = sa?.payload?.name;
      r.saveAs = { msg: sa ? { docRef: sa.payload?.docRef, name: asName, saveAs: sa.payload?.saveAs, hasRe: sa.hasRe } : null, path: pr?.path ?? null };
      if (!sa || sa.payload?.saveAs !== true || sa.payload?.docRef !== RA || sa.hasRe || typeof asName !== "string" || !asName.endsWith(".fcproj") || pr?.path !== `/evora/${RB}/${asName}`) {
        flag("SAVE-AS-ADOPT", JSON.stringify(r.saveAs));
      }
      await exec("file.newSequence", { name: "as-2" });
      const afterAs = await requestSave("user", RB);
      r.saveAs.next = afterAs ? { type: afterAs.type, docRef: afterAs.payload?.docRef } : null;
      if (afterAs?.type !== "evora:save" || afterAs.payload?.docRef !== RB) flag("SAVE-AS-ADOPT", `enregistrement suivant : ${JSON.stringify(r.saveAs.next)}`);
      if (afterAs?.type === "evora:save") await send(await msg("evora:saved", { ok: true, version: 2 }, { re: afterAs.id }));
      await exec("file.newSequence", { name: "as-3" });
      const nSave2 = await count("evora:save");
      await invoke("file.saveAs");
      const sa2 = await next("evora:save", nSave2, 10000);
      if (sa2) await send(await msg("evora:saved", { ok: false, error: "conflict" }, { re: sa2.id }));
      await sleep(1500);
      pr = await inspect();
      r.saveAsRefused = { msg: sa2 ? { saveAs: sa2.payload?.saveAs, docRef: sa2.payload?.docRef } : null, path: pr?.path ?? null, dirty: pr?.dirty };
      if (sa2?.payload?.saveAs !== true || sa2.payload?.docRef !== RB || !String(pr?.path).startsWith(`/evora/${RB}/`) || pr?.dirty !== true) flag("SAVE-AS-ADOPT", `refusé : ${JSON.stringify(r.saveAsRefused)}`);

      // 7. S-MED : projet aux trois médias absents ; besoins par lots de 2 au plus ; URL signées
      ready = await start("host=evora&lang=en&theme=dark&v1-medias", V1_CAPS, { maxPathsPerNeed: 2 });
      if (!ready) return { bad, r };
      const RM = await ulid();
      mediaLog.length = 0;
      const openM = await openDoc(RM, "medias.fcproj", String(mediaFixture));
      await sleep(1500);
      const needs = ofType(await getLog(), "evora:need");
      const needPaths = needs.flatMap((m) => m.payload?.paths ?? []);
      r.needs = needs.map((m) => ({ keys: m.payloadKeys, docRef: m.payload?.docRef, paths: m.payload?.paths }));
      if (openM?.payload?.ok !== true || needs.length !== 2 || JSON.stringify([...needPaths].sort()) !== JSON.stringify(MEDIA_PATHS) ||
        needs.some((m) => sortedKeys(m) !== '["docRef","paths"]' || m.payload?.docRef !== RM || !(m.payload?.paths?.length >= 1 && m.payload.paths.length <= 2))) {
        flag("S-MED", `besoins : ${JSON.stringify(r.needs)}`);
      }
      const mediaUrl = (path, token) => `${parentOrigin}/__media/${path.split("/").pop()}?t=${token}`;
      const answerNeed = async (nd, tokenOf) => {
        for (const p of nd.payload?.paths ?? []) await send(await msg("evora:file", { path: p, url: mediaUrl(p, tokenOf(p)) }, { re: nd.id }));
        await send(await msg("evora:ack", { ok: true }, { re: nd.id }));
      };
      for (const nd of needs) await answerNeed(nd, (p) => (p.endsWith("clip-c.wav") ? "x403" : "ok"));
      let remotes = null;
      for (let i = 0; i < 60 && !remotes; i++) {
        const f = await inChild("filmcraft.files()").catch(() => []);
        const got = MEDIA_PATHS.map((p) => (Array.isArray(f) ? f : []).find((x) => x.path === p));
        if (got.every((x) => x && x.kind === "remote" && x.size === MEDIA_WAV.length)) remotes = got;
        else await sleep(500);
      }
      pr = await inspect();
      r.remotes = { ok: !!remotes, dirty: pr?.dirty };
      if (!remotes) flag("S-MED", `médias non enregistrés : ${JSON.stringify(await inChild("filmcraft.files()").catch((e) => String(e)))}`);
      if (pr?.dirty !== false) flag("S-MED", `projet modifié par l'arrivée des médias : ${JSON.stringify(pr?.dirty)}`);

      // 8. S-MED-RENEW : l'URL de clip-c expire en cours de lecture (les lectures y butent) ; un
      //    evora:need de ce seul chemin la renouvelle ; les blocs suivants se lisent avec la nouvelle
      //    URL ; puis l'export WAV du montage (les trois médias) s'achève vers Drive
      const nNeed = needs.length;
      const answered = new Set();
      let renewed = null;
      const serveRenewals = async () => {
        for (const nd of ofType(await getLog(), "evora:need").slice(nNeed)) {
          if (answered.has(nd.id)) continue;
          answered.add(nd.id);
          renewed = renewed ?? nd;
          await answerNeed(nd, () => "ok");
        }
      };
      const okReads = () => mediaLog.filter((e) => e.path.endsWith("/clip-c.wav") && e.token === "ok" && e.method === "GET" && e.status === 206).length;
      const sq = await exec("sequence.inspect");
      const clipIds = (Array.isArray(sq?.audio) ? sq.audio : []).flatMap((t) => (Array.isArray(t.items) ? t.items : []).map((i) => i.clip)).filter((c) => typeof c === "number");
      for (const until = Date.now() + 60000; Date.now() < until && !(renewed && okReads() >= 2); ) {
        // le pic audio des clips lit tout leur son : il relance les lectures de clip-c
        await exec("clip.audioPeak", { clips: clipIds });
        await serveRenewals();
        await sleep(1000);
      }
      const job = await exec("file.exportMedia", { format: "wav", path: "/exports/evora-mix.wav" });
      let exp = null;
      for (const until = Date.now() + 120000; Date.now() < until && !exp; ) {
        await serveRenewals();
        exp = ofType(await getLog(), "evora:export").find((m) => m.payload?.name === "evora-mix.wav") ?? null;
        if (!exp) await sleep(500);
      }
      if (exp) await send(await msg("evora:ack", { ok: true }, { re: exp.id }));
      r.renew = { job: typeof job === "string" ? job : "ok", clips: clipIds.length, renewals: answered.size, okReads: okReads(), paths: renewed?.payload?.paths ?? null, export: exp ? { name: exp.payload?.name, mime: exp.payload?.mime, bytes: exp.payload?.bytes?.arrayBuffer ?? null, docRef: exp.payload?.docRef } : null };
      if (!renewed || JSON.stringify(renewed.payload?.paths) !== JSON.stringify(["/files/clip-c.wav"]) || r.renew.okReads < 1 || !exp || exp.payload?.mime !== "audio/wav" ||
        !(exp.payload?.bytes?.arrayBuffer > 44) || exp.payload?.docRef !== RM) {
        flag("S-MED-RENEW", JSON.stringify(r.renew));
      }
      const ml = mediaLog.filter((e) => /\/clip-[abc]\.wav$/.test(e.path));
      r.mediaLog = { requests: ml.length, options: ml.filter((e) => e.method === "OPTIONS").length, badRange: ml.filter((e) => e.method === "GET" && !/^bytes=\d+-\d+$/.test(e.range ?? "")).map((e) => e.range),
        foreign: ml.filter((e) => e.origin !== engineOrigin).length, cookies: ml.filter((e) => e.cookie).length,
        reads: ml.filter((e) => e.method === "GET" && e.status === 206 && e.range !== "bytes=0-0").length, expired: ml.filter((e) => e.status === 403).length };
      if (!ml.length || r.mediaLog.badRange.length || r.mediaLog.foreign || r.mediaLog.cookies || r.mediaLog.reads < 3 || r.mediaLog.expired < 1) flag("S-MED", `lectures par plages : ${JSON.stringify(r.mediaLog)}`);

      // 9. S-EXP : un document d'échange (EDL) part vers Drive, jamais en téléchargement
      const nExp = await count("evora:export");
      const edl = await exec("file.exportEdl", { path: "/exports/temoin-exp.edl" });
      const em = await next("evora:export", nExp, 10000);
      if (em) await send(await msg("evora:ack", { ok: true }, { re: em.id }));
      await sleep(1000);
      r.edl = { result: typeof edl === "string" ? edl : "ok", msg: em ? { keys: sortedKeys(em), name: em.payload?.name, mime: em.payload?.mime, bytes: em.payload?.bytes?.arrayBuffer ?? null } : null, spy: await readSpy() };
      if (!em || r.edl.msg.keys !== '["bytes","docRef","mime","name"]' || r.edl.msg.name !== "temoin-exp.edl" || r.edl.msg.mime !== "text/plain" || !(r.edl.msg.bytes > 0)) flag("S-EXP", JSON.stringify(r.edl));

      // 9 b. ACTIVITY-EXPORT : un export de barres et tonalité (aucun média de Drive), après l'EDL de la
      //      séquence des médias : evora:activity {busy: true} avant l'evora:export, {busy: false} ensuite
      const bars = await exec("file.newBarsAndTone", { seconds: 2 });
      const barsItem = bars && typeof bars === "object" ? bars.item ?? bars.id ?? null : null;
      const barsSeq = await exec("file.newSequence", { fromItem: barsItem, name: "S-barres" });
      const nLog = fromEngine(await getLog()).length;
      const barsJob = await exec("file.exportMedia", { format: "wav", path: "/exports/evora-barres.wav" });
      const barsExp = await waitFor((log) => fromEngine(log).slice(nLog).find((m) => m.type === "evora:export" && m.payload?.name === "evora-barres.wav"), 60000);
      if (barsExp) await send(await msg("evora:ack", { ok: true }, { re: barsExp.id }));
      await sleep(2000);
      const logB = fromEngine(await getLog()).slice(nLog);
      const acts = logB.map((m, i) => ({ m, i })).filter((x) => x.m.type === "evora:activity").map((x) => ({ i: x.i, busy: x.m.payload?.busy, kind: x.m.payload?.kind, keys: sortedKeys(x.m) }));
      const iExp = barsExp ? logB.findIndex((m) => m.id === barsExp.id) : -1;
      r.activity = { bars: barsItem, seq: typeof barsSeq === "string" ? barsSeq : "ok", job: typeof barsJob === "string" ? barsJob : "ok", acts, iExp,
        export: barsExp ? { keys: sortedKeys(barsExp), mime: barsExp.payload?.mime, bytes: barsExp.payload?.bytes?.arrayBuffer ?? null } : null };
      if (typeof barsItem !== "number" || typeof barsSeq === "string") flag("PREMISSE", `barres et tonalité : ${JSON.stringify(r.activity)}`);
      const alternates = acts.length >= 2 && acts.every((x, k) => x.busy === (k % 2 === 0) && x.kind === "export" && x.keys === '["busy","kind"]');
      if (!barsExp || !alternates || !(acts[0]?.i < iExp) || acts.at(-1)?.busy !== false) flag("ACTIVITY-EXPORT", JSON.stringify(r.activity));
      if (!barsExp || r.activity.export.keys !== '["bytes","docRef","mime","name"]' || barsExp.payload?.mime !== "audio/wav" || !(barsExp.payload?.bytes?.arrayBuffer > 44)) flag("S-EXP", `export de barres : ${JSON.stringify(r.activity.export)}`);
      // 10. S-PICK : File ▸ Import ouvre le sélecteur de la coquille (jamais celui du navigateur) ; le
      //     fichier choisi arrive par URL signée, lu par plages à latence injectée, puis importé
      const pickImport = async (file, tag) => {
        const nPick = await count("evora:pick");
        const inv = await invoke("file.import");
        const pk = await next("evora:pick", nPick, 10000);
        const local = await inChild("window.__spy ? window.__spy.picker : null").catch(() => null);
        const out = { invoke: inv, pick: pk ? { keys: sortedKeys(pk), purpose: pk.payload?.purpose, multiple: pk.payload?.multiple, accept: pk.payload?.accept?.length ?? null } : null, local };
        if (!pk) { flag(tag, `aucun evora:pick : ${JSON.stringify(out)}`); return out; }
        const acceptOk = Array.isArray(pk.payload?.accept) && pk.payload.accept.length >= 1 && pk.payload.accept.length <= 32 && pk.payload.accept.every((a) => /^(\.[a-z0-9]+|[a-z0-9.+-]+\/[a-z0-9.+*-]+)$/.test(a));
        if (out.pick.keys !== '["accept","multiple","purpose"]' || out.pick.purpose !== "import" || out.pick.multiple !== true || !acceptOk || local !== 0) flag(tag, `evora:pick : ${JSON.stringify(out)}`);
        mediaLog.length = 0;
        await send(await msg("evora:file", { path: `/evora/${await ulid()}/${file}`, name: file, url: `${parentOrigin}/__media/${file}?t=ok` }, { re: pk.id }));
        await send(await msg("evora:ack", { ok: true }, { re: pk.id }));
        const stem = file.replace(/\.wav$/, "");
        let got = false;
        for (let i = 0; i < 60 && !got; i++) {
          const t = await tree();
          got = t.items.includes(stem) || t.items.includes(file);
          if (!got) await sleep(500);
        }
        const fl = mediaLog.filter((e) => e.path.endsWith("/" + file));
        out.imported = got;
        out.requests = fl.map((e) => `${e.method} ${e.range ?? "-"} ${e.status}`);
        if (!got || fl.some((e) => e.method === "GET" && !/^bytes=\d+-\d+$/.test(e.range ?? "")) || fl.some((e) => e.cookie || e.origin !== engineOrigin)) flag(tag, `import par le sélecteur : ${JSON.stringify(out)}`);
        return out;
      };
      r.pick = await pickImport("pick-a.wav", "S-PICK");
      r.pickSuffix = await pickImport("temoin-suffixe.wav", "S-PICK-SUFFIXE");
      r.pickInclude = await pickImport("temoin-include.wav", "S-PICK-INCLUDE");
      const nPick2 = await count("evora:pick");
      const capInv = await invoke("captions.import");
      const pk2 = await next("evora:pick", nPick2, 8000);
      const localCap = await inChild("window.__spy ? window.__spy.picker : null").catch(() => null);
      if (pk2) await send(await msg("evora:ack", { ok: false, code: "cancelled" }, { re: pk2.id }));
      r.pickLocal = { invoke: capInv, pick: pk2 ? { purpose: pk2.payload?.purpose, accept: pk2.payload?.accept } : null, local: localCap };
      if (!pk2 || pk2.payload?.purpose !== "import" || !pk2.payload?.accept?.includes(".srt") || localCap !== 0) flag("S-PICK-LOCAL", JSON.stringify(r.pickLocal));

      // 11. S-DROP : un fichier déposé sur le canevas va à la coquille (evora:drop), puis est importé
      const nDrop = await count("evora:drop");
      const dispatched = await inChild(`(async () => { const b = await (await fetch("/__media/drop-a.wav")).blob(); const dt = new DataTransfer(); dt.items.add(new File([b], "drop-a.wav", { type: "audio/wav" })); const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; })()`).catch((e) => String(e));
      const dm = await next("evora:drop", nDrop, 8000);
      r.drop = { dispatched, msg: dm ? { keys: sortedKeys(dm), purpose: dm.payload?.purpose, files: dm.payload?.files } : null };
      if (!dm || r.drop.msg.keys !== '["files","purpose"]' || dm.payload?.purpose !== "import" || dm.payload?.files?.length !== 1 || dm.payload.files[0]?.file !== "drop-a.wav") {
        flag("S-DROP", JSON.stringify(r.drop));
      } else {
        await send(await msg("evora:file", { path: `/evora/${await ulid()}/drop-a.wav`, name: "drop-a.wav", url: `${parentOrigin}/__media/drop-a.wav?t=ok` }, { re: dm.id }));
        await send(await msg("evora:ack", { ok: true }, { re: dm.id }));
        let got = false;
        for (let i = 0; i < 60 && !got; i++) {
          const t = await tree();
          got = t.items.includes("drop-a") || t.items.includes("drop-a.wav");
          if (!got) await sleep(500);
        }
        r.drop.imported = got;
        if (!got) flag("S-DROP", `fichier déposé non importé : ${JSON.stringify(r.drop)}`);
      }

      // 12. repli WebGL : WebGPU démarre mais son périphérique échoue (espion) ; la page se recharge en
      //     ?webgl et garde host=evora : le pont démarre sur WebGL2 (un seul evora:ready, aucun échec)
      await readSpy();
      await inParent("window.__ehp.clear()");
      await inChild("window.__smokeAncien = true").catch(() => {});
      await evaluate(cdp, ps, `document.getElementById('engine').src = ${JSON.stringify(engineOrigin + "/index.html?host=evora&lang=en&theme=dark&wgfail")}; true`);
      let wg = null;
      for (const until = Date.now() + 90000; Date.now() < until; ) {
        try {
          wg = await inChild("(() => { const l = window.filmcraftLoad || {}; return { readyMs: l.readyMs ?? null, error: l.error ?? null, search: location.search, old: !!window.__smokeAncien }; })()");
          if (!wg.old && wg.search.includes("webgl") && wg.readyMs) break;
        } catch {
          // document en cours de remplacement
        }
        await sleep(250);
      }
      if (wg?.readyMs) markReady();
      const readyWg = await waitFor((log) => fromEngine(log).find((m) => m.type === "evora:ready"), 20000);
      await sleep(1000);
      const infoWg = await inChild("filmcraft.info()").catch(() => null);
      const q = new URLSearchParams(String(wg?.search ?? ""));
      r.webgl = { load: wg, readies: await count("evora:ready"), failed: await count("evora:failed"), backend: infoWg?.backend ?? null };
      if (!wg?.readyMs || q.get("host") !== "evora" || !q.has("webgl") || !q.has("wgfail") || !readyWg || r.webgl.readies !== 1 || r.webgl.failed !== 0 || !/gl/i.test(String(r.webgl.backend))) {
        flag("WEBGL-KEEPS-HOST", JSON.stringify(r.webgl));
      }

      // 13. WRITE-NEW : la création exclusive (write_file_new, audio incorporé d'un AAF) passe par le
      //     crochet d'écriture : vers Drive avec export.drive, refusée sans, jamais un succès muet
      const writeNew = (p) => inChild(`(async () => { const b = new Uint8Array(await (await fetch("/__media/clip-a.wav")).arrayBuffer()); return filmcraft.writeFileNew(${JSON.stringify(p)}, b).then(() => true, (e) => "erreur : " + e.message); })()`).catch((e) => String(e));
      r.writeNew = {};
      ready = await start("host=evora&lang=en&theme=dark&v1-ecriture");
      if (ready) {
        await openDoc(await ulid(), "ecriture.fcproj", String(fixture));
        const nE = await count("evora:export");
        const w1 = await writeNew("/files/audio-incorpore.wav");
        const w2 = await writeNew("/files/audio-incorpore.wav");
        await sleep(1000);
        const ex1 = ofType(await getLog(), "evora:export").slice(nE);
        for (const e of ex1) await send(await msg("evora:ack", { ok: true }, { re: e.id }));
        r.writeNew.exported = { first: w1, again: w2, names: ex1.map((e) => e.payload?.name) };
        if (w1 !== true || !/exist/i.test(String(w2)) || ex1.length !== 1 || ex1[0].payload?.name !== "audio-incorpore.wav") flag("WRITE-NEW", JSON.stringify(r.writeNew.exported));
      }
      ready = await start("host=evora&lang=en&theme=dark&v1-sans-export", V1_CAPS.filter((c) => c !== "export.drive"));
      if (ready) {
        await openDoc(await ulid(), "ecriture.fcproj", String(fixture));
        const w3 = await writeNew("/files/audio-refuse.wav");
        await sleep(1000);
        const listed = (await inChild("filmcraft.files()").catch(() => [])).some?.((f) => f.path === "/files/audio-refuse.wav") ?? null;
        r.writeNew.refused = { result: w3, exports: await count("evora:export"), listed };
        if (w3 === true || !/inside Evora/.test(String(w3)) || r.writeNew.refused.exports !== 0 || listed !== false) flag("WRITE-NEW", `sans export.drive : ${JSON.stringify(r.writeNew.refused)}`);
      }

      // 14. aucun téléchargement de toute la séquence (ancres comptées par l'espion, et le navigateur)
      await readSpy();
      r.downloads = { anchors: spyCounts.download, browser: downloadEvents.length, localPickers: spyCounts.picker };
      if (spyCounts.download !== 0 || downloadEvents.length !== 0) flag("TELECHARGEMENT", JSON.stringify(r.downloads));
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: spy.identifier }, childSession).catch(() => {});
      return { bad, r, catalog: cat1, version: r.version };
    }

    const v1 = await pontV1();
    report.ehp.v1 = v1.r;
    report.ehp.v1Failures = v1.bad;
    report.ehp.v1Tags = [...new Set(v1.bad.map((b) => b.tag))].sort();
    for (const b of v1.bad) fail(`E4 [V1-${b.tag}] ${b.text}`);
    // catalogue des commandes pour l'artefact (anglais, trié par identifiant) et son empreinte, calculée
    // sur ce qui ne dépend pas de la langue : identifiant, drapeau destructif, paramètres
    if (commandsOut) {
      const list = Array.isArray(v1.catalog?.payload?.commands) ? [...v1.catalog.payload.commands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : null;
      if (!list) fail("E4 [V1-COMMANDS-CATALOG] aucun catalogue à écrire pour l'artefact");
      else {
        const canonical = JSON.stringify(list.map((c) => ({ id: c.id, destructive: c.destructive, params: c.params })));
        const fingerprint = "sha256:" + createHash("sha256").update(canonical).digest("hex");
        writeFileSync(commandsOut, JSON.stringify({ app: "corte", version: v1.version ?? null, ehp: "1.0", lang: "en", fingerprint, commands: list }, null, 1) + "\n");
        report.ehp.commandsFile = { path: commandsOut, commands: list.length, fingerprint };
      }
    }
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
    (e, i) =>
      (e.kind === "exception" || e.kind === "console.error" || e.kind === "log.error") &&
      !(e.role === "iframe" && crashAt.has(e.gen) && i >= crashAt.get(e.gen)) &&
      // COR-FK-B1 : les 403 voulus du renouvellement d'URL (jeton x403 du scénario pont-v1), et les
      // refus réseau des seuls fichiers « temoin-* » (le témoin groupé de la livraison les provoque ;
      // leur détecteur S-PICK-* juge l'effet)
      !(e.source === "network" && /\/__media\/[^ ]*[?&]t=x403/.test(String(e.text))) &&
      !(/\/__media\/temoin-/.test(String(e.text)) && (e.source === "network" || /CORS|Range|416/i.test(String(e.text)))) &&
      (e.role === "parent" ? true : e.role === "iframe" ? okGens.has(e.gen) : e.role !== "browser"),
  );
  report.expectedCrashes = [...crashAt.entries()].map(([gen, from]) => ({ gen, from, events: events.filter((e, i) => e.role === "iframe" && e.gen === gen && i >= from).length }));
  report.blockingEvents = blocking;
  for (const e of blocking) fail(`${e.role} ${e.kind}${e.source ? " [" + e.source + "]" : ""} : ${String(e.text).slice(0, 400)}`);
  // chaque famille demandée a bien tourné jusqu'à son rapport
  for (const [flagName, key] of [["lang-checks", "lang"], ["storage-checks", "storageE5"], ["theme-checks", "theme"], ["ehp-checks", "ehp"]]) {
    if (process.argv.includes(`--${flagName}`) && report[key] === undefined) fail(`famille --${flagName} demandée mais sans rapport : elle n'a pas tourné`);
  }
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
    `Pont V1 (COR-FK-B1, scénario pont-v1) : étiquettes rouges ${JSON.stringify(report.ehp?.v1Tags ?? null)} ; catalogue ${JSON.stringify(report.ehp?.commandsFile ?? null)}`,
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
    `- Pont V1 (COR-FK-B1, scénario pont-v1) : étiquettes rouges ${JSON.stringify(report.ehp?.v1Tags ?? null)} ; catalogue ${JSON.stringify(report.ehp?.commandsFile ?? null)}`,
    `- Stockage navigateur hors OPFS (mesure E5) : ${JSON.stringify(report.storage ?? null)}`,
    `- Événements bloquants : ${report.blockingEvents?.length ?? "?"} ; verdict : **${report.failures.length ? "ROUGE" : "VERT"}**`,
    ...report.failures.map((f) => `  - ${f.replace(/\n/g, " ").slice(0, 300)}`),
  ].join("\n");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n\n", { flag: "a" });
}
process.exit(exitCode);
