/**
 * @module packages/module-aia/src/panel
 *
 * AIA-Panel — Hub mit mehreren Survey-Kacheln.
 *
 * Flow:
 *  1. Kein aktives Projekt → Empty-State.
 *  2. Projekt geladen → Survey-Definitionen + Stammdaten parallel laden.
 *  3. isManager aus User-Profil-Antwort + bimRoles ableiten.
 *  4. Hub-View mit Kacheln rendern (immer: Profil; nur Manager: Projekt-Gewerke).
 *  5. User ohne completed Profil → direkt SurveyRunner für user-profile.
 *  6. Kachel-Klick → SurveyRunner für den gewählten Key.
 *
 * Interne Komponenten:
 *   AiaPanel       — Root: State-Management, Lifecycle-Hooks
 *   HubView        — Kachel-Raster
 *   SurveyRunner   — Wiederverwendbarer SurveyJS-Wrapper
 *
 * choicesByUrl-Hinweis: SurveyJS sendet `choicesByUrl`-Requests ohne
 * `credentials: "include"`. Daher werden Choices manuell per
 * `loadStammdatenChoices` geladen und über `question.choices` injiziert.
 */

// SurveyJS CSS — DefaultV2-Theme
import "survey-core/survey-core.css";
// Dark-Theme-Overrides, gemappt auf --bim-ui_*-Tokens der Haupt-App
import "./survey-theme.css";
// Panel-eigene Layout- und Badge-Klassen
import "./panel.css";

