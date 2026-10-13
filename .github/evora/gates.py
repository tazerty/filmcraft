#!/usr/bin/env python3
"""Portes de la CI web Evora (fork tazerty/filmcraft, futur moteur d'Evora Corte).

Bibliothèque standard seulement ; lancé par .github/workflows/evora-web.yml avec `python3 -I`.
Chaque sous-commande imprime une mesure lisible, ajoute un résumé Markdown à $GITHUB_STEP_SUMMARY
quand il existe, et rend 1 si la porte est bloquante et franchie.

  marks SITE                  marques ArtCraft dans le bundle (hors LICENSES/) : 0 attendu
  hosting ZIP                 fichiers d'hébergement, fichiers cachés, liens symboliques dans l'archive
  catalogs ROOT [options]     émojis/symboles (E10) et termes sensibles (E9) des chaînes affichées
  csp INDEX OUT               empreintes sha256 des scripts inline d'index.html (CSP)
  sizes SITE ZIP              tailles brutes, .br et .gz
  hostcfg ZIP                 evora-host.json livré vide (pont EHP muet), sans copie précompressée
"""

import base64
import hashlib
import os
import re
import stat
import sys
import unicodedata
import zipfile

SUMMARY = os.environ.get("GITHUB_STEP_SUMMARY")


def summary(text):
    if SUMMARY:
        with open(SUMMARY, "a", encoding="utf-8") as f:
            f.write(text.rstrip("\n") + "\n\n")


def files_under(root, skip_dirs=()):
    for base, dirs, names in os.walk(root):
        rel = os.path.relpath(base, root)
        dirs[:] = sorted(d for d in dirs if os.path.normpath(os.path.join(rel, d)) not in skip_dirs)
        for n in sorted(names):
            yield os.path.join(base, n)


# --- marques -------------------------------------------------------------------------------------

# (libellé, motif en octets, insensible à la casse)
MARKS = [
    ("artcraft", b"artcraft", True),
    ("getartcraft", b"getartcraft", True),
    ("discord.gg", b"discord.gg", True),
]
INFO = [
    ("discord", b"discord", True),
    ("FilmCraft", b"FilmCraft", False),
    ("huggingface.co", b"huggingface.co", True),
    ("github.com", b"github.com", True),
    ("localStorage", b"localStorage", False),
    ("indexedDB", b"indexedDB", True),
]


def count(data, pat, icase):
    hay = data.lower() if icase else data
    return hay.count(pat.lower() if icase else pat)


def cmd_marks(site):
    rows, total = [], 0
    for p in files_under(site, skip_dirs={"LICENSES"}):
        rel = os.path.relpath(p, site)
        if rel.endswith((".br", ".gz")):
            continue  # copies compressées : on mesure la source
        data = open(p, "rb").read()
        c = [count(data, pat, ic) for _, pat, ic in MARKS]
        i = [count(data, pat, ic) for _, pat, ic in INFO]
        total += sum(c)
        rows.append((rel, c, i))
    head = "| Fichier | " + " | ".join(m[0] for m in MARKS) + " | " + " | ".join(f"{m[0]} (info)" for m in INFO) + " |"
    lines = [head, "|" + "---|" * (1 + len(MARKS) + len(INFO))]
    for rel, c, i in rows:
        lines.append(f"| `{rel}` | " + " | ".join(map(str, c)) + " | " + " | ".join(map(str, i)) + " |")
    verdict = "VERT" if total == 0 else "ROUGE"
    text = "### Porte « marques » (bloquante)\n\nMotifs bloquants, casse ignorée : `artcraft`, `getartcraft`, `discord.gg` ; `LICENSES/` exclu (mentions de licence permises).\n\n" + "\n".join(lines) + f"\n\nTotal bloquant : **{total}** ({verdict})"
    print(text)
    summary(text)
    if not rows:
        print("::error::bundle vide : la porte ne mesure rien")
        return 1
    if total:
        print(f"::error::marques ArtCraft dans le bundle : {total}")
        return 1
    return 0


# --- hébergement ----------------------------------------------------------------------------------

HOSTING = re.compile(r"(^|/)(_headers|_redirects|\.htaccess|\.user\.ini|web\.config|[^/]*\.conf|[^/]*\.php[0-9]?|[^/]*\.phtml)$", re.I)


