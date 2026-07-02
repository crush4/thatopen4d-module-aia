/**
 * @module packages/module-aia/src/views/standards-view
 *
 * StandardsView — Liste + Markdown-Editor für Projekt-Standards.
 *
 * Layout: links Liste (Namen), rechts Editor mit Titel-Feld und großer
 * Markdown-Textarea. Kein eingebettetes Markdown-Rendering — der Text
 * wird als monospace `<pre>` mit `white-space: pre-wrap` angezeigt.
 * Richtiges Rendering ist eine optionale Phase-6+-Erweiterung.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CreateStandardBody,
  Standard,
  UpdateStandardBody,
} from "@thatopen4d/plugin-sdk/shared";
import {
  createStandard,
  deleteStandard,
  listStandards,
  updateStandard,
} from "@thatopen4d/api-clients/aia";

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

const bodyStyle: React.CSSProperties = {
  flex: 1,
  display: "grid",
  gridTemplateColumns: "220px 1fr",
  minHeight: 0,
};

const sidebarStyle: React.CSSProperties = {
  borderRight: "1px solid var(--bim-ui_bg-contrast-20)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const sidebarToolbarStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--bim-ui_bg-contrast-20)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "0.5rem",
};

const sidebarListStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "0.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
};

const detailStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.3rem 0.7rem",
  background: "var(--bim-ui_accent-base, #4a9eff)",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  fontSize: "0.78rem",
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

const listItemStyle: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  background: "transparent",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "0.82rem",
  color: "var(--bim-ui_bg-contrast-80)",
};

const listItemSelectedStyle: React.CSSProperties = {
  ...listItemStyle,
  background: "var(--bim-ui_accent-base, #4a9eff)",
  color: "#fff",
};

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.6rem",
  background: "var(--bim-ui_bg-base)",
  color: "var(--bim-ui_bg-contrast-100, #fff)",
  border: "1px solid var(--bim-ui_bg-contrast-20)",
  borderRadius: "4px",
  fontSize: "0.85rem",
};

// ─── Props ───────────────────────────────────────────────────────────────────

export interface StandardsViewProps {
  projectId: string;
  onBack: () => void;
}

// ─── Komponente ──────────────────────────────────────────────────────────────

export function StandardsView({ projectId, onBack }: StandardsViewProps) {
  const [rows, setRows] = useState<Standard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [mode, setMode] = useState<"read" | "edit" | "new">("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await listStandards(projectId);
      setRows(next);
      // Wenn bisher keine Auswahl oder Auswahl nicht mehr vorhanden, erste wählen
      if (next.length > 0 && !next.some((r) => r.id === selectedId)) {
        setSelectedId(next[0]!.id);
      }
      if (next.length === 0) {
        setSelectedId(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Standards konnten nicht geladen werden: ${msg}`);
    }
  }, [projectId, selectedId]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Sync draft-Felder mit ausgewähltem Standard, wenn wir nicht im Edit-Modus sind
  useEffect(() => {
    if (mode === "read" && selected) {
      setDraftName(selected.name);
      setDraftContent(selected.contentMd);
    } else if (mode === "read" && !selected) {
      setDraftName("");
      setDraftContent("");
    }
  }, [selected, mode]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMode("read");
  }, []);

  const handleNew = useCallback(() => {
    setMode("new");
    setDraftName("");
    setDraftContent("");
  }, []);

  const handleEdit = useCallback(() => {
    if (!selected) return;
    setDraftName(selected.name);
    setDraftContent(selected.contentMd);
    setMode("edit");
  }, [selected]);

  const handleCancel = useCallback(() => {
    if (selected) {
      setDraftName(selected.name);
      setDraftContent(selected.contentMd);
    } else {
      setDraftName("");
      setDraftContent("");
    }
    setMode("read");
  }, [selected]);

  const handleSave = useCallback(async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setError("Name ist Pflicht.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "new") {
        const payload: CreateStandardBody = {
          name: trimmedName,
          contentMd: draftContent,
        };
        const created = await createStandard(projectId, payload);
        setSelectedId(created.id);
      } else if (mode === "edit" && selected) {
        const payload: UpdateStandardBody = {
          name: trimmedName,
          contentMd: draftContent,
        };
        await updateStandard(projectId, selected.id, payload);
      }
      setMode("read");
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Speichern fehlgeschlagen: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [mode, draftName, draftContent, projectId, selected, reload]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const ok = window.confirm(`Standard "${selected.name}" wirklich löschen?`);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteStandard(projectId, selected.id);
      setSelectedId(null);
      setMode("read");
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Löschen fehlgeschlagen: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [projectId, selected, reload]);

  const editing = mode !== "read";

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
        ← Standards
      </div>

      {error && (
        <div
          style={{
            padding: "0.5rem 1rem",
            background: "var(--bim-ui_accent-red, #c0392b)",
            color: "#fff",
            fontSize: "0.8rem",
          }}
        >
          {error}
        </div>
      )}

      <div style={bodyStyle}>
        <aside style={sidebarStyle}>
          <div style={sidebarToolbarStyle}>
            <span
              style={{
                fontSize: "0.72rem",
                color: "var(--bim-ui_bg-contrast-60)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Dokumente
            </span>
            <button
              type="button"
              style={buttonStyle}
              onClick={handleNew}
              disabled={busy || editing}
              title="Neues Dokument anlegen"
            >
              + Neu
            </button>
          </div>
          <div style={sidebarListStyle}>
            {rows.length === 0 ? (
              <div
                style={{
                  padding: "1rem 0.5rem",
                  fontSize: "0.78rem",
                  color: "var(--bim-ui_bg-contrast-60)",
                  textAlign: "center",
                }}
              >
                Noch keine Standards.
              </div>
            ) : (
              rows.map((row) => (
                <div
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelect(row.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      handleSelect(row.id);
                  }}
                  style={
                    row.id === selectedId
                      ? listItemSelectedStyle
                      : listItemStyle
                  }
                >
                  {row.name}
                </div>
              ))
            )}
          </div>
        </aside>

        <section style={detailStyle}>
          {mode === "read" && !selected && (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--bim-ui_bg-contrast-60)",
                fontSize: "0.85rem",
                padding: "2rem",
                textAlign: "center",
              }}
            >
              {rows.length === 0
                ? "Leg ein neues Standard-Dokument über „+ Neu“ an."
                : "Wähle ein Dokument aus der Liste."}
            </div>
          )}

          {(mode === "read" || mode === "edit") && selected && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <div
                style={{
                  padding: "0.75rem 1.25rem",
                  borderBottom: "1px solid var(--bim-ui_bg-contrast-20)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                {mode === "read" ? (
                  <h3
                    style={{
                      margin: 0,
                      fontSize: "1rem",
                      fontWeight: 600,
                      color: "var(--bim-ui_bg-contrast-100, #fff)",
                    }}
                  >
                    {selected.name}
                  </h3>
                ) : (
                  <input
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    style={{ ...inputStyle, flex: 1, maxWidth: 420 }}
                    maxLength={200}
                    disabled={busy}
                    placeholder="Name des Standards"
                  />
                )}
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {mode === "read" ? (
                    <>
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={handleEdit}
                        disabled={busy}
                      >
                        Bearbeiten
                      </button>
                      <button
                        type="button"
                        style={buttonDangerStyle}
                        onClick={handleDelete}
                        disabled={busy}
                      >
                        Löschen
                      </button>
                    </>
                  ) : (
                    <>
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
                        onClick={handleCancel}
                        disabled={busy}
                      >
                        Abbrechen
                      </button>
                    </>
                  )}
                </div>
              </div>

              {mode === "read" ? (
                <pre
                  style={{
                    flex: 1,
                    margin: 0,
                    padding: "1rem 1.25rem",
                    overflow: "auto",
                    background:
                      "var(--bim-ui_bg-contrast-5, rgba(255,255,255,0.03))",
                    color: "var(--bim-ui_bg-contrast-100, #fff)",
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    fontSize: "0.82rem",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {selected.contentMd || "— leerer Standard —"}
                </pre>
              ) : (
                <textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  disabled={busy}
                  style={{
                    flex: 1,
                    margin: 0,
                    padding: "1rem 1.25rem",
                    resize: "none",
                    background: "var(--bim-ui_bg-base)",
                    color: "var(--bim-ui_bg-contrast-100, #fff)",
                    border: "none",
                    outline: "none",
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    fontSize: "0.82rem",
                    lineHeight: 1.45,
                  }}
                  placeholder="# Standard\n\nMarkdown-Content eingeben …"
                />
              )}

              <div
                style={{
                  padding: "0.4rem 1.25rem",
                  borderTop: "1px solid var(--bim-ui_bg-contrast-20)",
                  fontSize: "0.72rem",
                  color: "var(--bim-ui_bg-contrast-60)",
                }}
              >
                Zuletzt geändert:{" "}
                {new Date(selected.updatedAt).toLocaleString()}
              </div>
            </div>
          )}

          {mode === "new" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <div
                style={{
                  padding: "0.75rem 1.25rem",
                  borderBottom: "1px solid var(--bim-ui_bg-contrast-20)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  style={{ ...inputStyle, flex: 1, maxWidth: 420 }}
                  maxLength={200}
                  disabled={busy}
                  placeholder="Name des neuen Standards"
                  autoFocus
                />
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <button
                    type="button"
                    style={buttonStyle}
                    onClick={handleSave}
                    disabled={busy}
                  >
                    Anlegen
                  </button>
                  <button
                    type="button"
                    style={buttonSecondaryStyle}
                    onClick={handleCancel}
                    disabled={busy}
                  >
                    Abbrechen
                  </button>
                </div>
              </div>
              <textarea
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                disabled={busy}
                style={{
                  flex: 1,
                  margin: 0,
                  padding: "1rem 1.25rem",
                  resize: "none",
                  background: "var(--bim-ui_bg-base)",
                  color: "var(--bim-ui_bg-contrast-100, #fff)",
                  border: "none",
                  outline: "none",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: "0.82rem",
                  lineHeight: 1.45,
                }}
                placeholder="# Neuer Standard\n\nMarkdown-Content eingeben …"
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
