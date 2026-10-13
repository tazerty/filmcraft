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
const engine = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = resolve(site, "." + rel);
  const ok = file.startsWith(site + sep) && existsSync(file) && statSync(file).isFile();
  report.requests.push({ origin: "A", path: url.pathname, status: ok ? 200 : 404 });
  if (!ok) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const headers = { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (extname(file) === ".html") {
    headers["Content-Security-Policy"] = [
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
  res.writeHead(200, headers);
  res.end(readFileSync(file));
});

let engineOrigin = "";
const parent = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  report.requests.push({ origin: "B", path: url.pathname, status: url.pathname === "/" ? 200 : 404 });
  if (url.pathname !== "/") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; frame-src ${engineOrigin}; style-src 'unsafe-inline'; img-src data:`,
  });
  res.end(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Page parente (test Evora)</title></head>
<body style="margin:0;background:#fff"><iframe id="engine" src="${engineOrigin}/index.html?empty" title="moteur"
 sandbox="allow-scripts allow-same-origin" allow="fullscreen; clipboard-read; clipboard-write"
 style="border:0;display:block;width:1280px;height:800px"></iframe></body></html>`);
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
engineOrigin = `http://127.0.0.1:${enginePort}`;
parentOrigin = `http://localhost:${parentPort}`;
report.origins = { engine: engineOrigin, parent: parentOrigin };

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
        if (isFrame) childSession = p.sessionId;
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
  if (langCmds.length === 0) fail("aucune commande de langue trouvée dans les menus : l'analyse au rendu ne mesure rien");
  if (rendered.emoji.length && emojiMode === "block") fail(`émojis affichés dans les menus : ${rendered.emoji.length}`);
  if (rendered.terms.length && termsMode === "block") fail(`termes sensibles affichés dans les menus : ${rendered.terms.length}`);

  // erreurs : toutes celles de la parente, et celles du dernier document du moteur
  const childGen = mode === "oopif" ? sessions.get(childSession).gen : sessions.get(ps).gen;
  report.events = events;
  const blocking = events.filter(
    (e) =>
      (e.kind === "exception" || e.kind === "console.error" || e.kind === "log.error") &&
      (e.role === "parent" ? true : e.role === "iframe" ? e.gen === childGen : e.role !== "browser"),
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
    `- Événements bloquants : ${report.blockingEvents?.length ?? "?"} ; verdict : **${report.failures.length ? "ROUGE" : "VERT"}**`,
    ...report.failures.map((f) => `  - ${f.replace(/\n/g, " ").slice(0, 300)}`),
  ].join("\n");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n\n", { flag: "a" });
}
process.exit(exitCode);