def cmd_hosting(zpath):
    bad = []
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        for info in z.infolist():
            n = info.filename
            parts = [p for p in n.split("/") if p]
            mode = (info.external_attr >> 16) & 0xFFFF
            if HOSTING.search(n):
                bad.append((n, "fichier d'hébergement"))
            elif any(p.startswith(".") for p in parts):
                bad.append((n, "fichier ou dossier caché"))
            elif ".." in parts or n.startswith("/"):
                bad.append((n, "chemin hors racine"))
            elif stat.S_ISLNK(mode):
                bad.append((n, "lien symbolique"))
    text = "### Porte « hébergement » (bloquante)\n\n" + f"{len(names)} entrées dans `{os.path.basename(zpath)}`. "
    text += ("Interdits : aucun (VERT)." if not bad else "Interdits (ROUGE) :\n\n" + "\n".join(f"- `{n}` : {why}" for n, why in bad))
    print(text)
    summary(text)
    if not names:
        print("::error::archive vide : la porte ne mesure rien")
        return 1
    if bad:
        print("::error::fichiers interdits dans l'archive : " + ", ".join(n for n, _ in bad))
        return 1
    return 0


# --- catalogues : émojis (E10) et termes sensibles (E9) -------------------------------------------

def is_emoji(c):
    """Pictogrammes et émojis : blocs symboles divers et dingbats (✓ ✔ ✖ ⚠ ⚡ ⚙ ★ ♪…), pictogrammes
    U+1F000–1FAFF, flèches et symboles divers U+2B00–2BFF (⭐…), sélecteur de présentation émoji,
    touche, et les triangles à présentation émoji possible ▶ ◀."""
    o = ord(c)
    return (
        0x2600 <= o <= 0x27BF
        or 0x1F000 <= o <= 0x1FAFF
        or 0x2B00 <= o <= 0x2BFF
        or o in (0xFE0F, 0x20E3, 0x3030, 0x303D, 0x3297, 0x3299, 0x25B6, 0x25C0, 0x231A, 0x231B)
        or 0x23E9 <= o <= 0x23F3
        or 0x23F8 <= o <= 0x23FA
    )


TERMS = ["Lumetri", "Lightroom", "Acrobat", "Premiere", "Adobe", "Cycore"]
# Un terme est un mot : ni précédé ni suivi d'une lettre (« Volumetric » ne contient pas « Lumetri »).
TERM_RE = {t: re.compile(r"(?<![^\W\d_])" + t + r"(?![^\W\d_])", re.I) for t in TERMS}
LABEL_RE = re.compile(r"^[A-Z][A-Za-z0-9 &'-]*$")
IDENT_RE = re.compile(r"[a-z][A-Za-z0-9_.:/-]*")


def terms_in(text):
    return [t for t in TERMS if TERM_RE[t].search(text)]


def engine_literals(root):
    """Littéraux des crates moteur (engine, project, render ; hors tests et commentaires) qui
    contiennent un terme sensible. Un libellé (titre court, sans ponctuation) est affiché par
    l'interface via i18n::t (commandes, historique, préréglages) ; le reste (messages d'erreur,
    schémas de paramètres, espaces de noms XMP) n'est pas surchargeable sans exception L0–L5."""
    for crate in ("engine", "project", "render"):
        src = os.path.join(root, "crates", crate, "src")
        for p in files_under(src):
            if not p.endswith(".rs") or p.endswith("_tests.rs") or os.path.basename(p) == "tests.rs":
                continue
            text = open(p, encoding="utf-8").read().replace("\r\n", "\n")
            cut = text.find("#[cfg(test)]\nmod tests")
            text = text if cut < 0 else text[:cut]
            for n, ln in enumerate(text.split("\n"), 1):
                if ln.strip().startswith("//"):
                    continue
                for m in LIT.finditer(ln):
                    lit = unescape(m.group(1))
                    if IDENT_RE.fullmatch(lit):
                        continue  # identifiant (effet, commande, clé) : jamais affiché
                    if terms_in(lit):
                        label = bool(LABEL_RE.match(lit)) and len(lit.split()) <= 8
                        yield os.path.relpath(p, root), n, lit, label
LIT = re.compile(r'"((?:[^"\\\n]|\\.)*)"')
DISPLAY_CALL = re.compile(r'\b(?:tl|tlf)!\(\s*"((?:[^"\\\n]|\\.)*)"|\buic!\(\s*"[^"]*",\s*"((?:[^"\\\n]|\\.)*)"')


