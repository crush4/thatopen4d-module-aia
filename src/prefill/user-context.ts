/**
 * @module packages/module-aia/src/prefill/user-context
 *
 * Prefill-Service für das User-Profil-Survey.
 *
 * Liest den aktuellen Auth-State und baut daraus initiale Survey-Antworten.
 * In v1 werden nur `displayName` und `email` vorbefüllt — beide kommen
 * aus dem eingeloggten Nutzerkonto. Modell-basiertes Prefill (aus IFC-Fragments)
 * folgt mit späteren Surveys (project-basics).
 */

import { getAuthState } from "@thatopen4d/plugin-sdk/host";

/** Initiale Survey-Daten für das User-Profil-Formular. */
export interface UserProfilePrefill {
  displayName: string;
  email: string;
}

/**
 * Baut die Prefill-Daten für das "user-profile"-Survey aus dem Auth-State.
 *
 * Gibt einen leeren Datensatz zurück, wenn kein User eingeloggt ist
 * (sollte im produktiven Flow nicht vorkommen — Panel ist hinter Auth-Gate).
 */
export function buildUserProfilePrefill(): UserProfilePrefill {
  const { user } = getAuthState();
  if (!user) {
    return { displayName: "", email: "" };
  }
  return {
    displayName: user.name,
    email: user.email,
  };
}
