/**
 * Vite-Library-Build fuer das ThatOpen4D-Plugin-Bundle.
 *
 * Output: dist/plugin.js — ESM-Bundle, das vom Host-Plugin-Loader via
 * dynamischem import() geladen wird. Companions: dist/plugin.js.manifest.json
 * + dist/plugin.js.changelog.json werden vom build-Script geschrieben.
 *
 * **Externals-Strategie** (1:1 zu @thatopen4d/dev-host).
 * Alle Host-Singletons (React, plugin-sdk, ThatOpen-Engine) bleiben aussen vor
 * — sie werden vom Host via Externals + Import-Map injiziert. Das vermeidet
 * doppelte React-Instanzen (Hooks-Crash) und sorgt dafuer, dass das Plugin
 * dieselbe `globalThis`-basierte Service-Registry sieht wie der Host.
 *
 * Ein eigener `resolveId`-Hook mit `enforce: "pre"` erzwingt die Externals
 * auch im Dev-Mode — Vite's Standard-`rollupOptions.external` greift dort
 * sonst nicht.
 */

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

const HOST_EXTERNALS: (string | RegExp)[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@thatopen/components",
  "@thatopen/components-front",
  "@thatopen/fragments",
  /^@thatopen4d\/plugin-sdk(\/.*)?$/,
  // api-clients ist seit dem host-shared-Bundle ebenfalls extern — der Host
  // liefert alle 18 Subpaths via Import-Map aus. Damit haben Plugins und Host
  // dieselbe HTTP-Client-Instanz und teilen sich Auth-Cookies + Caches.
  /^@thatopen4d\/api-clients(\/.*)?$/,
];

function isExternal(id: string): boolean {
  for (const m of HOST_EXTERNALS) {
    if (typeof m === "string") {
      if (id === m || id.startsWith(m + "/")) return true;
    } else {
      if (m.test(id)) return true;
    }
  }
  return false;
}

function hostExternalsPlugin(): Plugin {
  return {
    name: "thatopen4d-host-externals",
    enforce: "pre",
    resolveId(id: string) {
      if (id.startsWith("\0") || id.startsWith(".") || id.startsWith("/")) {
        return null;
      }
      if (isExternal(id)) {
        return { id, external: true };
      }
      return null;
    },
  };
}

export default defineConfig({
  // CSS inline ins Bundle einbetten — der Host laedt nur dist/plugin.js,
  // nicht zusaetzlich eine externe CSS-Datei. Das vermeidet eine zweite
  // URL-Konfiguration im Plugin-Loader und stellt sicher, dass die
  // panel.css genau dann da ist, wenn das Plugin aktiv ist.
  plugins: [react(), hostExternalsPlugin(), cssInjectedByJsPlugin()],
  // Node-Globals stubben — sonst crashen Libraries wie TanStack in Prod-Mode.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/register.ts",
      formats: ["es"],
      fileName: () => "plugin.js",
    },
    rollupOptions: {
      external: HOST_EXTERNALS,
    },
    sourcemap: true,
    emptyOutDir: true,
    outDir: "dist",
  },
});