def unescape(s):
    return re.sub(r"\\u\{([0-9a-fA-F]+)\}", lambda m: chr(int(m.group(1), 16)), s).replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\")


def rust_sources(root):
    src = os.path.join(root, "crates", "ui-egui", "src")
    for p in files_under(src):
        if p.endswith(".rs"):
            text = open(p, encoding="utf-8").read().replace("\r\n", "\n")
            cut = text.find("#[cfg(test)]\nmod tests")
            yield p, (text if cut < 0 else text[:cut])


def parse_tsv(path):
    """Lignes (contexte, source, texte) d'un catalogue au format des TSV d'ui-egui (commentaires #,
    lignes vides ignorées, échappements \\n \\t \\\\)."""
    rows = []
    for n, ln in enumerate(open(path, encoding="utf-8"), 1):
        if ln.startswith("#") or not ln.strip():
            continue
        cols = ln.rstrip("\n").rstrip("\r").split("\t")
        if len(cols) != 3:
            continue
        # comme catalog.rs : \\n, \\t et \\\\ seulement ; tout autre échappement garde sa barre
        dec = [re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t", "\\": "\\"}.get(m.group(1), "\\" + m.group(1)), c) for c in cols]
        rows.append((n, dec[0], dec[1], dec[2]))
    return rows


def display_keys(root):
    """Littéraux anglais affichés : tl!, tlf! et libellés uic! (hors modules de test)."""
    keys = {}
    for p, text in rust_sources(root):
        rel = os.path.relpath(p, root)
        for m in DISPLAY_CALL.finditer(text):
            lit = m.group(1) if m.group(1) is not None else m.group(2)
            keys.setdefault(unescape(lit), f"{rel}:{text.count(chr(10), 0, m.start()) + 1}")
    return keys


def displayed(root):
    """Chaînes réellement affichées, langue par langue, selon la résolution de Language::tr :
    surcharge de la langue, sinon catalogue de la langue, sinon surcharge anglaise, sinon source.
    Rend [(langue, clé, texte affiché, origine)] et le nombre de chaînes brutes lues."""
    i18n = os.path.join(root, "crates", "ui-egui", "src", "i18n")
    catalogs, contextual = {}, []
    for name in sorted(os.listdir(i18n)):
        if name.endswith(".tsv") and name != "overrides.tsv":
            lang = name[:-4]
            catalogs[lang] = {}
            for n, ctx, src, tr in parse_tsv(os.path.join(i18n, name)):
                if ctx:
                    contextual.append((lang, f"{ctx}|{src}", tr, f"i18n/{name}:{n}"))
                else:
                    catalogs[lang][src] = (tr, f"i18n/{name}:{n}")
    overrides = {}
    ov_path = os.path.join(i18n, "overrides.tsv")
    if os.path.exists(ov_path):
        for n, lang, src, disp in parse_tsv(ov_path):
            overrides.setdefault(lang, {})[src] = (disp, f"i18n/overrides.tsv:{n}")
    code = display_keys(root)
    keys = set(code) | {k for c in catalogs.values() for k in c} | {k for o in overrides.values() for k in o}
    out = []
    for lang in ["en"] + sorted(catalogs):
        for k in sorted(keys):
            hit = overrides.get(lang, {}).get(k)
            if hit is None and lang != "en":
                hit = catalogs[lang].get(k)
            if hit is None:
                hit = overrides.get("en", {}).get(k)
            if hit is None:
                hit = (k, code.get(k, "source"))
            out.append((lang, k, hit[0], hit[1]))
    out.extend(contextual)
    raw = sum(len(c) for c in catalogs.values()) + len(code)
    return out, raw, bool(overrides)


def other_literals(root):
    """Littéraux hors catalogue (format!, libellés directs) : mesurés, jamais bloquants ici."""
    for p, text in rust_sources(root):
        rel = os.path.relpath(p, root)
        for n, ln in enumerate(text.split("\n"), 1):
            if ln.strip().startswith("//") or DISPLAY_CALL.search(ln):
                continue
            for m in LIT.finditer(ln):
                yield rel, n, unescape(m.group(1))


def cmd_catalogs(root, emoji_mode, terms_mode):
    shown, raw, has_overrides = displayed(root)
    emoji_hits, term_hits, other_hits = [], [], []
    for lang, key, text, origin in shown:
        for c in text:
            if is_emoji(c):
                emoji_hits.append((f"{lang} {origin}", c))
        for t in terms_in(text):
            term_hits.append((lang, t, text))
    # libellés du moteur affichés via i18n::t : surcharge anglaise ou libellé brut
    en_over = {}
    ov_path = os.path.join(root, "crates", "ui-egui", "src", "i18n", "overrides.tsv")
    if os.path.exists(ov_path):
        en_over = {src: disp for _, lang, src, disp in parse_tsv(ov_path) if lang == "en"}
    known = {key for _, key, _, _ in shown}
    residue, neutralised = [], 0
    for origin, line, lit, label in engine_literals(root):
        if lit in known or lit in en_over:
            # affiché via i18n::t et déjà couvert par la résolution ci-dessus
            neutralised += 1
        elif label:
            for t in terms_in(lit):
                term_hits.append(("moteur", t, f"{lit} ({origin}:{line})"))
        else:
            residue.append(f"{origin}:{line} « {lit[:90]} »")
    for origin, line, s in other_literals(root):
        for c in s:
            if is_emoji(c):
                other_hits.append((f"{origin}:{line}", c))

    def by_char(hits):
        agg = {}
        for where, c in hits:
            agg.setdefault(c, []).append(where)
        return agg

    langs = sorted({h[0] for h in shown})
    out = ["### Porte « catalogues » : émojis (E10) et termes sensibles (E9)", ""]
    out.append(f"{raw} chaînes de catalogue lues ; résolution d'affichage modélisée sur {len(langs)} langues ({', '.join(langs)}) : surcharge de la langue, sinon catalogue de la langue, sinon surcharge anglaise, sinon source. Catalogue de surcharge présent : {'oui' if has_overrides else 'non'}.")
    out.append("")
    out.append(f"Émojis et pictogrammes **affichés** (toutes langues, chaînes de catalogue) : **{len(emoji_hits)}** — mode `{emoji_mode}`.")
    for c, where in sorted(by_char(emoji_hits).items(), key=lambda x: ord(x[0])):
        out.append(f"- U+{ord(c):04X} {c} {unicodedata.name(c, '?')} ×{len(where)} : {', '.join(sorted(set(where))[:8])}{' …' if len(set(where)) > 8 else ''}")
    out.append("")
    out.append(f"Émojis hors catalogue (littéraux directs d'ui-egui, mesure non bloquante) : **{len(other_hits)}**.")
    for c, where in sorted(by_char(other_hits).items(), key=lambda x: ord(x[0])):
        out.append(f"- U+{ord(c):04X} {c} {unicodedata.name(c, '?')} ×{len(where)} : {', '.join(where[:8])}")
    out.append("")
    out.append(f"Termes sensibles **affichés** (toutes langues) : **{len(term_hits)}** — mode `{terms_mode}`.")
    out.append("")
    out.append("| Terme | Occurrences affichées |")
    out.append("|---|---|")
    for t in TERMS:
        out.append(f"| {t} | {sum(1 for h in term_hits if h[1] == t)} |")
    for lang, t, text in term_hits[:20]:
        out.append(f"- {lang} [{t}] : {text[:120]}")
    out.append("")
    out.append(f"Chaînes du moteur affichées via i18n::t et neutralisées par la résolution : {neutralised}.")
    out.append(f"Résidu moteur (messages hors i18n::t, non surchargeables sans exception L0–L5 ; mesure non bloquante) : **{len(residue)}**.")
    for r in residue:
        out.append(f"- {r}")
    text = "\n".join(out)
    print(text)
    summary(text)
    if not raw:
        print("::error::aucune chaîne de catalogue lue : la porte ne mesure rien")
        return 1
    rc = 0
    if emoji_hits and emoji_mode == "block":
        print(f"::error::émojis affichés par les catalogues : {len(emoji_hits)}")
        rc = 1
    elif emoji_hits:
        print(f"::warning::émojis affichés par les catalogues : {len(emoji_hits)} (mesure ; bloquant avec E10)")
    if term_hits and terms_mode == "block":
        print(f"::error::termes sensibles affichés : {len(term_hits)}")
        rc = 1
    elif term_hits:
        print(f"::notice::termes sensibles affichés : {len(term_hits)} (mesure ; bloquant avec E9)")
    return rc


# --- CSP -------------------------------------------------------------------------------------------

INLINE = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.S | re.I)


