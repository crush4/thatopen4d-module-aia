/**
 * Schreibt das Plugin-Manifest aus package.json#thatopen4d als Companion-Datei
 * neben das gebaute Bundle: dist/plugin.js.manifest.json.
 *
 * Der Host-Plugin-Loader (resp. Plugin-Install-Service) erwartet die Datei
 * exakt an dieser Stelle, um ohne Bundle-Download an die Manifest-Daten zu
 * kommen.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const pkg = JSON.parse(
  await readFile(join(repoRoot, "package.json"), "utf-8"),
);
const manifest = pkg.thatopen4d;

if (!manifest) {
  console.error("package.json#thatopen4d fehlt");
  process.exit(1);
}

const outPath = join(repoRoot, "dist", "plugin.js.manifest.json");
await writeFile(outPath, JSON.stringify(manifest, null, 2), "utf-8");
console.log(`  Manifest:      dist/plugin.js.manifest.json`);
console.log(`  Plugin-ID:     ${manifest.id}`);
