---
id: initial-extract
type: feature
title: "Initial Extract aus dem ThatOpen4D-Hauptrepo (v1.0.0)"
audience: [developer]
breaking: false
---
Erstes eigenständiges Release als Stage-1-Core-Plugin. Frueher unter
`packages/module-aia/` im Hauptrepo, jetzt als externes Repo
`crush4/thatopen4d-module-aia` versionierbar und unabhaengig
release-faehig.

**Funktionalitaet unveraendert.** Elf Survey-Kacheln (User-Profil,
Projekt-Trade, Projekt-Profil, Teams, Phasen/Meilensteine, LOD/LOI,
Anlage-Typen, Software, Ziele, BIM-Uses, TwinClass-LOIN),
Stammdaten-Verwaltung mit Auto-Vervollstaendigung, Rollen-basiertes
Enable/Disable pro Kachel. Alle API-Calls laufen unveraendert ueber
`@thatopen4d/api-clients/aia`.

**Cross-Modul-Vertrag:** keiner. AIA ist ein reines Endkonsumenten-Panel
ohne Provider-Rolle.

**Mindest-Host-Version** `^1.5.1` — braucht den neuen
`@thatopen4d/plugin-sdk/shared`-Subpath fuer die Cross-Modul-Types
aus `@thatopen4d/shared/aia-types` und `@thatopen4d/shared/twin-types`.