def cmd_csp(index, out):
    html = open(index, encoding="utf-8").read()
    hashes = []
    for attrs, body in INLINE.findall(html):
        if re.search(r"\bsrc\s*=", attrs, re.I):
            continue
        digest = base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode()
        hashes.append(f"'sha256-{digest}'")
    if not hashes:
        print("::error::aucun script inline trouvé : la mesure CSP est vide")
        return 1
    with open(out, "w", encoding="utf-8") as f:
        f.write("# Empreintes CSP des scripts inline de index.html (build Evora). Une par ligne.\n")
        f.write("# script-src 'self' 'wasm-unsafe-eval' " + " ".join(hashes) + "\n")
        for h in hashes:
            f.write(h + "\n")
    text = f"### Empreintes CSP\n\n{len(hashes)} script(s) inline :\n\n" + "\n".join(f"- `{h}`" for h in hashes)
    print(text)
    summary(text)
    return 0


# --- tailles ---------------------------------------------------------------------------------------

def cmd_sizes(site, zpath):
    rows = []
    for p in files_under(site, skip_dirs={"LICENSES"}):
        rel = os.path.relpath(p, site)
        if rel.endswith((".br", ".gz")) or rel.endswith(".txt"):
            continue
        size = os.path.getsize(p)
        br = os.path.getsize(p + ".br") if os.path.exists(p + ".br") else None
        gz = os.path.getsize(p + ".gz") if os.path.exists(p + ".gz") else None
        rows.append((rel, size, br, gz))
    lines = ["| Fichier | Brut | .br | .gz |", "|---|---|---|---|"]
    for rel, size, br, gz in rows:
        lines.append(f"| `{rel}` | {size} | {br if br is not None else '—'} | {gz if gz is not None else '—'} |")
    lines.append(f"| **archive** `{os.path.basename(zpath)}` | {os.path.getsize(zpath)} | — | — |")
    text = "### Tailles (octets)\n\n" + "\n".join(lines)
    print(text)
    summary(text)
    for rel, size, br, gz in rows:
        if rel.endswith(".wasm"):
            print(f"::notice::wasm brut {size} o ; .br {br} o ; .gz {gz} o")
    return 0