import { useCallback, useEffect, useRef, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";

import {
  projectContext,
  onProjectLoaded,
} from "@thatopen4d/plugin-sdk/host";
import {
  appIcons,
  ModulePanel,
  ModulePanelHeader,
  ModulePanelBody,
  ModulePanelButton,
} from "@thatopen4d/plugin-sdk/ui";
import type { ReactPanelProps } from "@thatopen4d/plugin-sdk/registry";

import type {
  AiaSurvey,
  AiaResponse,
  AiaStammdatenEntry,
  TeamIsoRole,
} from "@thatopen4d/plugin-sdk/shared";
import {
  loadUserProfileSurvey,
  loadStammdatenChoices,
  loadProjectTradesSurvey,
  loadProjectProfileSurvey,
  loadProjectTeamsSurvey,
  loadProjectPhasesMilestonesSurvey,
  loadProjectLodLoiSurvey,
  loadProjectAssetTypesSurvey,
  loadProjectSoftwaresSurvey,
  loadProjectObjectivesSurvey,
  loadProjectBimUsesSurvey,
  loadTwinClassLoinSurvey,
  loadLoinResponses,
  listSurveys,
  listTwinClasses,
  loadTeams,
  extractTradeLock,
  isProjectManagerRole,
  createStammdatenEntry,
  upsertResponse,
  type StammdatenChoices,
  type ProjectTradeLock,
  type UserProfileSurveyData,
  type ProjectTradesSurveyData,
  type ProjectProfileSurveyData,
  type ProjectTeamsSurveyData,
  type ProjectPhasesMilestonesSurveyData,
  type ProjectLodLoiSurveyData,
  type ProjectAssetTypesSurveyData,
  type ProjectSoftwaresSurveyData,
  type ProjectObjectivesSurveyData,
  type ProjectBimUsesSurveyData,
  type TwinClassLoinSurveyData,
  type TwinClassRow,
} from "./service";
import { buildUserProfilePrefill } from "./prefill/user-context";
import { DeliverablesView } from "./views/deliverables-view";
import { StandardsView } from "./views/standards-view";

// ─── ISO-19650-Rollen-Labels ─────────────────────────────────────────────────

const ISO_ROLE_LABELS: Record<TeamIsoRole, string> = {
  "appointing-party": "Auftraggeber",
  "lead-appointed-party": "Generalplaner",
  "appointed-party": "Fachplaner",
};

// ─── Hilfsfunktion: ID → Label ───────────────────────────────────────────────

/**
 * Löst eine Stammdaten-ID (UUID) gegen die geladenen Choices auf
 * und liefert das `de`-Label (Fallback: erstes verfügbares Label).
 * Leerer String wenn nicht gefunden.
 */
function resolveLabel(
  entries: AiaStammdatenEntry[],
  id: string | undefined,
): string {
  if (!id) return "";
  const entry = entries.find((e) => e.id === id);
  if (!entry) return "";
  return entry.labels["de"] ?? Object.values(entry.labels)[0] ?? "";
}

// ─── Helfer — Stammdaten-Choices in Survey-Question injizieren ───────────────

/**
 * Überschreibt die `choices` einer Dropdown-Frage mit den geladenen
 * Stammdaten-Einträgen. Choices kommen via Auth-aware `apiFetch`.
 *
 * Bevorzugt das `de`-Label; Fallback auf erstes verfügbares Label.
 */
function injectChoices(
  survey: Model,
  questionName: string,
  entries: AiaStammdatenEntry[],
): void {
  const question = survey.getQuestionByName(questionName);
  if (!question) return;

  question.choices = entries.map((e) => ({
    value: e.id,
    text: e.labels["de"] ?? Object.values(e.labels)[0] ?? e.id,
  }));
}

// ─── Formatierungs-Helfer für LOIN-Column-Choices ────────────────────────────

/**
 * Formatiert einen Milestone-Eintrag als Dropdown-Label. Fallback: code
 * oder name, wenn vorhanden. Beispiel: "M1 · Entwurf-Abschluss".
 */
function formatMilestoneOption(m: Record<string, unknown>): string {
  const code = (m["code"] as string | undefined)?.trim();
  const name = (m["name"] as string | undefined)?.trim();
  if (code && name) return `${code} · ${name}`;
  return name ?? code ?? "—";
}

/**
 * Formatiert eine LOD- oder LOI-Katalog-Zeile als Dropdown-Label.
 * Beispiel: "300 · Präzise Modellierung".
 */
function formatLodLoiOption(l: Record<string, unknown>): string {
  const code = (l["code"] as string | undefined)?.trim();
  const label = (l["label"] as string | undefined)?.trim();
  if (code && label) return `${code} · ${label}`;
  return label ?? code ?? "—";
}

// ─── Badge-Klassen ───────────────────────────────────────────────────────────

/**
 * Liefert die className-Kombi für ein Status-Badge. Basis-Styling + Variant
 * liegen in `panel.css`.
 */
function badgeClass(
  variant: "success" | "neutral" | "warning" | "locked",
): string {
  return `aia-badge aia-badge--${variant}`;
}

// ─── Gespeicherter-Profil-Zusammenfassung (in Hub-Kachel) ────────────────────

interface ProfileSummaryProps {
  currentAnswers: Record<string, unknown>;
  choices: StammdatenChoices;
  tradeLock: ProjectTradeLock;
}

function ProfileSummary({
  currentAnswers,
  choices,
  tradeLock,
}: ProfileSummaryProps) {
  const roleLabel = resolveLabel(
    choices.roles,
    currentAnswers["projectRole"] as string | undefined,
  );
  const bimRoleLabel = resolveLabel(
    choices.bimRoles,
    currentAnswers["bimRole"] as string | undefined,
  );
  const tradeValues = Array.isArray(currentAnswers["trade"])
    ? (currentAnswers["trade"] as string[])
    : [];

  return (
    <dl className="aia-landing-dl">
      <dt className="aia-landing-dt">Anzeigename</dt>
      <dd className="aia-landing-dd">
        {(currentAnswers["displayName"] as string | undefined) ?? "—"}
      </dd>
      <dt className="aia-landing-dt">E-Mail</dt>
      <dd className="aia-landing-dd">
        {(currentAnswers["email"] as string | undefined) ?? "—"}
      </dd>
      <dt className="aia-landing-dt">Projektrolle</dt>
      <dd className="aia-landing-dd">{roleLabel || "—"}</dd>
      <dt className="aia-landing-dt">BIM-Rolle</dt>
      <dd className="aia-landing-dd">{bimRoleLabel || "—"}</dd>
      <dt className="aia-landing-dt">Gewerk</dt>
      <dd className="aia-landing-dd">
        {tradeValues.length > 0
          ? tradeValues.map((id, i) => {
              // Grayed-out für historische Gewerke, die nicht mehr in allowedTrades sind
              const label = resolveLabel(choices.trades, id) || id;
              const isOutdated =
                tradeLock.locked &&
                tradeLock.allowedTradeIds.length > 0 &&
                !tradeLock.allowedTradeIds.includes(id);
              return (
                <span key={id}>
                  {i > 0 && ", "}
                  {isOutdated ? (
                    <span
                      style={{ opacity: 0.4, textDecoration: "line-through" }}
                      title="Nicht mehr in der Projekt-Liste"
                    >
                      {label}
                    </span>
                  ) : (
                    label
                  )}
                </span>
              );
            })
          : "—"}
      </dd>
    </dl>
  );
}

// ─── Hub-View — Akkordion nach ISO-19650-Sektionen ───────────────────────────

interface HubViewProps {
  userAnswers: Record<string, unknown> | null;
  projectProfileAnswers: Record<string, unknown> | null;
  choices: StammdatenChoices;
  tradeLock: ProjectTradeLock;
  projectTradesResponse: AiaResponse | null;
  teams: AiaStammdatenEntry[];
  assetTypes: AiaStammdatenEntry[];
  softwares: AiaStammdatenEntry[];
  phasesMilestonesAnswers: Record<string, unknown> | null;
  lodLoiAnswers: Record<string, unknown> | null;
  objectivesAnswers: Record<string, unknown> | null;
  bimUsesAnswers: Record<string, unknown> | null;
  twinClasses: TwinClassRow[];
  loinResponses: AiaResponse[];
  isManager: boolean;
  onSelectSurvey: (key: RunnableSurveyKey) => void;
  onOpenLoinMatrix: () => void;
  onOpenDeliverables: () => void;
  onOpenStandards: () => void;
}

/**
 * Hub rendert 4 Akkordion-Sektionen nach ISO 19650:
 *   Ich / Projekt / Wer / Was / Wann
 *
 * Nach Sprint 3 enthalten alle fünf Sektionen produktive Kacheln:
 * Ich → Profil; Projekt → Projekt-Profil; Wer → Teams + Software + Gewerke;
 * Was → Asset-Types + Objectives + BIM-Uses + LOD/LOI + LOIN + Standards;
 * Wann → Phasen/Milestones + Deliverables.
 */
function HubView({
  userAnswers,
  projectProfileAnswers,
  choices,
  tradeLock,
  projectTradesResponse,
  teams,
  assetTypes,
  softwares,
  phasesMilestonesAnswers,
  lodLoiAnswers,
  objectivesAnswers,
  bimUsesAnswers,
  twinClasses,
  loinResponses,
  isManager,
  onSelectSurvey,
  onOpenLoinMatrix,
  onOpenDeliverables,
  onOpenStandards,
}: HubViewProps) {
  const profileCompleted = Boolean(userAnswers);
  const tradesCompleted = Boolean(projectTradesResponse?.completed);
  const tradesLocked = tradeLock.locked && tradesCompleted;
  const projectProfileCompleted = Boolean(projectProfileAnswers);
  const teamsCount = teams.length;
  const assetTypesCount = assetTypes.length;
  const softwaresCount = softwares.length;
  const phasesMilestonesCompleted = Boolean(phasesMilestonesAnswers);
  const lodLoiCompleted = Boolean(lodLoiAnswers);
  const objectivesCompleted = Boolean(objectivesAnswers);
  const bimUsesCompleted = Boolean(bimUsesAnswers);
  const milestonesCount = Array.isArray(phasesMilestonesAnswers?.["milestones"])
    ? (phasesMilestonesAnswers?.["milestones"] as unknown[]).length
    : 0;
  const lodCount = Array.isArray(lodLoiAnswers?.["lods"])
    ? (lodLoiAnswers?.["lods"] as unknown[]).length
    : 0;
  const loiCount = Array.isArray(lodLoiAnswers?.["lois"])
    ? (lodLoiAnswers?.["lois"] as unknown[]).length
    : 0;
  const objectivesCount = Array.isArray(objectivesAnswers?.["objectives"])
    ? (objectivesAnswers?.["objectives"] as unknown[]).length
    : 0;
  const bimUsesCount = Array.isArray(bimUsesAnswers?.["bimUses"])
    ? (bimUsesAnswers?.["bimUses"] as unknown[]).length
    : 0;
  const twinClassCount = twinClasses.length;
  const loinFilledCount = new Set(
    loinResponses.filter((r) => r.completed).map((r) => r.scopeId),
  ).size;

  return (
    <div className="aia-hub-wrapper">
      {/* ═══ Sektion: Ich ═══════════════════════════════════════════════ */}
      <HubSection title="Ich">
        <HubTile
          title="Dein Profil"
          description="Projektrolle, BIM-Rolle und Gewerk — für alle AIA-Auswertungen."
          badge={
            profileCompleted ? (
              <span className={badgeClass("success")}>Vollständig</span>
            ) : (
              <span className={badgeClass("neutral")}>
                Noch nicht ausgefüllt
              </span>
            )
          }
          onClick={() => onSelectSurvey("user-profile")}
        >
          {profileCompleted && userAnswers && (
            <ProfileSummary
              currentAnswers={userAnswers}
              choices={choices}
              tradeLock={tradeLock}
            />
          )}
        </HubTile>
      </HubSection>

      {/* ═══ Sektion: Projekt (Manager-only) ══════════════════════════ */}
      {isManager && (
        <HubSection title="Projekt">
          <HubTile
            title="Projekt-Profil"
            description="ISO-19650-Projektkopf: Code, Name, Kunde, Adresse, Kurzbeschreibung."
            badge={
              projectProfileCompleted ? (
                <span className={badgeClass("success")}>Gepflegt</span>
              ) : (
                <span className={badgeClass("warning")}>Offen</span>
              )
            }
            onClick={() => onSelectSurvey("project-profile")}
          >
            {projectProfileCompleted && projectProfileAnswers && (
              <ProjectProfileSummary answers={projectProfileAnswers} />
            )}
          </HubTile>
        </HubSection>
      )}

      {/* ═══ Sektion: Wer (Partizipanten, Manager-only) ═════════════ */}
      {isManager && (
        <HubSection title="Wer (Partizipanten)">
          <HubTile
            title="Teams"
            description="ISO-19650-Organisationen: Auftraggeber, Generalplaner, Fachplaner. Klick öffnet das Formular zum Hinzufügen eines neuen Teams."
            badge={
              teamsCount > 0 ? (
                <span className={badgeClass("success")}>
                  {teamsCount === 1 ? "1 Team" : `${teamsCount} Teams`}
                </span>
              ) : (
                <span className={badgeClass("warning")}>Noch leer</span>
              )
            }
            onClick={() => onSelectSurvey("project-teams")}
          >
            {teamsCount > 0 && <TeamsSummary teams={teams} choices={choices} />}
          </HubTile>
          <HubTile
            title="Projekt-Gewerke"
            description="Kuratierte Gewerke-Liste. Gesperrt: Nutzer können nur noch aus dieser Liste wählen."
            badge={
              tradesLocked ? (
                <span className={badgeClass("locked")}>Gesperrt</span>
              ) : tradesCompleted ? (
                <span className={badgeClass("success")}>Gepflegt</span>
              ) : (
                <span className={badgeClass("warning")}>Offen</span>
              )
            }
            onClick={() => onSelectSurvey("project-trades")}
          >
            {tradesCompleted && projectTradesResponse?.answers && (
              <TradesSummary
                answers={
                  projectTradesResponse.answers as Record<string, unknown>
                }
                choices={choices}
              />
            )}
          </HubTile>
          <HubTile
            title="Software"
            description="Autoren- und Review-Software, die im Projekt eingesetzt wird (Revit, Navisworks, …)."
            badge={
              softwaresCount > 0 ? (
                <span className={badgeClass("success")}>
                  {softwaresCount === 1
                    ? "1 Software"
                    : `${softwaresCount} Softwares`}
                </span>
              ) : (
                <span className={badgeClass("warning")}>Noch leer</span>
              )
            }
            onClick={() => onSelectSurvey("project-softwares")}
          >
            {softwaresCount > 0 && (
              <SoftwaresSummary softwares={softwares} assetTypes={assetTypes} />
            )}
          </HubTile>
        </HubSection>
      )}

      {/* ═══ Sektion: Was (Information, Manager-only) ═══════════════ */}
      {isManager && (
        <HubSection title="Was (Information)">
          <HubTile
            title="Asset-Types"
            description="Deliverable-Kategorien nach dotBEP — M3D (3D-Modell), RPT (Bericht), DWG (Zeichnung), …"
            badge={
              assetTypesCount > 0 ? (
                <span className={badgeClass("success")}>
                  {assetTypesCount === 1
                    ? "1 Asset-Type"
                    : `${assetTypesCount} Asset-Types`}
                </span>
              ) : (
                <span className={badgeClass("warning")}>Noch leer</span>
              )
            }
            onClick={() => onSelectSurvey("project-asset-types")}
          >
            {assetTypesCount > 0 && (
              <AssetTypesSummary assetTypes={assetTypes} />
            )}
          </HubTile>
          <HubTile
            title="Projektziele"
            description="Messbare Objectives mit optionaler Metrik und Zielwert."
            badge={
              objectivesCompleted ? (
                <span className={badgeClass("success")}>
                  {objectivesCount === 1
                    ? "1 Ziel"
                    : `${objectivesCount} Ziele`}
                </span>
              ) : (
                <span className={badgeClass("warning")}>Offen</span>
              )
            }
            onClick={() => onSelectSurvey("project-objectives")}
          >
            {objectivesCompleted && objectivesAnswers && (
              <ObjectivesSummary answers={objectivesAnswers} />
            )}
          </HubTile>
          <HubTile
            title="BIM-Anwendungsfälle"
            description="Use-Cases (Kollisionsprüfung, 4D, Mengenermittlung, …) mit Software- und Phasenzuordnung."
            badge={
              bimUsesCompleted ? (
                <span className={badgeClass("success")}>
                  {bimUsesCount === 1
                    ? "1 Use-Case"
                    : `${bimUsesCount} Use-Cases`}
                </span>
              ) : (
                <span className={badgeClass("warning")}>Offen</span>
              )
            }
            onClick={() => onSelectSurvey("project-bim-uses")}
          >
            {bimUsesCompleted && bimUsesAnswers && (
              <BimUsesSummary answers={bimUsesAnswers} softwares={softwares} />
            )}
          </HubTile>
          <HubTile
            title="LOD/LOI-Katalog"
            description="Geometrische (LOD) und alphanumerische (LOI) Detaillierungsstufen — Referenz für LOIN-Zuordnungen pro TwinClass (Sprint 2)."
            badge={
              lodLoiCompleted ? (
                <span className={badgeClass("success")}>
                  {lodCount} LOD · {loiCount} LOI
                </span>
              ) : (
                <span className={badgeClass("warning")}>Offen</span>
              )
            }
            onClick={() => onSelectSurvey("project-lod-loi")}
          >
            {lodLoiCompleted && lodLoiAnswers && (
              <LodLoiSummary answers={lodLoiAnswers} />
            )}
          </HubTile>
          <HubTile
            title="LOIN pro TwinClass"
            description="Informationsanforderungen pro TwinClass: welche Property, welche LOD/LOI, zu welchem Milestone? Die Matrix zeigt alle Projekt-Klassen mit Status."
            badge={
              twinClassCount === 0 ? (
                <span className={badgeClass("neutral")}>Keine Klassen</span>
              ) : loinFilledCount === 0 ? (
                <span className={badgeClass("warning")}>
                  0 / {twinClassCount}
                </span>
              ) : loinFilledCount === twinClassCount ? (
                <span className={badgeClass("success")}>
                  {loinFilledCount} / {twinClassCount}
                </span>
              ) : (
                <span className={badgeClass("warning")}>
                  {loinFilledCount} / {twinClassCount}
                </span>
              )
            }
            onClick={onOpenLoinMatrix}
          />
          <HubTile
            title="Standards"
            description="Markdown-Dokumente mit Projekt-Richtlinien — Modellierungsstandards, Nomenklatur-Konventionen, Qualitätskriterien."
            badge={<span className={badgeClass("neutral")}>Markdown</span>}
            onClick={onOpenStandards}
          />
        </HubSection>
      )}

      {/* ═══ Sektion: Wann (Schedule, Manager-only) ═════════════════ */}
      {isManager && (
        <HubSection title="Wann (Schedule)">
          <HubTile
            title="Phasen & Milestones"
            description="Aktive Projektphasen nach dotBEP-Konvention plus Milestones mit Datum und Kürzel."
            badge={
              phasesMilestonesCompleted ? (
                <span className={badgeClass("success")}>
                  {milestonesCount === 1
                    ? "1 Milestone"
                    : `${milestonesCount} Milestones`}
                </span>
              ) : (
                <span className={badgeClass("warning")}>Offen</span>
              )
            }
            onClick={() => onSelectSurvey("project-phases-milestones")}
          >
            {phasesMilestonesCompleted && phasesMilestonesAnswers && (
              <PhasesMilestonesSummary answers={phasesMilestonesAnswers} />
            )}
          </HubTile>
          <HubTile
            title="Deliverables"
            description="Projektweite Liste aller Lieferobjekte mit Disziplin-, Asset-Type-, Team- und Milestone-Zuordnung. Inklusive Nomenklatur-Generator."
            badge={<span className={badgeClass("neutral")}>Tabelle</span>}
            onClick={onOpenDeliverables}
          />
        </HubSection>
      )}
    </div>
  );
}

// ─── Sub-Komponenten für den Akkordion-Hub ───────────────────────────────────

function HubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="aia-hub-section">
      <h4 className="aia-hub-section-title">{title}</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {children}
      </div>
    </section>
  );
}

