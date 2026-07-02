/**
 * @module packages/module-aia/src/service
 *
 * AIA-Service — dünne Fassade über die API-Clients.
 *
 * Exportiert Re-Exports der API-Funktionen sowie zwei Helfer-Funktionen,
 * die häufige Lade-Sequenzen kapseln:
 *
 *  - `loadUserProfileSurvey`  — Survey-Definition holen oder initialisieren.
 *  - `loadStammdatenChoices`  — Rollen- und Gewerk-Listen parallel laden.
 *
 * Das Panel importiert ausschließlich aus diesem Service — kein direkter
 * Import aus `@thatopen4d/api-clients/aia`.
 */

import {
  listStammdaten,
  createStammdatenEntry,
  getSurvey,
  putSurvey,
  listSurveys,
  listResponses,
  upsertResponse,
} from "@thatopen4d/api-clients/aia";
import { listTwinClasses } from "@thatopen4d/api-clients/twin-classes";
import { ApiError } from "@thatopen4d/api-clients/client";
import type {
  AiaSurvey,
  AiaResponse,
  AiaStammdatenEntry,
} from "@thatopen4d/plugin-sdk/shared";
import type { TwinClassRow } from "@thatopen4d/plugin-sdk/shared";

// Lokale Survey-Definitionen — Fallbacks wenn Server noch keine Version hat
import localUserProfileDefinition from "./surveys/user-profile.json";
import localProjectTradesDefinition from "./surveys/project-trades.json";
import localProjectProfileDefinition from "./surveys/project-profile.json";
import localProjectTeamsDefinition from "./surveys/project-teams.json";
import localProjectPhasesMilestonesDefinition from "./surveys/project-phases-milestones.json";
import localProjectLodLoiDefinition from "./surveys/project-lod-loi.json";
import localProjectAssetTypesDefinition from "./surveys/project-asset-types.json";
import localProjectSoftwaresDefinition from "./surveys/project-softwares.json";
import localProjectObjectivesDefinition from "./surveys/project-objectives.json";
import localProjectBimUsesDefinition from "./surveys/project-bim-uses.json";
import localTwinClassLoinDefinition from "./surveys/twinclass-loin.json";

// Re-Exporte — Panel braucht nur diesen Service als Import
export {
  listStammdaten,
  createStammdatenEntry,
  getSurvey,
  putSurvey,
  listSurveys,
  listResponses,
  upsertResponse,
  listTwinClasses,
};
export type { TwinClassRow };

/**
 * BIM-Rollen, deren Inhaber Projekt-Surveys sehen und bearbeiten
 * können. Match erfolgt gegen `labels.de` des Stammdaten-Eintrags.
 *
 * Hintergrund: AIG-Manager (Auftraggeber-Seite) definieren projektweite
 * AIA-Randbedingungen; BIM-Manager (Auftragnehmer-Seite) operationalisieren
 * sie. Beide Rollen dürfen die Projekt-Gewerke-Liste kuratieren.
 */
export const PROJECT_MANAGER_ROLES: ReadonlySet<string> = new Set([
  "BIM-Manager",
  "AIG-Manager",
]);

/**
 * Prüft, ob die angegebene BIM-Rollen-ID auf eine Manager-Rolle zeigt.
 * Löst die ID gegen die geladenen Stammdaten auf und vergleicht
 * `labels.de`. Duplikat-robust: auch "BIM Manager" (ohne Bindestrich)
 * wird nicht gematcht — nur der kanonische Default-Eintrag.
 */
export function isProjectManagerRole(
  bimRoleId: string | undefined,
  bimRoles: AiaStammdatenEntry[],
): boolean {
  if (!bimRoleId) return false;
  const entry = bimRoles.find((r) => r.id === bimRoleId);
  if (!entry) return false;
  const deLabel = entry.labels["de"];
  return deLabel ? PROJECT_MANAGER_ROLES.has(deLabel) : false;
}

// ─── Ergebnis-Typen ──────────────────────────────────────────────────────────

export interface UserProfileSurveyData {
  /** Aus dem Server geladene (oder frisch initialisierte) Survey-Definition. */
  survey: AiaSurvey;
  /**
   * Bestehende Antwort des aktuellen Users, falls vorhanden.
   * `null` wenn noch keine Antwort persistiert wurde.
   */
  existingResponse: AiaResponse | null;
}

export interface StammdatenChoices {
  roles: AiaStammdatenEntry[];
  bimRoles: AiaStammdatenEntry[];
  trades: AiaStammdatenEntry[];
  assetTypes: AiaStammdatenEntry[];
  softwares: AiaStammdatenEntry[];
}

