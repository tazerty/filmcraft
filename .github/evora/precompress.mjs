// Précompression du site web Evora : <fichier>.br (brotli, qualité 11) et <fichier>.gz (gzip -9)
// pour les ressources servies du moteur. Node seul (zlib intégré), sans dépendance.
// Sortie déterministe (gzip sans nom ni date) ; chaque fichier est relu et décompressé pour vérifier
// qu'il redonne exactement la source.
//
//   node .github/evora/precompress.mjs <dossier du site>
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import zlib from "node:zlib";

const site = process.argv[2];
if (!site) {
  console.error("usage: precompress.mjs <site>");
  process.exit(2);
}
const EXT = new Set([".html", ".js", ".mjs", ".wasm", ".css", ".json", ".svg"]);
const files = readdirSync(site).filter((n) => statSync(join(site, n)).isFile() && EXT.has(extname(n)));
if (files.length === 0) {
  console.error("::error::rien à précompresser dans " + site);
  process.exit(1);
}
console.log(`node ${process.version}, zlib ${process.versions.zlib}, brotli ${process.versions.brotli ?? "?"}`);
let failed = 0;
for (const n of files.sort()) {
  const p = join(site, n);
  const src = readFileSync(p);
  const br = zlib.brotliCompressSync(src, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_MODE]: n.endsWith(".wasm") ? zlib.constants.BROTLI_MODE_GENERIC : zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: src.length,
    },
  });
  const gz = zlib.gzipSync(src, { level: 9 });
  const okBr = Buffer.compare(zlib.brotliDecompressSync(br), src) === 0;
  const okGz = Buffer.compare(zlib.gunzipSync(gz), src) === 0;
  if (!okBr || !okGz) {
    console.error(`::error::${n} : la décompression ne redonne pas la source (br ${okBr}, gz ${okGz})`);
    failed++;
    continue;
  }
  writeFileSync(p + ".br", br);
  writeFileSync(p + ".gz", gz);
  console.log(`${n}\t${src.length}\tbr ${br.length}\tgz ${gz.length}`);
}
process.exit(failed ? 1 : 0);
