/**
 * @module @thatopen4d/module-aia/register
 *
 * Plugin-Bundle-Default-Export fuer das AIA-Plugin (Stage 1).
 *
 * Frueher unter `packages/module-aia/` im Hauptrepo, jetzt eigenstaendiges
 * Repo `crush4/thatopen4d-module-aia`. Reines Fach-Panel: keine
 * Cross-Modul-API, kein Service-Provider, kein Live-Connect noetig.
 */

import { createPlugin } from "@thatopen4d/plugin-sdk/manifest";
import { registerReactPanel } from "@thatopen4d/plugin-sdk/registry";
import { PANEL_IDS } from "@thatopen4d/plugin-sdk/host";
import type { PluginHostContext } from "@thatopen4d/plugin-sdk/types";
import pkg from "../package.json";
import { AiaPanel } from "./panel";

const tp = pkg.thatopen4d as {
  id: string;
  displayName: string;
  version: string;
  engines: { host: string };
};

const manifest = {
  id: tp.id,
  displayName: tp.displayName,
  version: tp.version,
  engines: tp.engines,
  contributes: {
    panels: [
      {
        panelId: PANEL_IDS.AIA,
        title: "AIA",
        icon: "mdi:clipboard-list-outline",
      },
    ],
  },
};

export default async function activate(host: PluginHostContext) {
  return createPlugin(manifest, {
    id: manifest.id,
    title: manifest.displayName,

    register: () => {
      registerReactPanel(PANEL_IDS.AIA, {
        component: AiaPanel,
        title: "AIA",
      });
    },

    init: () => {
      void host;
    },

    dispose: () => {},
  });
}