// ─── Helfer-Funktionen ───────────────────────────────────────────────────────

/**
 * Lädt die User-Profil-Survey-Definition für ein Projekt.
 *
 * Ablauf:
 * 1. Versuche `getSurvey(projectId, "user-profile")`.
 * 2. Bei 404: lokales JSON via `putSurvey` auf den Server pushen, damit der
 *    Server ab sofort eine kanonische Version hat.
 * 3. Lade bestehende User-Responses via `listResponses(projectId, "user")`.
 *    Gibt die erste Response für "user-profile" zurück (die neueste).
 *
 * @param projectId - ID des aktiven Projekts
 */
export async function loadUserProfileSurvey(
  projectId: string,
): Promise<UserProfileSurveyData> {
  let survey: AiaSurvey;

  try {
    survey = await getSurvey(projectId, "user-profile");
  } catch (err) {
    // 404 → lokale Definition initialisieren
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "user-profile",
        localUserProfileDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }

  // Bestehende Antwort laden (leer = kein prior Eintrag)
  let existingResponse: AiaResponse | null = null;
  try {
    const responses = await listResponses(projectId, "user");
    // Neueste Antwort für diesen Survey finden (gematcht über surveyId)
    const match = responses.find((r) => r.surveyId === survey.id);
    existingResponse = match ?? null;
  } catch (err) {
    // Fehler beim Response-Laden ist nicht fatal — Survey wird trotzdem angezeigt
    console.debug("[aia/service] listResponses fehlgeschlagen:", err);
  }

  return { survey, existingResponse };
}

/**
 * Lädt alle Stammdaten-Listen parallel für ein Projekt:
 * Projektrollen, BIM-Rollen und Gewerke.
 *
 * Der Server führt beim ersten Aufruf ein idempotentes Seeding der
 * Default-Einträge durch — kein gesonderter Init-Schritt nötig.
 *
 * @param projectId - ID des aktiven Projekts (inkludiert projektspezifische Einträge)
 */
export async function loadStammdatenChoices(
  projectId: string,
): Promise<StammdatenChoices> {
  const [roles, bimRoles, trades, assetTypes, softwares] = await Promise.all([
    listStammdaten("role", projectId),
    listStammdaten("bimRole", projectId),
    listStammdaten("trade", projectId),
    listStammdaten("assetType", projectId),
    listStammdaten("software", projectId),
  ]);
  return { roles, bimRoles, trades, assetTypes, softwares };
}

// ─── Projekt-Gewerke-Survey (BIM-/AIG-Manager-only) ──────────────────────────

export interface ProjectTradesSurveyData {
  survey: AiaSurvey;
  /** Einzige Projekt-Response (scope="project"). null = noch nie gepflegt. */
  existingResponse: AiaResponse | null;
}

/**
 * Extrahierter Lock-State aus der Projekt-Trades-Response — im User-Profil
 * wird damit die Gewerk-Eingabe konfiguriert.
 */
export interface ProjectTradeLock {
  /** Wenn true: User-Profil-Gewerk-Dropdown zeigt kein "Andere"-Feld. */
  locked: boolean;
  /** IDs der kuratierten Gewerke (Whitelist). Leeres Array = keine Kuration. */
  allowedTradeIds: string[];
}

/** Default-Lock-State, wenn keine Projekt-Response existiert. */
export const UNLOCKED_TRADES: ProjectTradeLock = {
  locked: false,
  allowedTradeIds: [],
};

/**
 * Lädt die Projekt-Gewerke-Survey-Definition + aktuelle Projekt-Response.
 *
 * Verhalten analog zu `loadUserProfileSurvey`:
 * - Bei 404 wird das lokale JSON gepusht.
 * - Response-Scope ist "project" — nur eine Antwort pro Projekt.
 */
export async function loadProjectTradesSurvey(
  projectId: string,
): Promise<ProjectTradesSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-trades");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-trades",
        localProjectTradesDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }

  let existingResponse: AiaResponse | null = null;
  try {
    const responses = await listResponses(projectId, "project");
    existingResponse = responses.find((r) => r.surveyId === survey.id) ?? null;
  } catch (err) {
    console.debug("[aia/service] listResponses(project) fehlgeschlagen:", err);
  }

  return { survey, existingResponse };
}

/**
 * Liest den Lock-State aus einer Projekt-Trades-Response.
 * Robust gegen null/undefined — default ist "nicht gesperrt".
 */
export function extractTradeLock(
  response: AiaResponse | null,
): ProjectTradeLock {
  if (!response?.completed || !response.answers) return UNLOCKED_TRADES;
  const answers = response.answers as Record<string, unknown>;
  const locked = answers["locked"] === true;
  const allowedTradeIds = Array.isArray(answers["allowedTrades"])
    ? (answers["allowedTrades"] as string[])
    : [];
  return { locked, allowedTradeIds };
}