function HubTile({
  title,
  description,
  badge,
  onClick,
  children,
}: {
  title: string;
  description: string;
  badge: React.ReactNode;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="aia-hub-tile"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
    >
      <div className="aia-hub-tile-header">
        <span className="aia-hub-tile-title">{title}</span>
        {badge}
      </div>
      <p className="aia-hub-tile-desc">{description}</p>
      {children && <div style={{ marginTop: "0.5rem" }}>{children}</div>}
    </div>
  );
}

// ─── Kompakte Projekt-Profil-Zusammenfassung in der Hub-Kachel ───────────────

function ProjectProfileSummary({
  answers,
}: {
  answers: Record<string, unknown>;
}) {
  return (
    <dl className="aia-landing-dl aia-landing-dl--compact">
      <dt className="aia-landing-dt">Code</dt>
      <dd className="aia-landing-dd">
        {(answers["projectCode"] as string | undefined) ?? "—"}
      </dd>
      <dt className="aia-landing-dt">Name</dt>
      <dd className="aia-landing-dd">
        {(answers["projectName"] as string | undefined) ?? "—"}
      </dd>
      <dt className="aia-landing-dt">Auftraggeber</dt>
      <dd className="aia-landing-dd">
        {(answers["clientName"] as string | undefined) ?? "—"}
      </dd>
    </dl>
  );
}

// ─── Kurzübersicht Projekt-Gewerke in Kachel ─────────────────────────────────

interface TradesSummaryProps {
  answers: Record<string, unknown>;
  choices: StammdatenChoices;
}

function TradesSummary({ answers, choices }: TradesSummaryProps) {
  const allowedIds = Array.isArray(answers["allowedTrades"])
    ? (answers["allowedTrades"] as string[])
    : [];
  const labels = allowedIds
    .map((id) => resolveLabel(choices.trades, id) || id)
    .filter(Boolean);

  return (
    <dl className="aia-landing-dl aia-landing-dl--compact">
      <dt className="aia-landing-dt">Gewerke</dt>
      <dd className="aia-landing-dd">
        {labels.length > 0 ? labels.join(", ") : "—"}
      </dd>
      <dt className="aia-landing-dt">Gesperrt</dt>
      <dd className="aia-landing-dd">
        {answers["locked"] === true ? "Ja" : "Nein"}
      </dd>
    </dl>
  );
}

// ─── Teams-Zusammenfassung in Hub-Kachel ─────────────────────────────────────

interface TeamsSummaryProps {
  teams: AiaStammdatenEntry[];
  choices: StammdatenChoices;
}

/**
 * Kompakte Liste der angelegten Teams — pro Team: Code · Name · ISO-Rolle.
 * Disziplinen werden als kleine Sekundär-Zeile darunter gezeigt.
 */
