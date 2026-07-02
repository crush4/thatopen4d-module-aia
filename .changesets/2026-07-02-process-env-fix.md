---
id: process-env-fix
type: fix
title: "process.env.NODE_ENV im Plugin-Bundle stubben"
audience: [user]
breaking: false
---
Third-Party-Libraries (TanStack, React-Interna in Prod-Mode) pruefen
`process.env.NODE_ENV` synchron beim Modul-Init. Im v1.0.0-Bundle war
das nicht via `define` gestubbt, wodurch das Panel beim Render mit
`ReferenceError: process is not defined` crashte.