// ─── Projekt-Profil-Survey (ISO-19650-Projektkopf) ───────────────────────────

export interface ProjectProfileSurveyData {
  survey: AiaSurvey;
  /** Projektweit einzige Response (scope="project"). null = noch nie gepflegt. */
  existingResponse: AiaResponse | null;
}

/**
 * Lädt die Projekt-Profil-Survey-Definition + aktuelle Projekt-Response.
 *
 * Verhalten analog zu `loadUserProfileSurvey` und `loadProjectTradesSurvey`:
 * Bei 404 wird das lokale JSON gepusht; Response-Scope ist "project".
 *
 * Fragen: projectCode, projectName, clientName, projectAddress, projectDescription.
 */
export async function loadProjectProfileSurvey(
  projectId: string,
): Promise<ProjectProfileSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-profile");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-profile",
        localProjectProfileDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }

  let existingResponse: AiaResponse | null = null;
  try {
    const responses = await listResponses(projectId, "project");
    existingResponse = responses.find((r) => r.surveyId === survey.id) ?? null;
  } catch (err) {
    console.debug("[aia/service] listResponses(project) fehlgeschlagen:", err);
  }

  return { survey, existingResponse };
}

// ─── Projekt-Teams (ISO-19650) ───────────────────────────────────────────────

export interface ProjectTeamsSurveyData {
  /** Survey-Definition zum Hinzufügen eines neuen Teams (Single-Team-Form). */
  survey: AiaSurvey;
}

/**
 * Lädt die Projekt-Teams-Survey-Definition.
 *
 * Folgt dem "Ein Team pro Submit"-Muster: Jeder Submit legt einen neuen
 * `aiaStammdaten`-Eintrag vom Typ `"team"` an. Es gibt keine persistente
 * Response — Teams landen direkt als Stammdaten.
 */
export async function loadProjectTeamsSurvey(
  projectId: string,
): Promise<ProjectTeamsSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-teams");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-teams",
        localProjectTeamsDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }
  return { survey };
}

/**
 * Lädt alle Teams eines Projekts. Teams sind projekt-spezifische
 * `aiaStammdaten`-Einträge vom Typ `"team"` — keine globalen Defaults.
 */
export async function loadTeams(
  projectId: string,
): Promise<AiaStammdatenEntry[]> {
  return listStammdaten("team", projectId);
}

// ─── Projekt-Phasen & Milestones ─────────────────────────────────────────────

export interface ProjectPhasesMilestonesSurveyData {
  survey: AiaSurvey;
  /** Projektweit einzige Response (scope="project"). null = noch nie gepflegt. */
  existingResponse: AiaResponse | null;
}

/**
 * Lädt die Projekt-Phasen-und-Milestones-Survey-Definition + aktuelle Response.
 * Verhalten analog zu `loadProjectProfileSurvey`.
 */
export async function loadProjectPhasesMilestonesSurvey(
  projectId: string,
): Promise<ProjectPhasesMilestonesSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-phases-milestones");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-phases-milestones",
        localProjectPhasesMilestonesDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }

  let existingResponse: AiaResponse | null = null;
  try {
    const responses = await listResponses(projectId, "project");
    existingResponse = responses.find((r) => r.surveyId === survey.id) ?? null;
  } catch (err) {
    console.debug("[aia/service] listResponses(project) fehlgeschlagen:", err);
  }

  return { survey, existingResponse };
}

// ─── Projekt-LOD/LOI-Katalog ─────────────────────────────────────────────────

export interface ProjectLodLoiSurveyData {
  survey: AiaSurvey;
  /** Projektweit einzige Response (scope="project"). null = noch nie gepflegt. */
  existingResponse: AiaResponse | null;
}

// ─── Projekt-Asset-Types (Stammdaten + Survey) ───────────────────────────────

export interface ProjectAssetTypesSurveyData {
  /** Survey-Definition zum Hinzufügen eines neuen Asset-Types (Single-Entry-Form). */
  survey: AiaSurvey;
}

/**
 * Lädt die Asset-Types-Survey-Definition. Single-Entry-Pattern analog zu Teams
 * — jeder Submit legt einen neuen `aiaStammdaten`-Eintrag vom Typ `"assetType"`
 * an. Keine persistente Response.
 */
export async function loadProjectAssetTypesSurvey(
  projectId: string,
): Promise<ProjectAssetTypesSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-asset-types");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-asset-types",
        localProjectAssetTypesDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }
  return { survey };
}

