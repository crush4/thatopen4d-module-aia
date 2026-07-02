# @thatopen4d/module-aia

ThatOpen4D Stage-1-Plugin: **AIA** — Auftraggeber-Informations-
Anforderungen mit Survey-basierten Kacheln fuer Stammdaten, Projekt-
Profile, Leistungen und Standards.

## Installation

```json
"@thatopen4d/module-aia": "github:crush4/thatopen4d-module-aia#v1.0.0"
```

Wird beim App-Boot automatisch via `loadCorePlugins()` geladen.

## Panel-Features

Elf Survey-Kacheln (User-Profil, Projekt-Trade, Projekt-Profil, Teams,
Phasen/Meilensteine, LOD/LOI, Anlage-Typen, Software, Ziele, BIM-Uses,
TwinClass-LOIN) mit Rollen-basiertem Enable/Disable, Stammdaten-Auto-
Vervollstaendigung und Server-Persistenz via `/api/projects/:id/aia/*`.

## Build

```sh
npm install
npm run build
# → dist/plugin.js (~2.4 MB, gzip ~480 kB — enthaelt survey-core)
```

## Mindest-Host-Version

`engines.host = ^1.5.1` — braucht den `@thatopen4d/plugin-sdk/shared`-
Subpath fuer die Cross-Modul-Types.
