/**
 * Aggregiert die Plugin-Changesets unter `.changesets/` zu einem autarken
 * Changelog-Artefakt: `dist/plugin.js.changelog.json`.
 *
 * Der Host fetcht diese Begleitdatei (genau wie `plugin.js.manifest.json`)
 * und zeigt sie im Plugins-Panel unter "Was ist neu" an. Der Changelog-
 * Inhalt lebt damit autark im Plugin — die Hauptanwendung aggregiert nichts.
 *
 * **Konvention.**
 *   .changesets/
 *     2026-05-20-neue-funktion.md      ← aktive (in Arbeit befindliche) Version
 *     _archive/
 *       v1.0.5/2026-05-12-fix.md        ← bereits veroeffentlichte Versionen
 *
 * Lose `.md`-Dateien zaehlen zur aktuellen `package.json#thatopen4d.version`.
 * Jeder `_archive/v<X>/`-Ordner ist eine abgeschlossene Version.
 *
 * **Changeset-Format.** `YYYY-MM-DD-<slug>.md` mit YAML-Frontmatter:
 *   ---
 *   id: <kebab-slug>
 *   type: feature | fix | improvement | breaking | admin | internal
 *   title: "Kurzer Titel"
 *   audience: [user]     # optional, Default [user]
 *   breaking: false      # optional, Default false
 *   ---
 *   Markdown-Body …
 *
 * Bewusst dependency-frei (kein gray-matter o. Ae.) — die Frontmatter sind
 * einfach und vollstaendig vom Plugin-Autor kontrolliert. Schema-Drift wird
 * host-seitig von `parsePluginChangelog` (Zod) abgefangen.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const changesetsDir = join(repoRoot, ".changesets");
const archiveDir = join(changesetsDir, "_archive");

const VALID_TYPES = new Set([
  "feature",
  "fix",
  "improvement",
  "breaking",
  "admin",
  "internal",
]);
const VALID_AUDIENCES = new Set(["user", "admin", "developer", "internal"]);
/** `YYYY-MM-DD-<slug>.md` — Datums-Praefix treibt das `publishedAt`. */
const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

// ─── Plugin-Manifest lesen ────────────────────────────────────────────────────

const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"));
const manifest = pkg.thatopen4d;
if (!manifest || !manifest.id || !manifest.version) {
  console.error("package.json#thatopen4d (id + version) fehlt");
  process.exit(1);
}

// ─── Frontmatter-Parsing ──────────────────────────────────────────────────────

/** Entfernt umschliessende einfache/doppelte Anfuehrungszeichen. */
function unquote(value) {
  const t = String(value).trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parst ein Changeset (`---`-Frontmatter + Markdown-Body) zu einem
 * PluginChangelogEntry. Wirft hart bei ungueltigen Feldern.
 */
function parseChangeset(raw, filePath) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${filePath}: kein YAML-Frontmatter gefunden`);
  const [, fmBlock, body] = m;

  const fm = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const id = unquote(fm.id ?? "");
  if (!id) throw new Error(`${filePath}: Frontmatter-Feld 'id' fehlt`);

  const type = unquote(fm.type ?? "");
  if (!VALID_TYPES.has(type)) {
    throw new Error(`${filePath}: ungueltiger 'type' "${type}"`);
  }

  const title = unquote(fm.title ?? "");
  if (!title) throw new Error(`${filePath}: Frontmatter-Feld 'title' fehlt`);

  // audience — optional, Default ["user"]. Flow-Array `[user, admin]`.
  let audience = ["user"];
  if (fm.audience !== undefined && fm.audience !== "") {
    audience = fm.audience
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter(Boolean);
    if (audience.length === 0) audience = ["user"];
    for (const a of audience) {
      if (!VALID_AUDIENCES.has(a)) {
        throw new Error(`${filePath}: ungueltige 'audience' "${a}"`);
      }
    }
  }

  const breaking = unquote(fm.breaking ?? "false") === "true";

  return { id, type, title, body: body.trim(), audience, breaking };
}

/**
 * Liest alle datierten Changeset-`.md`-Files eines Verzeichnisses (nicht
 * rekursiv; README.md und sonstige Doku ohne Datums-Praefix bleiben aussen vor).
 */
async function loadChangesets(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isFile() || !FILENAME_DATE_RE.test(e.name)) continue;
    const filePath = join(dir, e.name);
    const raw = await readFile(filePath, "utf-8");
    result.push({
      entry: parseChangeset(raw, filePath),
      fileDate: FILENAME_DATE_RE.exec(e.name)[1],
    });
  }
  return result;
}

/** Jüngstes Datei-Datum als `publishedAt`; Fallback Build-Zeitpunkt. */
function derivePublishedAt(loaded) {
  const dates = loaded.map((l) => l.fileDate).filter(Boolean).sort();
  if (dates.length === 0) return new Date().toISOString();
  return `${dates[dates.length - 1]}T12:00:00.000Z`;
}

/** Einfacher SemVer-Vergleich fuer `major.minor.patch`. */
function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

const versions = [];

// 1. Vergangene Versionen aus .changesets/_archive/v<X>/
let archiveEntries = [];
try {
  archiveEntries = await readdir(archiveDir, { withFileTypes: true });
} catch {
  // kein _archive — ok
}
for (const d of archiveEntries) {
  if (!d.isDirectory() || !d.name.startsWith("v")) continue;
  const version = d.name.slice(1);
  const loaded = await loadChangesets(join(archiveDir, d.name));
  if (loaded.length === 0) continue;
  versions.push({
    version,
    publishedAt: derivePublishedAt(loaded),
    entries: loaded.map((l) => l.entry),
  });
}

// 2. Aktive Version — lose .changesets/*.md → manifest.version
const active = await loadChangesets(changesetsDir);
if (active.length > 0) {
  const activeVersion = {
    version: manifest.version,
    publishedAt: derivePublishedAt(active),
    entries: active.map((l) => l.entry),
  };
  const idx = versions.findIndex((v) => v.version === manifest.version);
  if (idx >= 0) versions[idx] = activeVersion;
  else versions.push(activeVersion);
}

// Neueste Version zuerst.
versions.sort((a, b) => cmpSemver(b.version, a.version));

const changelog = {
  schemaVersion: 1,
  pluginId: manifest.id,
  generatedAt: new Date().toISOString(),
  versions,
};

const outPath = join(repoRoot, "dist", "plugin.js.changelog.json");
await writeFile(outPath, JSON.stringify(changelog, null, 2), "utf-8");
console.log(
  `  Changelog:     dist/plugin.js.changelog.json (${versions.length} Versionen)`,
);