/**
 * Lädt alle Asset-Types eines Projekts (Defaults + projekt-spezifisch).
 */
export async function loadAssetTypes(
  projectId: string,
): Promise<AiaStammdatenEntry[]> {
  return listStammdaten("assetType", projectId);
}

// ─── Projekt-Softwares (Stammdaten + Survey) ─────────────────────────────────

export interface ProjectSoftwaresSurveyData {
  /** Survey-Definition zum Hinzufügen einer neuen Software (Single-Entry-Form). */
  survey: AiaSurvey;
}

/**
 * Lädt die Softwares-Survey-Definition. Single-Entry-Pattern analog zu Teams.
 */
export async function loadProjectSoftwaresSurvey(
  projectId: string,
): Promise<ProjectSoftwaresSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-softwares");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-softwares",
        localProjectSoftwaresDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }
  return { survey };
}

/**
 * Lädt alle Softwares eines Projekts (projekt-spezifisch, keine Defaults).
 */
export async function loadSoftwares(
  projectId: string,
): Promise<AiaStammdatenEntry[]> {
  return listStammdaten("software", projectId);
}

// ─── Projekt-Objectives ──────────────────────────────────────────────────────

export interface ProjectObjectivesSurveyData {
  survey: AiaSurvey;
  existingResponse: AiaResponse | null;
}

export async function loadProjectObjectivesSurvey(
  projectId: string,
): Promise<ProjectObjectivesSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-objectives");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-objectives",
        localProjectObjectivesDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }

  let existingResponse: AiaResponse | null = null;
  try {
    const responses = await listResponses(projectId, "project");
    existingResponse = responses.find((r) => r.surveyId === survey.id) ?? null;
  } catch (err) {
    console.debug("[aia/service] listResponses(project) fehlgeschlagen:", err);
  }

  return { survey, existingResponse };
}

// ─── Projekt-BIM-Uses ────────────────────────────────────────────────────────

export interface ProjectBimUsesSurveyData {
  survey: AiaSurvey;
  existingResponse: AiaResponse | null;
}

export async function loadProjectBimUsesSurvey(
  projectId: string,
): Promise<ProjectBimUsesSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-bim-uses");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-bim-uses",
        localProjectBimUsesDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }

  let existingResponse: AiaResponse | null = null;
  try {
    const responses = await listResponses(projectId, "project");
    existingResponse = responses.find((r) => r.surveyId === survey.id) ?? null;
  } catch (err) {
    console.debug("[aia/service] listResponses(project) fehlgeschlagen:", err);
  }

  return { survey, existingResponse };
}

/**
 * Lädt die LOD/LOI-Katalog-Survey-Definition + aktuelle Response.
 * Verhalten analog zu `loadProjectProfileSurvey`.
 */
export async function loadProjectLodLoiSurvey(
  projectId: string,
): Promise<ProjectLodLoiSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "project-lod-loi");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "project-lod-loi",
        localProjectLodLoiDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }

  let existingResponse: AiaResponse | null = null;
  try {
    const responses = await listResponses(projectId, "project");
    existingResponse = responses.find((r) => r.surveyId === survey.id) ?? null;
  } catch (err) {
    console.debug("[aia/service] listResponses(project) fehlgeschlagen:", err);
  }

  return { survey, existingResponse };
}

// ─── TwinClass-LOIN (Kern-Feature Sprint 2 PR5) ──────────────────────────────

export interface TwinClassLoinSurveyData {
  /** Survey-Definition — Template ohne projekt-spezifische Choices. */
  survey: AiaSurvey;
}

/**
 * Lädt die LOIN-Survey-Definition. Das Template wird pro TwinClass mit
 * Milestone-, LOD-, LOI- und Team-Choices aufgewertet — die Injection
 * passiert im Panel beim Mount.
 */
export async function loadTwinClassLoinSurvey(
  projectId: string,
): Promise<TwinClassLoinSurveyData> {
  let survey: AiaSurvey;
  try {
    survey = await getSurvey(projectId, "twinclass-loin");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      survey = await putSurvey(
        projectId,
        "twinclass-loin",
        localTwinClassLoinDefinition as Record<string, unknown>,
      );
    } else {
      throw err;
    }
  }
  return { survey };
}

/**
 * Lädt alle LOIN-Responses eines Projekts (scope="twinClass"). Die Responses
 * sind pro TwinClass eindeutig (Partial-Unique-Index auf (survey, scopeId)
 * aus Migration 0012). Für LoinMatrixView mappt man über `r.scopeId`.
 */
export async function loadLoinResponses(
  projectId: string,
): Promise<AiaResponse[]> {
  return listResponses(projectId, "twinClass");
}
