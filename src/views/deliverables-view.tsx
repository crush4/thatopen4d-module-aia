/**
 * @module packages/module-aia/src/views/deliverables-view
 *
 * DeliverablesView — Tabelle mit CRUD für projektspezifische Deliverables.
 *
 * Kein SurveyJS — die Spalten-Anzahl ist fix (8 Felder) und Inline-Editing
 * ist besser geeignet als ein matrixdynamic-Formular. Änderungen schreiben
 * direkt gegen `/api/aia/projects/:id/deliverables` via api-clients.
 *
 * Layout:
 *  - Zurück-Button oben.
 *  - "+ Neues Deliverable" → setzt `editing` auf ein leeres Default.
 *  - Liste der Deliverables unter dem Button (klickbar, öffnet Edit-Form).
 *  - Edit-Form erscheint unter der Zeile und bietet Speichern/Löschen/Abbrechen.
 *  - Live-Preview des generierten Nomenklatur-Codes im Formular.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AiaStammdatenEntry,
  CreateDeliverableBody,
  Deliverable,
  UpdateDeliverableBody,
} from "@thatopen4d/plugin-sdk/shared";
import {
  createDeliverable,
  deleteDeliverable,
  listDeliverables,
  updateDeliverable,
} from "@thatopen4d/api-clients/aia";
import {
  generateDeliverableCode,
  type NomenclatureContext,
} from "../nomenclature";

// ─── Styling ────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  padding: "0.5rem 1rem",
  borderBottom: "1px solid var(--bim-ui_bg-contrast-20)",
  fontSize: "0.82rem",
  color: "var(--bim-ui_bg-contrast-60)",
  cursor: "pointer",
  userSelect: "none",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.75rem 1.25rem",
  borderBottom: "1px solid var(--bim-ui_bg-contrast-20)",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.35rem 0.8rem",
  background: "var(--bim-ui_accent-base, #4a9eff)",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  fontSize: "0.8rem",
  fontWeight: 500,
  cursor: "pointer",
};

const buttonSecondaryStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "transparent",
  color: "var(--bim-ui_bg-contrast-80)",
  border: "1px solid var(--bim-ui_bg-contrast-20)",
};

const buttonDangerStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "var(--bim-ui_accent-red, #c0392b)",
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "1rem 1.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const rowStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: "var(--bim-ui_bg-contrast-5, rgba(255,255,255,0.05))",
  border: "1px solid var(--bim-ui_bg-contrast-20)",
  borderRadius: "6px",
  cursor: "pointer",
};

const rowSelectedStyle: React.CSSProperties = {
  ...rowStyle,
  borderColor: "var(--bim-ui_accent-base, #4a9eff)",
};

const rowCodeStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "var(--bim-ui_accent-base, #4a9eff)",
  fontFamily: "monospace",
};

const rowDescStyle: React.CSSProperties = {
  fontSize: "0.88rem",
  color: "var(--bim-ui_bg-contrast-100, #fff)",
  fontWeight: 500,
  marginTop: "0.15rem",
};

const formStyle: React.CSSProperties = {
  padding: "1rem 1.25rem",
  borderTop: "1px solid var(--bim-ui_bg-contrast-20)",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  background: "var(--bim-ui_bg-contrast-5, rgba(255,255,255,0.03))",
};

const fieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 500,
  color: "var(--bim-ui_bg-contrast-80)",
};

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  background: "var(--bim-ui_bg-base)",
  color: "var(--bim-ui_bg-contrast-100, #fff)",
  border: "1px solid var(--bim-ui_bg-contrast-20)",
  borderRadius: "4px",
  fontSize: "0.85rem",
};

// ─── Typen ──────────────────────────────────────────────────────────────────

export interface DeliverablesViewProps {
  projectId: string;
  /** Projekt-Code aus project-profile-Response (für Nomenklatur). */
  projectCode: string | null;
  /** Stammdaten für Dropdowns + Nomenklatur. */
  assetTypes: AiaStammdatenEntry[];
  softwares: AiaStammdatenEntry[]; // aktuell nicht genutzt, Reserve für Sprint 3+
  teams: AiaStammdatenEntry[];
  disciplines: AiaStammdatenEntry[];
  /** Milestones aus project-phases-milestones-Response (für Dropdown). */
  milestones: Array<Record<string, unknown>>;
  onBack: () => void;
}