function TeamsSummary({ teams, choices }: TeamsSummaryProps) {
  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "0.45rem",
        fontSize: "0.78rem",
      }}
    >
      {teams.map((team) => {
        const meta = (team.meta ?? {}) as {
          code?: string;
          isoRole?: TeamIsoRole;
          disciplineIds?: string[];
        };
        const name =
          team.labels["de"] ?? Object.values(team.labels)[0] ?? team.id;
        const isoLabel = meta.isoRole ? ISO_ROLE_LABELS[meta.isoRole] : "—";
        const disciplineLabels = Array.isArray(meta.disciplineIds)
          ? meta.disciplineIds
              .map((id) => resolveLabel(choices.trades, id))
              .filter((s): s is string => Boolean(s))
          : [];

        return (
          <li
            key={team.id}
            style={{
              padding: "0.4rem 0.6rem",
              background:
                "var(--bim-ui_bg-contrast-10, rgba(255,255,255,0.04))",
              borderRadius: "4px",
            }}
          >
            <div
              style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}
            >
              {meta.code && (
                <code
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    color: "var(--bim-ui_accent-base, #4a9eff)",
                  }}
                >
                  {meta.code}
                </code>
              )}
              <span
                style={{
                  fontWeight: 500,
                  color: "var(--bim-ui_bg-contrast-100, #fff)",
                }}
              >
                {name}
              </span>
              <span
                style={{
                  color: "var(--bim-ui_bg-contrast-60)",
                  fontSize: "0.72rem",
                }}
              >
                · {isoLabel}
              </span>
            </div>
            {disciplineLabels.length > 0 && (
              <div
                style={{
                  marginTop: "0.15rem",
                  fontSize: "0.72rem",
                  color: "var(--bim-ui_bg-contrast-60)",
                }}
              >
                {disciplineLabels.join(", ")}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── Asset-Types-Zusammenfassung in Hub-Kachel ───────────────────────────────

interface AssetTypesSummaryProps {
  assetTypes: AiaStammdatenEntry[];
}

function AssetTypesSummary({ assetTypes }: AssetTypesSummaryProps) {
  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexWrap: "wrap",
        gap: "0.35rem",
        fontSize: "0.78rem",
      }}
    >
      {assetTypes.map((at) => {
        const meta = (at.meta ?? {}) as {
          code?: string;
          allowedExtensions?: string[];
        };
        const label = at.labels["de"] ?? Object.values(at.labels)[0] ?? at.id;
        return (
          <li
            key={at.id}
            style={{
              padding: "0.25rem 0.5rem",
              background:
                "var(--bim-ui_bg-contrast-10, rgba(255,255,255,0.04))",
              borderRadius: "4px",
              display: "flex",
              gap: "0.35rem",
              alignItems: "baseline",
            }}
            title={
              meta.allowedExtensions && meta.allowedExtensions.length > 0
                ? meta.allowedExtensions.join(", ")
                : undefined
            }
          >
            {meta.code && (
              <code
                style={{
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  color: "var(--bim-ui_accent-base, #4a9eff)",
                }}
              >
                {meta.code}
              </code>
            )}
            <span>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Softwares-Zusammenfassung in Hub-Kachel ─────────────────────────────────

interface SoftwaresSummaryProps {
  softwares: AiaStammdatenEntry[];
  assetTypes: AiaStammdatenEntry[];
}

function SoftwaresSummary({ softwares, assetTypes }: SoftwaresSummaryProps) {
  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem",
        fontSize: "0.78rem",
      }}
    >
      {softwares.map((sw) => {
        const meta = (sw.meta ?? {}) as {
          version?: string;
          assetTypeIds?: string[];
        };
        const name = sw.labels["de"] ?? Object.values(sw.labels)[0] ?? sw.id;
        const assetTypeLabels = Array.isArray(meta.assetTypeIds)
          ? meta.assetTypeIds
              .map((id) => {
                const entry = assetTypes.find((a) => a.id === id);
                const code = (entry?.meta as { code?: string } | null)?.code;
                return code ?? entry?.labels["de"] ?? "";
              })
              .filter(Boolean)
          : [];
        return (
          <li
            key={sw.id}
            style={{
              padding: "0.3rem 0.55rem",
              background:
                "var(--bim-ui_bg-contrast-10, rgba(255,255,255,0.04))",
              borderRadius: "4px",
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              alignItems: "baseline",
            }}
          >
            <span style={{ fontWeight: 500 }}>{name}</span>
            {meta.version && (
              <span style={{ color: "var(--bim-ui_bg-contrast-60)" }}>
                v{meta.version}
              </span>
            )}
            {assetTypeLabels.length > 0 && (
              <span
                style={{
                  color: "var(--bim-ui_bg-contrast-60)",
                  fontSize: "0.72rem",
                }}
              >
                · {assetTypeLabels.join(", ")}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── Objectives-Zusammenfassung in Hub-Kachel ────────────────────────────────

function ObjectivesSummary({ answers }: { answers: Record<string, unknown> }) {
  const objectives = Array.isArray(answers["objectives"])
    ? (answers["objectives"] as Array<Record<string, unknown>>)
    : [];
  if (objectives.length === 0) {
    return <p className="aia-landing-dd aia-landing-dd--compact">—</p>;
  }

  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "0.3rem",
        fontSize: "0.78rem",
      }}
    >
      {objectives.map((o, i) => {
        const title = (o["title"] as string | undefined) ?? "—";
        const metric = (o["metric"] as string | undefined)?.trim();
        const target = (o["target"] as string | undefined)?.trim();
        const suffix = [metric, target].filter(Boolean).join(" = ");
        return (
          <li
            key={`obj-${i}`}
            style={{
              padding: "0.25rem 0.55rem",
              background:
                "var(--bim-ui_bg-contrast-10, rgba(255,255,255,0.04))",
              borderRadius: "4px",
            }}
          >
            <span style={{ fontWeight: 500 }}>{title}</span>
            {suffix && (
              <span
                style={{
                  marginLeft: "0.4rem",
                  color: "var(--bim-ui_bg-contrast-60)",
                  fontSize: "0.72rem",
                }}
              >
                · {suffix}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── BIM-Uses-Zusammenfassung in Hub-Kachel ──────────────────────────────────

interface BimUsesSummaryProps {
  answers: Record<string, unknown>;
  softwares: AiaStammdatenEntry[];
}

function BimUsesSummary({ answers, softwares }: BimUsesSummaryProps) {
  const bimUses = Array.isArray(answers["bimUses"])
    ? (answers["bimUses"] as Array<Record<string, unknown>>)
    : [];
  if (bimUses.length === 0) {
    return <p className="aia-landing-dd aia-landing-dd--compact">—</p>;
  }

  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "0.3rem",
        fontSize: "0.78rem",
      }}
    >
      {bimUses.map((u, i) => {
        const name = (u["name"] as string | undefined) ?? "—";
        const softwareIds = Array.isArray(u["softwareIds"])
          ? (u["softwareIds"] as string[])
          : [];
        const softwareLabels = softwareIds
          .map((id) => softwares.find((s) => s.id === id)?.labels["de"] ?? "")
          .filter(Boolean);
        const phaseIds = Array.isArray(u["phaseIds"])
          ? (u["phaseIds"] as string[])
          : [];
        const phaseLabels = phaseIds
          .map((p) => PHASE_LABELS[p] ?? p)
          .filter(Boolean);
        return (
          <li
            key={`use-${i}`}
            style={{
              padding: "0.3rem 0.55rem",
              background:
                "var(--bim-ui_bg-contrast-10, rgba(255,255,255,0.04))",
              borderRadius: "4px",
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              alignItems: "baseline",
            }}
          >
            <span style={{ fontWeight: 500 }}>{name}</span>
            {softwareLabels.length > 0 && (
              <span
                style={{
                  color: "var(--bim-ui_bg-contrast-60)",
                  fontSize: "0.72rem",
                }}
              >
                · {softwareLabels.join(", ")}
              </span>
            )}
            {phaseLabels.length > 0 && (
              <span
                style={{
                  color: "var(--bim-ui_bg-contrast-60)",
                  fontSize: "0.72rem",
                }}
              >
                · {phaseLabels.join(", ")}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── Phasen/Milestones-Zusammenfassung in Hub-Kachel ─────────────────────────

const PHASE_LABELS: Record<string, string> = {
  "pre-project": "Bedarfsplanung",
  conceptual: "Konzept",
  schematic: "Vorplanung",
  "design-development": "Entwurf",
  "construction-documentation": "Ausführungsplanung",
  construction: "Ausführung",
  handover: "Übergabe",
  operation: "Betrieb",
};

interface PhasesMilestonesSummaryProps {
  answers: Record<string, unknown>;
}

/**
 * Kompakte Liste der erfassten Milestones — pro Zeile: Kürzel · Bezeichnung
 * · Phase · Datum.
 */
function PhasesMilestonesSummary({ answers }: PhasesMilestonesSummaryProps) {
  const milestones = Array.isArray(answers["milestones"])
    ? (answers["milestones"] as Array<Record<string, unknown>>)
    : [];
  if (milestones.length === 0) {
    return <p className="aia-landing-dd aia-landing-dd--compact">—</p>;
  }

  return (
    <ul
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem",
        fontSize: "0.78rem",
      }}
    >
      {milestones.map((m, i) => {
        const code = (m["code"] as string | undefined) ?? "";
        const name = (m["name"] as string | undefined) ?? "—";
        const phase = (m["phase"] as string | undefined) ?? "";
        const date = (m["date"] as string | undefined) ?? "";
        const phaseLabel = PHASE_LABELS[phase] ?? phase;
        return (
          <li
            key={`${code}-${i}`}
            style={{
              padding: "0.3rem 0.55rem",
              background:
                "var(--bim-ui_bg-contrast-10, rgba(255,255,255,0.04))",
              borderRadius: "4px",
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              alignItems: "baseline",
            }}
          >
            {code && (
              <code
                style={{
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  color: "var(--bim-ui_accent-base, #4a9eff)",
                }}
              >
                {code}
              </code>
            )}
            <span style={{ fontWeight: 500 }}>{name}</span>
            {phaseLabel && (
              <span style={{ color: "var(--bim-ui_bg-contrast-60)" }}>
                · {phaseLabel}
              </span>
            )}
            {date && (
              <span style={{ color: "var(--bim-ui_bg-contrast-60)" }}>
                · {date}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── LOD/LOI-Zusammenfassung in Hub-Kachel ───────────────────────────────────

interface LodLoiSummaryProps {
  answers: Record<string, unknown>;
}

/**
 * Zeigt die erfassten LOD- und LOI-Codes nebeneinander als kompakten
 * Chip-Stream. Zwei Zeilen: "LOD: 100, 200, 300 · LOI: 1, 2, 3".
 */
function LodLoiSummary({ answers }: LodLoiSummaryProps) {
  const lods = Array.isArray(answers["lods"])
    ? (answers["lods"] as Array<Record<string, unknown>>)
    : [];
  const lois = Array.isArray(answers["lois"])
    ? (answers["lois"] as Array<Record<string, unknown>>)
    : [];
  const lodCodes = lods
    .map((l) => (l["code"] as string | undefined) ?? "")
    .filter(Boolean);
  const loiCodes = lois
    .map((l) => (l["code"] as string | undefined) ?? "")
    .filter(Boolean);

  return (
    <dl className="aia-landing-dl aia-landing-dl--compact">
      <dt className="aia-landing-dt">LOD</dt>
      <dd className="aia-landing-dd">
        {lodCodes.length > 0 ? lodCodes.join(", ") : "—"}
      </dd>
      <dt className="aia-landing-dt">LOI</dt>
      <dd className="aia-landing-dd">
        {loiCodes.length > 0 ? loiCodes.join(", ") : "—"}
      </dd>
    </dl>
  );
}

// ─── LoinMatrixView ──────────────────────────────────────────────────────────

interface LoinMatrixViewProps {
  twinClasses: TwinClassRow[];
  loinResponses: AiaResponse[];
  onOpen: (twinClass: TwinClassRow) => void;
  onBack: () => void;
}

/**
 * Zeigt eine Liste aller TwinClasses des Projekts mit LOIN-Status-Badge.
 * Klick auf eine Zeile öffnet den LOIN-SurveyRunner mit scopeId=class.id.
 * Die Anzahl gepflegter Zeilen pro Klasse steht im Badge.
 */
function LoinMatrixView({
  twinClasses,
  loinResponses,
  onOpen,
  onBack,
}: LoinMatrixViewProps) {
  // Map TwinClass-ID → Anzahl requirements in der zugehörigen Response
  const requirementsByClass = new Map<string, number>();
  for (const r of loinResponses) {
    if (!r.scopeId || !r.completed) continue;
    const reqs = Array.isArray(
      (r.answers as Record<string, unknown>)["requirements"],
    )
      ? ((r.answers as Record<string, unknown>)["requirements"] as unknown[])
      : [];
    requirementsByClass.set(r.scopeId, reqs.length);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.5rem 1rem",
          borderBottom: "1px solid var(--bim-ui_bg-contrast-20)",
          fontSize: "0.82rem",
          color: "var(--bim-ui_bg-contrast-60)",
          cursor: "pointer",
          userSelect: "none",
        }}
        role="button"
        tabIndex={0}
        onClick={onBack}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onBack();
        }}
        title="Zurück zur Übersicht"
      >
        ← LOIN pro TwinClass
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "1rem 1.25rem" }}>
        {twinClasses.length === 0 ? (
          <div className="aia-empty-state">
            Keine TwinClasses im Projekt angelegt.
            <br />
            <span style={{ fontSize: "0.72rem", opacity: 0.7 }}>
              Klassen werden aus IFC-Imports oder manuell im Klassifikations-
              Panel angelegt.
            </span>
          </div>
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
            }}
          >
            {twinClasses.map((cls) => {
              const count = requirementsByClass.get(cls.id) ?? 0;
              const filled = count > 0;
              return (
                <li
                  key={cls.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(cls)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onOpen(cls);
                  }}
                  style={{
                    padding: "0.6rem 0.9rem",
                    background:
                      "var(--bim-ui_bg-contrast-5, rgba(255,255,255,0.05))",
                    border: "1px solid var(--bim-ui_bg-contrast-20)",
                    borderRadius: "6px",
                    cursor: "pointer",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.75rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.15rem",
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "baseline",
                      }}
                    >
                      <code
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          color: "var(--bim-ui_accent-base, #4a9eff)",
                        }}
                      >
                        {cls.code}
                      </code>
                      <span
                        style={{
                          fontWeight: 500,
                          color: "var(--bim-ui_bg-contrast-100, #fff)",
                          fontSize: "0.88rem",
                        }}
                      >
                        {cls.label ?? cls.code}
                      </span>
                    </div>
                    {(cls.bsddRef || cls.uniclass) && (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--bim-ui_bg-contrast-60)",
                        }}
                      >
                        {[cls.bsddRef, cls.uniclass]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                  <span className={badgeClass(filled ? "success" : "warning")}>
                    {filled
                      ? `${count} ${count === 1 ? "Anforderung" : "Anforderungen"}`
                      : "Offen"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── SurveyRunner ─────────────────────────────────────────────────────────────

type RunnableSurveyKey =
  | "user-profile"
  | "project-trades"
  | "project-profile"
  | "project-teams"
  | "project-phases-milestones"
  | "project-lod-loi"
  | "project-asset-types"
  | "project-softwares"
  | "project-objectives"
  | "project-bim-uses"
  | "twinclass-loin";

interface SurveyRunnerProps {
  projectId: string;
  surveyKey: RunnableSurveyKey;
  survey: AiaSurvey;
  existingResponse: AiaResponse | null;
  choices: StammdatenChoices;
  tradeLock: ProjectTradeLock;
  onSaved: (answers: Record<string, unknown>) => void;
  onBack: () => void;
  /** LOIN-Scope-ID (TwinClass-UUID). Pflicht bei surveyKey === "twinclass-loin". */
  scopeId?: string;
  /** TwinClass-Info für LOIN-Header (Titel, Code). */
  loinClass?: TwinClassRow;
  /**
   * Kontext für die LOIN-Survey-Column-Injection. Nur relevant bei
   * surveyKey === "twinclass-loin"; andere Keys ignorieren diese Felder.
   */
  loinContext?: {
    milestones: Array<Record<string, unknown>>;
    lods: Array<Record<string, unknown>>;
    lois: Array<Record<string, unknown>>;
    teams: AiaStammdatenEntry[];
  };
}

/**
 * Wiederverwendbarer SurveyJS-Wrapper.
 * Baut die Model-Instanz einmalig auf, injiziert Choices und
 * registriert den onComplete-Handler (inkl. "Andere"-Stammdaten-Logik).
 */
function SurveyRunner({
  projectId,
  surveyKey,
  survey,
  existingResponse,
  choices,
  tradeLock,
  onSaved,
  onBack,
  scopeId,
  loinClass,
  loinContext,
}: SurveyRunnerProps) {
  // Model wird nur einmal gebaut — kein Re-Build bei Props-Änderungen
  const modelRef = useRef<Model | null>(null);
  const [modelReady, setModelReady] = useState(false);

  useEffect(() => {
    const model = new Model(survey.definition);
    model.locale = "de";
    // completedPage unterdrücken — wir zeigen nach Save den Hub
    model.showCompletedPage = false;

    if (surveyKey === "user-profile") {
      // Choices injizieren
      injectChoices(model, "projectRole", choices.roles);
      injectChoices(model, "bimRole", choices.bimRoles);

      if (tradeLock.locked && tradeLock.allowedTradeIds.length > 0) {
        // Nur kuratierte Gewerke anbieten
        const allowedEntries = choices.trades.filter((e) =>
          tradeLock.allowedTradeIds.includes(e.id),
        );
        injectChoices(model, "trade", allowedEntries);
        // "Andere"-Freitext ausblenden
        const tradeQuestion = model.getQuestionByName("trade");
        if (tradeQuestion) {
          tradeQuestion.showOtherItem = false;
        }
      } else {
        injectChoices(model, "trade", choices.trades);
      }

      // Bestehende Antwort oder Prefill setzen
      const initialAnswers = (existingResponse?.answers ??
        buildUserProfilePrefill()) as Record<string, unknown>;
      model.data = initialAnswers;

      // onComplete: "Andere"-Stammdaten anlegen + persistieren
      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;

        // Projektrolle — "other" → neuen Stammdaten-Eintrag anlegen
        if (answers["projectRole"] === "other") {
          const freitext = answers["projectRole-Comment"] as string | undefined;
          if (freitext?.trim()) {
            try {
              const newEntry = await createStammdatenEntry(projectId, {
                type: "role",
                labels: { de: freitext.trim() },
              });
              answers["projectRole"] = newEntry.id;
              delete answers["projectRole-Comment"];
            } catch (err) {
              console.debug(
                "[aia/panel] createStammdatenEntry (role) fehlgeschlagen:",
                err,
              );
            }
          }
        }

        // BIM-Rolle — analog
        if (answers["bimRole"] === "other") {
          const freitext = answers["bimRole-Comment"] as string | undefined;
          if (freitext?.trim()) {
            try {
              const newEntry = await createStammdatenEntry(projectId, {
                type: "bimRole",
                labels: { de: freitext.trim() },
              });
              answers["bimRole"] = newEntry.id;
              delete answers["bimRole-Comment"];
            } catch (err) {
              console.debug(
                "[aia/panel] createStammdatenEntry (bimRole) fehlgeschlagen:",
                err,
              );
            }
          }
        }

        // Gewerk — "other" als Tag im Tagbox-Array, nur wenn nicht gesperrt
        const tradeValue = answers["trade"];
        if (
          !tradeLock.locked &&
          Array.isArray(tradeValue) &&
          tradeValue.includes("other")
        ) {
          const freitext = (
            answers["trade-Comment"] as string | undefined
          )?.trim();
          if (freitext) {
            try {
              const newEntry = await createStammdatenEntry(projectId, {
                type: "trade",
                labels: { de: freitext },
              });
              answers["trade"] = tradeValue.map((v) =>
                v === "other" ? newEntry.id : v,
              );
              delete answers["trade-Comment"];
            } catch (err) {
              console.debug(
                "[aia/panel] createStammdatenEntry (trade) fehlgeschlagen:",
                err,
              );
            }
          }
        }

        try {
          await upsertResponse(projectId, {
            surveyKey: "user-profile",
            scope: "user",
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (user-profile) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-trades") {
      // project-trades: alle Gewerke verfügbar
      injectChoices(model, "allowedTrades", choices.trades);

      const initialAnswers = (existingResponse?.answers ?? {}) as Record<
        string,
        unknown
      >;
      model.data = initialAnswers;

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        try {
          await upsertResponse(projectId, {
            surveyKey: "project-trades",
            scope: "project",
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (project-trades) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-profile") {
      // project-profile: reine Textfelder, keine Stammdaten-Choices,
      // kein "Andere"-Handling.
      const initialAnswers = (existingResponse?.answers ?? {}) as Record<
        string,
        unknown
      >;
      model.data = initialAnswers;

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        try {
          await upsertResponse(projectId, {
            surveyKey: "project-profile",
            scope: "project",
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (project-profile) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-teams") {
      // project-teams: Single-Team-Form — jeder Submit legt einen neuen
      // aiaStammdaten-Eintrag vom Typ "team" an. Keine Response persistiert.
      // disciplineIds-Tagbox mit kuratierten/allen Gewerken befüllen.
      const tradeEntries =
        tradeLock.locked && tradeLock.allowedTradeIds.length > 0
          ? choices.trades.filter((e) =>
              tradeLock.allowedTradeIds.includes(e.id),
            )
          : choices.trades;
      injectChoices(model, "disciplineIds", tradeEntries);

      // Kein Prefill — Form startet leer für neues Team
      model.data = {};

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        const name = (answers["name"] as string | undefined)?.trim();
        const code = (answers["code"] as string | undefined)?.trim();
        const isoRole = answers["isoRole"] as TeamIsoRole | undefined;
        const disciplineIds = Array.isArray(answers["disciplineIds"])
          ? (answers["disciplineIds"] as string[])
          : [];
        const representativeEmailRaw = (
          answers["representativeEmail"] as string | undefined
        )?.trim();

        if (!name || !code || !isoRole) {
          console.debug("[aia/panel] project-teams: Pflichtfelder fehlen");
          return;
        }

        const meta: Record<string, unknown> = {
          code,
          isoRole,
          disciplineIds,
        };
        if (representativeEmailRaw) {
          meta["representativeEmail"] = representativeEmailRaw;
        }

        try {
          await createStammdatenEntry(projectId, {
            type: "team",
            labels: { de: name },
            meta,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] createStammdatenEntry (team) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-phases-milestones") {
      // project-phases-milestones: matrixdynamic + checkbox, reine
      // Response-Persistenz. Kein Stammdaten-Handling.
      const initialAnswers = (existingResponse?.answers ?? {}) as Record<
        string,
        unknown
      >;
      model.data = initialAnswers;

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        try {
          await upsertResponse(projectId, {
            surveyKey: "project-phases-milestones",
            scope: "project",
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (project-phases-milestones) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-lod-loi") {
      // project-lod-loi: zwei matrixdynamic-Blöcke, reine Response-Persistenz.
      const initialAnswers = (existingResponse?.answers ?? {}) as Record<
        string,
        unknown
      >;
      model.data = initialAnswers;

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        try {
          await upsertResponse(projectId, {
            surveyKey: "project-lod-loi",
            scope: "project",
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (project-lod-loi) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-asset-types") {
      // project-asset-types: Single-Entry-Form — jeder Submit legt einen
      // neuen aiaStammdaten-Eintrag vom Typ "assetType" an.
      model.data = {};

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        const label = (answers["label"] as string | undefined)?.trim();
        const code = (answers["code"] as string | undefined)?.trim();
        const allowedExtensionsRaw = (
          answers["allowedExtensions"] as string | undefined
        )?.trim();
        const description = (
          answers["description"] as string | undefined
        )?.trim();

        if (!label || !code) {
          console.debug(
            "[aia/panel] project-asset-types: Pflichtfelder fehlen",
          );
          return;
        }

        // Komma-separierte Liste ".ifc, .rvt" → ["ifc", "rvt"]-Array mit Punkt
        const allowedExtensions = allowedExtensionsRaw
          ? allowedExtensionsRaw
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter((s) => /^\.[a-z0-9]+$/.test(s))
          : [];

        const meta: Record<string, unknown> = { code, allowedExtensions };
        if (description) meta["description"] = description;

        try {
          await createStammdatenEntry(projectId, {
            type: "assetType",
            labels: { de: label },
            meta,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] createStammdatenEntry (assetType) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-softwares") {
      // project-softwares: Single-Entry-Form — jeder Submit legt einen neuen
      // aiaStammdaten-Eintrag vom Typ "software" an. assetTypeIds-Tagbox mit
      // Projekt-Asset-Types injizieren.
      injectChoices(model, "assetTypeIds", choices.assetTypes);

      model.data = {};

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        const name = (answers["name"] as string | undefined)?.trim();
        const version = (answers["version"] as string | undefined)?.trim();
        const assetTypeIds = Array.isArray(answers["assetTypeIds"])
          ? (answers["assetTypeIds"] as string[])
          : [];

        if (!name) {
          console.debug("[aia/panel] project-softwares: Name fehlt");
          return;
        }

        const meta: Record<string, unknown> = { assetTypeIds };
        if (version) meta["version"] = version;

        try {
          await createStammdatenEntry(projectId, {
            type: "software",
            labels: { de: name },
            meta,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] createStammdatenEntry (software) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-objectives") {
      // project-objectives: matrixdynamic — reine Response-Persistenz.
      const initialAnswers = (existingResponse?.answers ?? {}) as Record<
        string,
        unknown
      >;
      model.data = initialAnswers;

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        try {
          await upsertResponse(projectId, {
            surveyKey: "project-objectives",
            scope: "project",
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (project-objectives) fehlgeschlagen:",
            err,
          );
        }
      });
    } else if (surveyKey === "project-bim-uses") {
      // project-bim-uses: matrixdynamic mit tagbox-Column softwareIds.
      // Tagbox-Choices pro Column setzen wir nach der Model-Erstellung,
      // weil SurveyJS sie sonst leer rendert.
      const bimUsesQuestion = model.getQuestionByName("bimUses") as
        | { columns?: Array<{ name: string; choices?: unknown }> }
        | undefined;
      const softwareColumn = bimUsesQuestion?.columns?.find(
        (c) => c.name === "softwareIds",
      );
      if (softwareColumn) {
        softwareColumn.choices = choices.softwares.map((s) => ({
          value: s.id,
          text: s.labels["de"] ?? Object.values(s.labels)[0] ?? s.id,
        }));
      }

      const initialAnswers = (existingResponse?.answers ?? {}) as Record<
        string,
        unknown
      >;
      model.data = initialAnswers;

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        try {
          await upsertResponse(projectId, {
            surveyKey: "project-bim-uses",
            scope: "project",
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (project-bim-uses) fehlgeschlagen:",
            err,
          );
        }
      });
    } else {
      // twinclass-loin: scope="twinClass" mit scopeId=twinClass.id. Dynamische
      // Column-Injection aus den Projekt-Sprint-1-Responses (Milestones, LOD-
      // Codes, LOI-Codes) und den Team-Stammdaten.
      const requirementsQuestion = model.getQuestionByName("requirements") as
        | { columns?: Array<{ name: string; choices?: unknown }> }
        | undefined;
      const milestoneColumn = requirementsQuestion?.columns?.find(
        (c) => c.name === "milestone",
      );
      const lodColumn = requirementsQuestion?.columns?.find(
        (c) => c.name === "lodCode",
      );
      const loiColumn = requirementsQuestion?.columns?.find(
        (c) => c.name === "loiCode",
      );
      const teamColumn = requirementsQuestion?.columns?.find(
        (c) => c.name === "responsibleTeamId",
      );

      if (loinContext) {
        if (milestoneColumn) {
          milestoneColumn.choices = loinContext.milestones.map((m) => ({
            value: (m["code"] as string | undefined) ?? "",
            text: formatMilestoneOption(m),
          }));
        }
        if (lodColumn) {
          lodColumn.choices = loinContext.lods.map((l) => ({
            value: (l["code"] as string | undefined) ?? "",
            text: formatLodLoiOption(l),
          }));
        }
        if (loiColumn) {
          loiColumn.choices = loinContext.lois.map((l) => ({
            value: (l["code"] as string | undefined) ?? "",
            text: formatLodLoiOption(l),
          }));
        }
        if (teamColumn) {
          teamColumn.choices = loinContext.teams.map((t) => {
            const meta = (t.meta ?? {}) as { code?: string };
            const name = t.labels["de"] ?? Object.values(t.labels)[0] ?? t.id;
            return {
              value: t.id,
              text: meta.code ? `${meta.code} · ${name}` : name,
            };
          });
        }
      }

      const initialAnswers = (existingResponse?.answers ?? {}) as Record<
        string,
        unknown
      >;
      model.data = initialAnswers;

      model.onComplete.add(async (sender) => {
        const answers = { ...sender.data } as Record<string, unknown>;
        if (!scopeId) {
          console.debug("[aia/panel] twinclass-loin: scopeId fehlt — Abbruch");
          return;
        }
        try {
          await upsertResponse(projectId, {
            surveyKey: "twinclass-loin",
            scope: "twinClass",
            scopeId,
            answers,
            completed: true,
          });
          onSaved(answers);
          onBack();
        } catch (err) {
          console.debug(
            "[aia/panel] upsertResponse (twinclass-loin) fehlgeschlagen:",
            err,
          );
        }
      });
    }

    modelRef.current = model;
    setModelReady(true);

    // Cleanup: beim Unmount kein expliziter Dispose nötig (SurveyJS-Model ist
    // GC-fähig; kein DOM-Attachment außerhalb der React-Tree).
    return () => {
      modelRef.current = null;
    };
    // Absichtlich leere Deps: Model wird nur beim ersten Mount gebaut.
    // Projektwechsel löst im Parent einen kompletten Remount aus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!modelReady || !modelRef.current) return null;

  const titleMap: Record<RunnableSurveyKey, string> = {
    "user-profile": "Dein Profil",
    "project-trades": "Projekt-Gewerke",
    "project-profile": "Projekt-Profil",
    "project-teams": "Team hinzufügen",
    "project-phases-milestones": "Phasen & Milestones",
    "project-lod-loi": "LOD/LOI-Katalog",
    "project-asset-types": "Asset-Type hinzufügen",
    "project-softwares": "Software hinzufügen",
    "project-objectives": "Projektziele",
    "project-bim-uses": "BIM-Anwendungsfälle",
    "twinclass-loin": "LOIN-Anforderungen",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Zurück-Leiste */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.5rem 1rem",
          borderBottom: "1px solid var(--bim-ui_bg-contrast-20)",
          fontSize: "0.82rem",
          color: "var(--bim-ui_bg-contrast-60)",
          cursor: "pointer",
          userSelect: "none",
        }}
        role="button"
        tabIndex={0}
        onClick={onBack}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onBack();
        }}
        title={
          surveyKey === "twinclass-loin" && loinClass
            ? "Zurück zur LOIN-Matrix"
            : "Zurück zur Übersicht"
        }
      >
        ← {titleMap[surveyKey]}
        {surveyKey === "twinclass-loin" && loinClass && (
          <span
            style={{
              marginLeft: "0.5rem",
              color: "var(--bim-ui_bg-contrast-100, #fff)",
              fontWeight: 500,
            }}
          >
            · {loinClass.code} {loinClass.label && `— ${loinClass.label}`}
          </span>
        )}
      </div>
      <div
        className="module-aia-survey-host"
        style={{ flex: 1, overflow: "auto" }}
      >
        <Survey model={modelRef.current} />
      </div>
    </div>
  );
}

// ─── Gesamter Panel-State ─────────────────────────────────────────────────────

interface HubData {
  choices: StammdatenChoices;
  tradeLock: ProjectTradeLock;
  userProfileData: UserProfileSurveyData;
  projectTradesData: ProjectTradesSurveyData;
  projectProfileData: ProjectProfileSurveyData;
  projectTeamsData: ProjectTeamsSurveyData;
  projectPhasesMilestonesData: ProjectPhasesMilestonesSurveyData;
  projectLodLoiData: ProjectLodLoiSurveyData;
  projectAssetTypesData: ProjectAssetTypesSurveyData;
  projectSoftwaresData: ProjectSoftwaresSurveyData;
  projectObjectivesData: ProjectObjectivesSurveyData;
  projectBimUsesData: ProjectBimUsesSurveyData;
  twinClassLoinData: TwinClassLoinSurveyData;
  /** Aktuelle (zuletzt gespeicherte) User-Profil-Antworten. */
  userAnswers: Record<string, unknown> | null;
  /** Aktuelle (zuletzt gespeicherte) Projekt-Profil-Antworten. */
  projectProfileAnswers: Record<string, unknown> | null;
  /** Aktuell angelegte Teams (source = "user", type = "team"). */
  teams: AiaStammdatenEntry[];
  /** Aktuelle Asset-Types (Defaults + projekt-spezifisch). */
  assetTypes: AiaStammdatenEntry[];
  /** Aktuelle Softwares (projekt-spezifisch). */
  softwares: AiaStammdatenEntry[];
  /** Aktuelle (zuletzt gespeicherte) Phasen/Milestones-Antworten. */
  phasesMilestonesAnswers: Record<string, unknown> | null;
  /** Aktuelle (zuletzt gespeicherte) LOD/LOI-Katalog-Antworten. */
  lodLoiAnswers: Record<string, unknown> | null;
  /** Aktuelle (zuletzt gespeicherte) Projekt-Objectives-Antworten. */
  objectivesAnswers: Record<string, unknown> | null;
  /** Aktuelle (zuletzt gespeicherte) BIM-Uses-Antworten. */
  bimUsesAnswers: Record<string, unknown> | null;
  /** Alle TwinClasses des Projekts (für LoinMatrixView). */
  twinClasses: TwinClassRow[];
  /** Alle LOIN-Responses (scope="twinClass"). Key im LoinMatrixView: r.scopeId. */
  loinResponses: AiaResponse[];
}

// ─── View-Discriminated-Union ────────────────────────────────────────────────

/**
 * Aktiver Panel-View. Ersetzt fünf unabhängige Boolean-/null-Flags durch eine
 * diskriminierte Union — macht unmögliche Zustände (z. B. Matrix + Standards
 * gleichzeitig an) unrepräsentierbar.
 *
 * `survey` mit `key === "twinclass-loin"` trägt zusätzlich den TwinClass-Scope.
 * Für diesen speziellen Fall führt der Zurück-Button zurück zur LOIN-Matrix
 * (siehe `handleBack`), nicht zum Hub.
 */
type AiaView =
  | { kind: "hub" }
  | { kind: "survey"; key: RunnableSurveyKey; twinClass?: TwinClassRow }
  | { kind: "loin-matrix" }
  | { kind: "deliverables" }
  | { kind: "standards" };

const HUB_VIEW: AiaView = { kind: "hub" };

// ─── Root-Komponente ─────────────────────────────────────────────────────────

export function AiaPanel(_props: ReactPanelProps) {
  const [projectId, setProjectId] = useState<string>(
    projectContext.activeProjectId ?? "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hubData, setHubData] = useState<HubData | null>(null);
  const [view, setView] = useState<AiaView>(HUB_VIEW);
  // AIA-Capability-Check: true, wenn `listSurveys` fuer das aktive Projekt
  // ein leeres Array liefert (AIA wurde noch nicht aktiviert). Verhindert
  // den frueheren 11x-404er-Burst beim Projekt-Load.
  const [aiaInactive, setAiaInactive] = useState(false);
  const [activating, setActivating] = useState(false);

  // Verhindert parallele Loads beim selben Projekt (React StrictMode)
  const activeLoadRef = useRef<string | null>(null);

  /**
   * Lädt alle benötigten Daten für das aktive Projekt.
   * Setzt `selectedSurvey` auf "user-profile" wenn noch kein Profil existiert.
   *
   * **Capability-Check:** Vor dem Bulk-Load wird `listSurveys` aufgerufen.
   * Leeres Ergebnis -> AIA-Inactive-State (User kann via Aktivieren-Button
   * den Auto-Init triggern). Damit vermeiden wir 11 parallele 404er-GETs
   * fuer Projekte, in denen AIA gar nicht verwendet wird.
   */
  const initHub = useCallback(async (pid: string) => {
    if (!pid) return;
    if (activeLoadRef.current === pid) return;
    activeLoadRef.current = pid;

    setLoading(true);
    setError(null);
    setHubData(null);
    setAiaInactive(false);
    setView(HUB_VIEW);

    try {
      // Capability-Check: Liste der existierenden Surveys einmalig holen.
      // Wenn leer, war AIA noch nie initialisiert — der User entscheidet via
      // Aktivieren-Button, ob die Default-Definitionen geseedet werden.
      const existingSurveys = await listSurveys(pid);
      if (existingSurveys.length === 0) {
        setAiaInactive(true);
        setLoading(false);
        if (activeLoadRef.current === pid) {
          activeLoadRef.current = null;
        }
        return;
      }
      // Alle Datenquellen parallel laden. assetTypes/softwares kommen über
      // `choices` aus loadStammdatenChoices — separate Loads sparen wir uns.
      const [
        userProfileData,
        choices,
        projectTradesData,
        projectProfileData,
        projectTeamsData,
        teams,
        projectPhasesMilestonesData,
        projectLodLoiData,
        projectAssetTypesData,
        projectSoftwaresData,
        projectObjectivesData,
        projectBimUsesData,
        twinClassLoinData,
        twinClasses,
        loinResponses,
      ] = await Promise.all([
        loadUserProfileSurvey(pid),
        loadStammdatenChoices(pid),
        loadProjectTradesSurvey(pid),
        loadProjectProfileSurvey(pid),
        loadProjectTeamsSurvey(pid),
        loadTeams(pid),
        loadProjectPhasesMilestonesSurvey(pid),
        loadProjectLodLoiSurvey(pid),
        loadProjectAssetTypesSurvey(pid),
        loadProjectSoftwaresSurvey(pid),
        loadProjectObjectivesSurvey(pid),
        loadProjectBimUsesSurvey(pid),
        loadTwinClassLoinSurvey(pid),
        listTwinClasses(pid),
        loadLoinResponses(pid),
      ]);
      const assetTypes = choices.assetTypes;
      const softwares = choices.softwares;

      const tradeLock = extractTradeLock(projectTradesData.existingResponse);
      const userAnswers = userProfileData.existingResponse?.completed
        ? (userProfileData.existingResponse.answers as Record<string, unknown>)
        : null;
      const projectProfileAnswers = projectProfileData.existingResponse
        ?.completed
        ? (projectProfileData.existingResponse.answers as Record<
            string,
            unknown
          >)
        : null;
      const phasesMilestonesAnswers = projectPhasesMilestonesData
        .existingResponse?.completed
        ? (projectPhasesMilestonesData.existingResponse.answers as Record<
            string,
            unknown
          >)
        : null;
      const lodLoiAnswers = projectLodLoiData.existingResponse?.completed
        ? (projectLodLoiData.existingResponse.answers as Record<
            string,
            unknown
          >)
        : null;
      const objectivesAnswers = projectObjectivesData.existingResponse
        ?.completed
        ? (projectObjectivesData.existingResponse.answers as Record<
            string,
            unknown
          >)
        : null;
      const bimUsesAnswers = projectBimUsesData.existingResponse?.completed
        ? (projectBimUsesData.existingResponse.answers as Record<
            string,
            unknown
          >)
        : null;

      setHubData({
        choices,
        tradeLock,
        userProfileData,
        projectTradesData,
        projectProfileData,
        projectTeamsData,
        projectPhasesMilestonesData,
        projectLodLoiData,
        projectAssetTypesData,
        projectSoftwaresData,
        projectObjectivesData,
        projectBimUsesData,
        twinClassLoinData,
        userAnswers,
        projectProfileAnswers,
        teams,
        assetTypes,
        softwares,
        phasesMilestonesAnswers,
        lodLoiAnswers,
        objectivesAnswers,
        bimUsesAnswers,
        twinClasses,
        loinResponses,
      });

      // User ohne ausgefülltes Profil → direkt in den SurveyRunner
      if (!userProfileData.existingResponse?.completed) {
        setView({ kind: "survey", key: "user-profile" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`AIA konnte nicht geladen werden: ${msg}`);
      console.debug("[aia/panel] initHub fehlgeschlagen:", err);
    } finally {
      setLoading(false);
      if (activeLoadRef.current === pid) {
        activeLoadRef.current = null;
      }
    }
  }, []);

  /**
   * Aktiviert AIA fuer das aktive Projekt: triggert den Auto-Init aller
   * Standard-Survey-Definitionen, indem die bestehenden `loadXSurvey`-Helfer
   * der Reihe nach aufgerufen werden. Jeder Helfer macht GET → 404 → PUT,
   * legt also die Default-Definition serverseitig an. Anschliessend wird
   * `initHub` erneut aufgerufen — beim zweiten Lauf greift der
   * Capability-Check, findet die Surveys, und der normale Bulk-Load laeuft.
   *
   * Sequenziell statt parallel, damit ein einzelner PUT-Fehler nicht den
   * gesamten Init-Lauf abreisst.
   */
  const activateAia = useCallback(
    async (pid: string) => {
      if (!pid) return;
      setActivating(true);
      setError(null);
      try {
        // Sequenzieller Auto-Init: jeder Aufruf laed Survey, faellt bei 404
        // auf PUT zurueck und schreibt die lokale Default-Definition.
        await loadUserProfileSurvey(pid);
        await loadProjectTradesSurvey(pid);
        await loadProjectProfileSurvey(pid);
        await loadProjectTeamsSurvey(pid);
        await loadProjectPhasesMilestonesSurvey(pid);
        await loadProjectLodLoiSurvey(pid);
        await loadProjectAssetTypesSurvey(pid);
        await loadProjectSoftwaresSurvey(pid);
        await loadProjectObjectivesSurvey(pid);
        await loadProjectBimUsesSurvey(pid);
        await loadTwinClassLoinSurvey(pid);

        // Erfolgreich initialisiert — Capability-Check beim naechsten Lauf
        // sieht jetzt die Surveys, der normale Bulk-Load greift.
        setAiaInactive(false);
        await initHub(pid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`AIA-Aktivierung fehlgeschlagen: ${msg}`);
        console.warn("[aia/panel] activateAia fehlgeschlagen:", err);
      } finally {
        setActivating(false);
      }
    },
    [initHub],
  );

  // Initialer Mount
  useEffect(() => {
    const pid = projectContext.activeProjectId ?? "";
    setProjectId(pid);
    if (pid) void initHub(pid);
  }, [initHub]);

  // Projektwechsel
  useEffect(() => {
    const handler = () => {
      const pid = projectContext.activeProjectId ?? "";
      setProjectId(pid);
      if (pid) void initHub(pid);
    };
    onProjectLoaded.add(handler);
    return () => {
      onProjectLoaded.remove(handler);
    };
  }, [initHub]);

  // ─── Callbacks ───────────────────────────────────────────────────────────────

  /**
   * Nach erfolgreichem Save im SurveyRunner — State aktualisieren,
   * dann zurück zur Hub-View.
   */
  const handleSaved = useCallback(
    (key: RunnableSurveyKey, answers: Record<string, unknown>) => {
      if (key === "project-teams") {
        // Neues Team wurde angelegt — Teams-Liste neu vom Server laden
        // (gibt uns den vom Server zurückgeschriebenen Eintrag inkl. UUID/meta).
        const pid = projectContext.activeProjectId ?? "";
        if (pid) {
          void loadTeams(pid)
            .then((teams) => {
              setHubData((prev) => (prev ? { ...prev, teams } : prev));
            })
            .catch((err) => {
              console.debug(
                "[aia/panel] loadTeams nach Submit fehlgeschlagen:",
                err,
              );
            });
        }
        return;
      }
      if (key === "project-asset-types" || key === "project-softwares") {
        // Neuer Asset-Type oder neue Software → Stammdaten-Choices komplett
        // neu laden, damit nachfolgende Surveys (z. B. Softwares → assetTypeIds
        // oder BIM-Uses → softwareIds) die neue Auswahl zeigen.
        const pid = projectContext.activeProjectId ?? "";
        if (pid) {
          void loadStammdatenChoices(pid)
            .then((choices) => {
              setHubData((prev) =>
                prev
                  ? {
                      ...prev,
                      choices,
                      assetTypes: choices.assetTypes,
                      softwares: choices.softwares,
                    }
                  : prev,
              );
            })
            .catch((err) => {
              console.debug(
                "[aia/panel] loadStammdatenChoices nach Submit fehlgeschlagen:",
                err,
              );
            });
        }
        return;
      }
      if (key === "twinclass-loin") {
        // LOIN-Response geschrieben → neu laden, damit LoinMatrixView den
        // "Gepflegt"-Badge für diese TwinClass zeigt.
        const pid = projectContext.activeProjectId ?? "";
        if (pid) {
          void loadLoinResponses(pid)
            .then((loinResponses) => {
              setHubData((prev) => (prev ? { ...prev, loinResponses } : prev));
            })
            .catch((err) => {
              console.debug(
                "[aia/panel] loadLoinResponses nach Submit fehlgeschlagen:",
                err,
              );
            });
        }
        return;
      }
      setHubData((prev) => {
        if (!prev) return prev;
        if (key === "user-profile") {
          return { ...prev, userAnswers: answers };
        }
        if (key === "project-profile") {
          // Partial-Response-Shim für die Hub-Kachel-Anzeige
          const updatedResponse = {
            ...(prev.projectProfileData.existingResponse ?? {}),
            answers,
            completed: true,
          } as AiaResponse;
          return {
            ...prev,
            projectProfileAnswers: answers,
            projectProfileData: {
              ...prev.projectProfileData,
              existingResponse: updatedResponse,
            },
          };
        }
        if (key === "project-phases-milestones") {
          const updatedResponse = {
            ...(prev.projectPhasesMilestonesData.existingResponse ?? {}),
            answers,
            completed: true,
          } as AiaResponse;
          return {
            ...prev,
            phasesMilestonesAnswers: answers,
            projectPhasesMilestonesData: {
              ...prev.projectPhasesMilestonesData,
              existingResponse: updatedResponse,
            },
          };
        }
        if (key === "project-lod-loi") {
          const updatedResponse = {
            ...(prev.projectLodLoiData.existingResponse ?? {}),
            answers,
            completed: true,
          } as AiaResponse;
          return {
            ...prev,
            lodLoiAnswers: answers,
            projectLodLoiData: {
              ...prev.projectLodLoiData,
              existingResponse: updatedResponse,
            },
          };
        }
        if (key === "project-objectives") {
          const updatedResponse = {
            ...(prev.projectObjectivesData.existingResponse ?? {}),
            answers,
            completed: true,
          } as AiaResponse;
          return {
            ...prev,
            objectivesAnswers: answers,
            projectObjectivesData: {
              ...prev.projectObjectivesData,
              existingResponse: updatedResponse,
            },
          };
        }
        if (key === "project-bim-uses") {
          const updatedResponse = {
            ...(prev.projectBimUsesData.existingResponse ?? {}),
            answers,
            completed: true,
          } as AiaResponse;
          return {
            ...prev,
            bimUsesAnswers: answers,
            projectBimUsesData: {
              ...prev.projectBimUsesData,
              existingResponse: updatedResponse,
            },
          };
        }
        // project-trades
        const updatedResponse = {
          ...(prev.projectTradesData.existingResponse ?? {}),
          answers,
          completed: true,
        } as AiaResponse;
        const updatedTradeLock = extractTradeLock(updatedResponse);
        return {
          ...prev,
          tradeLock: updatedTradeLock,
          projectTradesData: {
            ...prev.projectTradesData,
            existingResponse: updatedResponse,
          },
        };
      });
    },
    [],
  );

  const handleBack = useCallback(() => {
    // Aus LOIN-Survey zurück → LoinMatrixView wiederherstellen; aus anderen
    // Surveys zurück → Hub.
    setView((prev) =>
      prev.kind === "survey" && prev.key === "twinclass-loin"
        ? { kind: "loin-matrix" }
        : HUB_VIEW,
    );
  }, []);

  const handleBackFromMatrix = useCallback(() => {
    setView(HUB_VIEW);
  }, []);

  /** Öffnet eine spezifische TwinClass im LOIN-SurveyRunner. */
  const handleOpenLoin = useCallback((twinClass: TwinClassRow) => {
    setView({ kind: "survey", key: "twinclass-loin", twinClass });
  }, []);

  // ─── isManager ───────────────────────────────────────────────────────────────

  const isManager = hubData
    ? isProjectManagerRole(
        hubData.userAnswers?.["bimRole"] as string | undefined,
        hubData.choices.bimRoles,
      )
    : false;

  // ─── Render ──────────────────────────────────────────────────────────────────

  // Header-Actions: "Bearbeiten"-Button im Hub wenn Profil ausgefüllt ist
  // und kein SurveyRunner aktiv ist.
  const showEditButton = view.kind === "hub" && Boolean(hubData?.userAnswers);

  const renderBody = () => {
    if (!projectId) {
      return (
        <div className="aia-empty-state">
          Kein aktives Projekt.
          <br />
          <span style={{ fontSize: "0.72rem", opacity: 0.7 }}>
            Bitte ein Projekt aus der Projektwahl öffnen.
          </span>
        </div>
      );
    }
    if (loading) {
      return <div className="aia-empty-state">AIA wird geladen …</div>;
    }
    if (error) {
      return <div className="aia-error-state">{error}</div>;
    }
    // Capability-Check-Ergebnis: AIA ist fuer dieses Projekt noch nicht
    // aktiviert. Zeige einen Hinweis + Aktivieren-Button statt die 11
    // Default-Surveys automatisch zu seeden.
    if (aiaInactive) {
      return (
        <div className="aia-empty-state" style={{ flexDirection: "column", gap: 12 }}>
          <span>AIA ist fuer dieses Projekt nicht aktiviert.</span>
          <button
            type="button"
            disabled={activating}
            onClick={() => void activateAia(projectId)}
            style={{
              padding: "8px 16px",
              cursor: activating ? "wait" : "pointer",
              opacity: activating ? 0.6 : 1,
            }}
          >
            {activating
              ? "AIA wird initialisiert …"
              : "AIA fuer dieses Projekt aktivieren"}
          </button>
        </div>
      );
    }
    if (!hubData) return null;

    // Lokale Aliase halten die if-Kaskade für die 11 SurveyRunner-Varianten
    // lesbar — das Diskriminanten-Matching passiert genau einmal hier oben.
    const selectedSurvey: RunnableSurveyKey | null =
      view.kind === "survey" ? view.key : null;
    const selectedTwinClass: TwinClassRow | null =
      view.kind === "survey" && view.key === "twinclass-loin"
        ? (view.twinClass ?? null)
        : null;

    // SurveyRunner aktiv → Formular zeigen
    if (selectedSurvey === "user-profile") {
      return (
        <SurveyRunner
          key={`${projectId}-user-profile`}
          projectId={projectId}
          surveyKey="user-profile"
          survey={hubData.userProfileData.survey}
          existingResponse={hubData.userProfileData.existingResponse}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("user-profile", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-trades") {
      return (
        <SurveyRunner
          key={`${projectId}-project-trades`}
          projectId={projectId}
          surveyKey="project-trades"
          survey={hubData.projectTradesData.survey}
          existingResponse={hubData.projectTradesData.existingResponse}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-trades", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-profile") {
      return (
        <SurveyRunner
          key={`${projectId}-project-profile`}
          projectId={projectId}
          surveyKey="project-profile"
          survey={hubData.projectProfileData.survey}
          existingResponse={hubData.projectProfileData.existingResponse}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-profile", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-teams") {
      return (
        <SurveyRunner
          key={`${projectId}-project-teams-${hubData.teams.length}`}
          projectId={projectId}
          surveyKey="project-teams"
          survey={hubData.projectTeamsData.survey}
          existingResponse={null}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-teams", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-phases-milestones") {
      return (
        <SurveyRunner
          key={`${projectId}-project-phases-milestones`}
          projectId={projectId}
          surveyKey="project-phases-milestones"
          survey={hubData.projectPhasesMilestonesData.survey}
          existingResponse={
            hubData.projectPhasesMilestonesData.existingResponse
          }
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) =>
            handleSaved("project-phases-milestones", answers)
          }
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-lod-loi") {
      return (
        <SurveyRunner
          key={`${projectId}-project-lod-loi`}
          projectId={projectId}
          surveyKey="project-lod-loi"
          survey={hubData.projectLodLoiData.survey}
          existingResponse={hubData.projectLodLoiData.existingResponse}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-lod-loi", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-asset-types") {
      return (
        <SurveyRunner
          key={`${projectId}-project-asset-types-${hubData.assetTypes.length}`}
          projectId={projectId}
          surveyKey="project-asset-types"
          survey={hubData.projectAssetTypesData.survey}
          existingResponse={null}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-asset-types", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-softwares") {
      return (
        <SurveyRunner
          key={`${projectId}-project-softwares-${hubData.softwares.length}`}
          projectId={projectId}
          surveyKey="project-softwares"
          survey={hubData.projectSoftwaresData.survey}
          existingResponse={null}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-softwares", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-objectives") {
      return (
        <SurveyRunner
          key={`${projectId}-project-objectives`}
          projectId={projectId}
          surveyKey="project-objectives"
          survey={hubData.projectObjectivesData.survey}
          existingResponse={hubData.projectObjectivesData.existingResponse}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-objectives", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "project-bim-uses") {
      return (
        <SurveyRunner
          key={`${projectId}-project-bim-uses`}
          projectId={projectId}
          surveyKey="project-bim-uses"
          survey={hubData.projectBimUsesData.survey}
          existingResponse={hubData.projectBimUsesData.existingResponse}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          onSaved={(answers) => handleSaved("project-bim-uses", answers)}
          onBack={handleBack}
        />
      );
    }

    if (selectedSurvey === "twinclass-loin" && selectedTwinClass) {
      const existingLoin =
        hubData.loinResponses.find((r) => r.scopeId === selectedTwinClass.id) ??
        null;
      const loinContext = {
        milestones: Array.isArray(
          hubData.phasesMilestonesAnswers?.["milestones"],
        )
          ? (hubData.phasesMilestonesAnswers?.["milestones"] as Array<
              Record<string, unknown>
            >)
          : [],
        lods: Array.isArray(hubData.lodLoiAnswers?.["lods"])
          ? (hubData.lodLoiAnswers?.["lods"] as Array<Record<string, unknown>>)
          : [],
        lois: Array.isArray(hubData.lodLoiAnswers?.["lois"])
          ? (hubData.lodLoiAnswers?.["lois"] as Array<Record<string, unknown>>)
          : [],
        teams: hubData.teams,
      };
      return (
        <SurveyRunner
          key={`${projectId}-twinclass-loin-${selectedTwinClass.id}`}
          projectId={projectId}
          surveyKey="twinclass-loin"
          survey={hubData.twinClassLoinData.survey}
          existingResponse={existingLoin}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          scopeId={selectedTwinClass.id}
          loinClass={selectedTwinClass}
          loinContext={loinContext}
          onSaved={(answers) => handleSaved("twinclass-loin", answers)}
          onBack={handleBack}
        />
      );
    }

    if (view.kind === "loin-matrix") {
      return (
        <LoinMatrixView
          twinClasses={hubData.twinClasses}
          loinResponses={hubData.loinResponses}
          onOpen={handleOpenLoin}
          onBack={handleBackFromMatrix}
        />
      );
    }

    if (view.kind === "deliverables") {
      const projectCode =
        (hubData.projectProfileAnswers?.["projectCode"] as
          | string
          | undefined) ?? null;
      const milestones = Array.isArray(
        hubData.phasesMilestonesAnswers?.["milestones"],
      )
        ? (hubData.phasesMilestonesAnswers?.["milestones"] as Array<
            Record<string, unknown>
          >)
        : [];
      return (
        <DeliverablesView
          projectId={projectId}
          projectCode={projectCode}
          assetTypes={hubData.assetTypes}
          softwares={hubData.softwares}
          teams={hubData.teams}
          disciplines={hubData.choices.trades}
          milestones={milestones}
          onBack={() => setView(HUB_VIEW)}
        />
      );
    }

    if (view.kind === "standards") {
      return (
        <StandardsView projectId={projectId} onBack={() => setView(HUB_VIEW)} />
      );
    }

    // Hub-View
    return (
      <div className="aia-landing-wrapper">
        <h3 className="aia-landing-heading">AIA – Übersicht</h3>
        <HubView
          userAnswers={hubData.userAnswers}
          projectProfileAnswers={hubData.projectProfileAnswers}
          choices={hubData.choices}
          tradeLock={hubData.tradeLock}
          projectTradesResponse={hubData.projectTradesData.existingResponse}
          teams={hubData.teams}
          assetTypes={hubData.assetTypes}
          softwares={hubData.softwares}
          phasesMilestonesAnswers={hubData.phasesMilestonesAnswers}
          lodLoiAnswers={hubData.lodLoiAnswers}
          objectivesAnswers={hubData.objectivesAnswers}
          bimUsesAnswers={hubData.bimUsesAnswers}
          twinClasses={hubData.twinClasses}
          loinResponses={hubData.loinResponses}
          isManager={isManager}
          onSelectSurvey={(key) => setView({ kind: "survey", key })}
          onOpenLoinMatrix={() => setView({ kind: "loin-matrix" })}
          onOpenDeliverables={() => setView({ kind: "deliverables" })}
          onOpenStandards={() => setView({ kind: "standards" })}
        />
      </div>
    );
  };

  return (
    <ModulePanel>
      <ModulePanelHeader
        icon={appIcons.AIA}
        title="AIA"
        actions={
          showEditButton ? (
            <ModulePanelButton
              label="Profil bearbeiten"
              icon="solar:pen-bold"
              onClick={() => setView({ kind: "survey", key: "user-profile" })}
              title="Profil-Antworten bearbeiten"
            />
          ) : undefined
        }
      />
      <ModulePanelBody>{renderBody()}</ModulePanelBody>
    </ModulePanel>
  );
}
