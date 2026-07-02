/**
 * @module packages/module-aia/src/nomenclature
 *
 * Deliverable-Nomenklatur — pure function.
 *
 * Generiert aus einem Deliverable + Projekt-Kontext einen standardisierten
 * Kurz-Code (analog zu dotBEP/ISO-19650-Nomenklaturen). Das Format ist
 * bewusst konservativ:
 *
 *   `{ProjectCode}-{TeamCode}-{DisciplineCode}-{LbsPath}-{AssetTypeCode}-{MilestoneCode}-{Seq}`
 *
 * Fehlende Teile werden durch ein **Platzhalter-Token** ersetzt (`"---"`),
 * sodass die Trennung stabil bleibt. Das Ergebnis ist immer in Großschrift
 * und enthält ausschließlich `[A-Z0-9-_/]`.
 *
 * **Bewusst pure.** Keine API-Calls, keine Side-Effects — die Funktion ist
 * leicht unit-testbar (Snapshot-Tests gegen dotBEP-Beispiele sind Plan-
 * Sprint-3-Task).
 */

import type {
  AiaStammdatenEntry,
  Deliverable,
} from "@thatopen4d/plugin-sdk/shared";

/** Platzhalter für fehlende Teile im Code. Stabil, nicht lokalisiert. */
const MISSING = "---";

/**
 * Nomenklatur-Kontext — alle Referenzen, die der Generator auflösen muss.
 * Wird vom Panel aus den bereits geladenen Stammdaten + Survey-Responses
 * zusammengestellt und an `generateDeliverableCode` übergeben.
 */
export interface NomenclatureContext {
  /** Projekt-Kurzcode aus `project-profile`-Response (z. B. "ABC23"). */
  projectCode: string | null;
  /** Asset-Type-Stammdaten (für `meta.code`-Lookup). */
  assetTypes: AiaStammdatenEntry[];
  /** Team-Stammdaten (für `meta.code`-Lookup). */
  teams: AiaStammdatenEntry[];
  /** Disziplinen (Stammdaten `type="trade"`). */
  disciplines: AiaStammdatenEntry[];
}

/**
 * Ersetzt alle Nicht-Nomenklatur-Zeichen durch `-` und konvertiert in
 * Großbuchstaben. Leere Strings bleiben leer (Caller entscheidet dann,
 * ob MISSING eingesetzt wird).
 */
function sanitize(part: string): string {
  return part
    .toUpperCase()
    .replace(/[^A-Z0-9_/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Liefert den `code`-String aus einem Stammdaten-Eintrag (Team, Asset-Type,
 * Discipline) oder `null`, wenn kein Code gesetzt ist. Disziplinen haben
 * normalerweise keinen Code im `meta` — fallback: erste drei Buchstaben
 * des `de`-Labels.
 */
function lookupCode(
  id: string | null | undefined,
  entries: AiaStammdatenEntry[],
  fallbackFromLabel = false,
): string | null {
  if (!id) return null;
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  const meta = (entry.meta ?? {}) as { code?: string };
  if (meta.code) return sanitize(meta.code);
  if (fallbackFromLabel) {
    const label = entry.labels["de"] ?? Object.values(entry.labels)[0];
    if (label) return sanitize(label.slice(0, 3));
  }
  return null;
}

/** Pads den Seq-Zähler auf zwei Stellen mit führender Null. */
function formatSeq(seq: number): string {
  if (seq < 0) return MISSING;
  return seq.toString().padStart(2, "0");
}

/**
 * Generiert den Deliverable-Code aus einem `Deliverable` + Kontext.
 *
 * Beispiel-Output: `ABC23-ARC-ARCHITEKTUR-B1/EG-M3D-M2-03`
 *
 * @param deliverable - Die Quelle aller Deliverable-Felder.
 * @param ctx         - Stammdaten + Projekt-Kontext zum Auflösen der IDs.
 * @returns Einzeiliger, groß geschriebener Nomenklatur-Code.
 */
export function generateDeliverableCode(
  deliverable: Pick<
    Deliverable,
    | "disciplineId"
    | "assetTypeId"
    | "responsibleTeamId"
    | "milestoneCode"
    | "lbsPath"
    | "seq"
  >,
  ctx: NomenclatureContext,
): string {
  const parts: string[] = [
    ctx.projectCode ? sanitize(ctx.projectCode) : MISSING,
    lookupCode(deliverable.responsibleTeamId, ctx.teams) ?? MISSING,
    lookupCode(deliverable.disciplineId, ctx.disciplines, true) ?? MISSING,
    deliverable.lbsPath ? sanitize(deliverable.lbsPath) : MISSING,
    lookupCode(deliverable.assetTypeId, ctx.assetTypes) ?? MISSING,
    deliverable.milestoneCode ? sanitize(deliverable.milestoneCode) : MISSING,
    formatSeq(deliverable.seq),
  ];
  return parts.join("-");
}