/**
 * Formular-State: draft ist immer `UpdateDeliverableBody` (alle Felder
 * optional), damit partielle Änderungen beim Editieren möglich sind.
 * Beim Save wird für `mode: "new"` die `description`-Pflicht geprüft,
 * bevor der Payload als `CreateDeliverableBody` zum POST gesendet wird.
 */
type EditingState =
  | { mode: "new"; draft: UpdateDeliverableBody }
  | { mode: "edit"; id: string; draft: UpdateDeliverableBody };

function emptyDraft(): UpdateDeliverableBody {
  return {
    description: "",
    disciplineId: null,
    assetTypeId: null,
    responsibleTeamId: null,
    milestoneCode: null,
    lbsPath: null,
    predecessorId: null,
  };
}

// ─── Helpers für Dropdown-Labels ────────────────────────────────────────────

function stammdatenLabel(
  entries: AiaStammdatenEntry[],
  id: string | null | undefined,
): string {
  if (!id) return "—";
  const entry = entries.find((e) => e.id === id);
  if (!entry) return "—";
  return entry.labels["de"] ?? Object.values(entry.labels)[0] ?? "—";
}

// ─── Root-Komponente ────────────────────────────────────────────────────────

export function DeliverablesView({
  projectId,
  projectCode,
  assetTypes,
  teams,
  disciplines,
  milestones,
  onBack,
}: DeliverablesViewProps) {
  const [rows, setRows] = useState<Deliverable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [busy, setBusy] = useState(false);

  const nomenclatureCtx: NomenclatureContext = useMemo(
    () => ({ projectCode, assetTypes, teams, disciplines }),
    [projectCode, assetTypes, teams, disciplines],
  );

  // Initial-Load + Reload-Helper
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listDeliverables(projectId);
      setRows(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Deliverables konnten nicht geladen werden: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Handler: neuen Eintrag starten
  const handleNew = useCallback(() => {
    setEditing({ mode: "new", draft: emptyDraft() });
  }, []);

  // Handler: bestehenden Eintrag zum Bearbeiten öffnen
  const handleEdit = useCallback((row: Deliverable) => {
    setEditing({
      mode: "edit",
      id: row.id,
      draft: {
        description: row.description,
        disciplineId: row.disciplineId,
        assetTypeId: row.assetTypeId,
        responsibleTeamId: row.responsibleTeamId,
        milestoneCode: row.milestoneCode,
        lbsPath: row.lbsPath,
        predecessorId: row.predecessorId,
        seq: row.seq,
        code: row.code,
      },
    });
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditing(null);
  }, []);

  const updateDraft = useCallback(
    <K extends keyof UpdateDeliverableBody>(
      key: K,
      value: UpdateDeliverableBody[K] | null,
    ) => {
      setEditing((prev) => {
        if (!prev) return prev;
        return { ...prev, draft: { ...prev.draft, [key]: value } };
      });
    },
    [],
  );

  // Live-Preview des Nomenklatur-Codes
  const previewCode = useMemo(() => {
    if (!editing) return null;
    const d = editing.draft;
    const seq = typeof d.seq === "number" ? d.seq : rows.length;
    return generateDeliverableCode(
      {
        disciplineId: d.disciplineId ?? null,
        assetTypeId: d.assetTypeId ?? null,
        responsibleTeamId: d.responsibleTeamId ?? null,
        milestoneCode: d.milestoneCode ?? null,
        lbsPath: d.lbsPath ?? null,
        seq,
      },
      nomenclatureCtx,
    );
  }, [editing, rows.length, nomenclatureCtx]);

  // Speichern
  const handleSave = useCallback(async () => {
    if (!editing) return;
    const description = editing.draft.description?.trim();
    if (!description) {
      setError("Beschreibung ist Pflicht.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const withCode = { ...editing.draft, description, code: previewCode };
      if (editing.mode === "new") {
        // description ist oben bereits validiert — Cast auf Create-Body sicher.
        await createDeliverable(projectId, withCode as CreateDeliverableBody);
      } else {
        await updateDeliverable(projectId, editing.id, withCode);
      }
      setEditing(null);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Speichern fehlgeschlagen: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [editing, previewCode, projectId, reload]);

  // Löschen
  const handleDelete = useCallback(async () => {
    if (!editing || editing.mode !== "edit") return;
    const ok = window.confirm("Deliverable wirklich löschen?");
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDeliverable(projectId, editing.id);
      setEditing(null);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Löschen fehlgeschlagen: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [editing, projectId, reload]);

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div style={containerStyle}>
      <div
        style={headerStyle}
        role="button"
        tabIndex={0}
        onClick={onBack}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onBack();
        }}
        title="Zurück zur Übersicht"
      >
        ← Deliverables
      </div>

      <div style={toolbarStyle}>
        <span
          style={{ fontSize: "0.82rem", color: "var(--bim-ui_bg-contrast-60)" }}
        >
          {loading
            ? "Lädt …"
            : `${rows.length} ${rows.length === 1 ? "Deliverable" : "Deliverables"}`}
        </span>
        <button
          type="button"
          style={buttonStyle}
          onClick={handleNew}
          disabled={busy}
        >
          + Neues Deliverable
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: "0.6rem 1.25rem",
            background: "var(--bim-ui_accent-red, #c0392b)",
            color: "#fff",
            fontSize: "0.82rem",
          }}
        >
          {error}
        </div>
      )}

      <div style={listStyle}>
        {rows.length === 0 && !loading && (
          <div
            style={{
              padding: "2rem",
              textAlign: "center",
              color: "var(--bim-ui_bg-contrast-60)",
              fontSize: "0.85rem",
            }}
          >
            Noch keine Deliverables. Leg eines über „+ Neues Deliverable" an.
          </div>
        )}

        {rows.map((row) => {
          const selected = editing?.mode === "edit" && editing.id === row.id;
          return (
            <div
              key={row.id}
              style={selected ? rowSelectedStyle : rowStyle}
              role="button"
              tabIndex={0}
              onClick={() => handleEdit(row)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleEdit(row);
              }}
            >
              <div style={rowCodeStyle}>{row.code ?? "—"}</div>
              <div style={rowDescStyle}>{row.description}</div>
              <div
                style={{
                  marginTop: "0.2rem",
                  fontSize: "0.72rem",
                  color: "var(--bim-ui_bg-contrast-60)",
                  display: "flex",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <span>
                  DP: {stammdatenLabel(disciplines, row.disciplineId)}
                </span>
                <span>
                  · AT: {stammdatenLabel(assetTypes, row.assetTypeId)}
                </span>
                <span>
                  · Team: {stammdatenLabel(teams, row.responsibleTeamId)}
                </span>
                {row.milestoneCode && <span>· MS: {row.milestoneCode}</span>}
                {row.lbsPath && <span>· LBS: {row.lbsPath}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <div style={formStyle}>
          <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>
            {editing.mode === "new"
              ? "Neues Deliverable"
              : "Deliverable bearbeiten"}
          </div>

          <div style={fieldStyle}>
            <span style={labelStyle}>Beschreibung *</span>
            <input
              type="text"
              value={editing.draft.description ?? ""}
              onChange={(e) => updateDraft("description", e.target.value)}
              style={inputStyle}
              maxLength={500}
              disabled={busy}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.75rem",
            }}
          >
            <div style={fieldStyle}>
              <span style={labelStyle}>Disziplin</span>
              <select
                value={editing.draft.disciplineId ?? ""}
                onChange={(e) =>
                  updateDraft("disciplineId", e.target.value || null)
                }
                style={inputStyle}
                disabled={busy}
              >
                <option value="">— keine —</option>
                {disciplines.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.labels["de"] ?? d.id}
                  </option>
                ))}
              </select>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Asset-Type</span>
              <select
                value={editing.draft.assetTypeId ?? ""}
                onChange={(e) =>
                  updateDraft("assetTypeId", e.target.value || null)
                }
                style={inputStyle}
                disabled={busy}
              >
                <option value="">— keiner —</option>
                {assetTypes.map((a) => {
                  const meta = (a.meta ?? {}) as { code?: string };
                  const label = a.labels["de"] ?? a.id;
                  return (
                    <option key={a.id} value={a.id}>
                      {meta.code ? `${meta.code} · ${label}` : label}
                    </option>
                  );
                })}
              </select>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Verantwortliches Team</span>
              <select
                value={editing.draft.responsibleTeamId ?? ""}
                onChange={(e) =>
                  updateDraft("responsibleTeamId", e.target.value || null)
                }
                style={inputStyle}
                disabled={busy}
              >
                <option value="">— keines —</option>
                {teams.map((t) => {
                  const meta = (t.meta ?? {}) as { code?: string };
                  const label = t.labels["de"] ?? t.id;
                  return (
                    <option key={t.id} value={t.id}>
                      {meta.code ? `${meta.code} · ${label}` : label}
                    </option>
                  );
                })}
              </select>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Milestone</span>
              <select
                value={editing.draft.milestoneCode ?? ""}
                onChange={(e) =>
                  updateDraft("milestoneCode", e.target.value || null)
                }
                style={inputStyle}
                disabled={busy}
              >
                <option value="">— keiner —</option>
                {milestones.map((m, i) => {
                  const code = (m["code"] as string | undefined) ?? "";
                  const name = (m["name"] as string | undefined) ?? "";
                  if (!code) return null;
                  return (
                    <option key={`${code}-${i}`} value={code}>
                      {name ? `${code} · ${name}` : code}
                    </option>
                  );
                })}
              </select>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>LBS-Pfad</span>
              <input
                type="text"
                value={editing.draft.lbsPath ?? ""}
                onChange={(e) => updateDraft("lbsPath", e.target.value || null)}
                placeholder="z. B. B1/EG/Zone-A"
                style={inputStyle}
                disabled={busy}
              />
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Sortierung (seq)</span>
              <input
                type="number"
                min={0}
                value={editing.draft.seq ?? ""}
                onChange={(e) =>
                  updateDraft(
                    "seq",
                    e.target.value ? parseInt(e.target.value, 10) : undefined,
                  )
                }
                style={inputStyle}
                disabled={busy}
              />
            </div>
          </div>

          {previewCode && (
            <div
              style={{
                padding: "0.5rem 0.75rem",
                background:
                  "var(--bim-ui_bg-contrast-10, rgba(255,255,255,0.04))",
                borderRadius: "4px",
                fontFamily: "monospace",
                fontSize: "0.78rem",
                color: "var(--bim-ui_accent-base, #4a9eff)",
              }}
            >
              Code-Vorschau: <strong>{previewCode}</strong>
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "0.5rem",
            }}
          >
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={handleSave}
                disabled={busy}
              >
                Speichern
              </button>
              <button
                type="button"
                style={buttonSecondaryStyle}
                onClick={handleCancelEdit}
                disabled={busy}
              >
                Abbrechen
              </button>
            </div>
            {editing.mode === "edit" && (
              <button
                type="button"
                style={buttonDangerStyle}
                onClick={handleDelete}
                disabled={busy}
              >
                Löschen
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