# --- evora-host.json (E4) -----------------------------------------------------------------------

HOSTCFG_EXPECTED = b'{"parentOrigins": []}\n'


def cmd_hostcfg(zpath):
    """Le pont EHP n'admet que les origines parentes que liste evora-host.json, écrit par le
    provisionnement d'Evora. L'artefact le livre vide (pont muet) et sans .br ni .gz, qu'un serveur
    pourrait servir à la place du fichier provisionné."""
    with zipfile.ZipFile(zpath) as z:
        names = z.namelist()
        found = [n for n in names if n.split("/")[-1].startswith("evora-host.json")]
        roots = [n for n in found if n.count("/") == 1 and n.endswith("/evora-host.json")]
        body = z.read(roots[0]) if len(roots) == 1 else None
    problems = []
    if len(roots) != 1:
        problems.append(f"evora-host.json à la racine du site : {len(roots)} (attendu : 1)")
    elif body != HOSTCFG_EXPECTED:
        problems.append(f"contenu inattendu : {body!r} (attendu : {HOSTCFG_EXPECTED!r})")
    extra = [n for n in found if n not in roots]
    if extra:
        problems.append("copies en trop : " + ", ".join(extra))
    text = "### Porte « evora-host.json » (bloquante)\n\n"
    text += ("`evora-host.json` livré vide, seul : pont EHP muet tant que le provisionnement ne l'écrit pas (VERT)." if not problems
             else "ROUGE :\n\n" + "\n".join(f"- {p}" for p in problems))
    print(text)
    summary(text)
    if problems:
        print("::error::evora-host.json : " + " ; ".join(problems))
        return 1
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd, args = argv[1], argv[2:]
    if cmd == "marks":
        return cmd_marks(args[0])
    if cmd == "hosting":
        return cmd_hosting(args[0])
    if cmd == "catalogs":
        root = args[0]
        emoji_mode = args[args.index("--emoji") + 1] if "--emoji" in args else "report"
        terms_mode = args[args.index("--terms") + 1] if "--terms" in args else "report"
        return cmd_catalogs(root, emoji_mode, terms_mode)
    if cmd == "csp":
        return cmd_csp(args[0], args[1])
    if cmd == "sizes":
        return cmd_sizes(args[0], args[1])
    if cmd == "hostcfg":
        return cmd_hostcfg(args[0])
    print(f"sous-commande inconnue : {cmd}")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
