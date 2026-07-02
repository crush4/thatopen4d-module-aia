# Changesets

Plugin-eigene Patch Notes. Format identisch zur Hauptapp. Werden vom
Build-Script (`npm run build` → `scripts/write-changelog.mjs`) zu
`dist/plugin.js.changelog.json` aggregiert.

## Ablage

```
.changesets/
  YYYY-MM-DD-<slug>.md     ← aktive (in Arbeit befindliche) Version
  _archive/
    v1.0.0/*.md            ← initial release
    v1.0.1/*.md            ← spätere Tags
```

Lose `.md`-Dateien zählen zur Version aus `package.json#thatopen4d.version`.
Beim Plugin-Release werden sie nach `_archive/v<X>/` verschoben.

## Format

```yaml
---
id: <kebab-slug>
type: feature | fix | improvement | breaking | admin | internal
title: "Kurzer Titel"
audience: [user]     # optional, Default [user]
breaking: false      # optional, Default false
---
Markdown-Body…
```
