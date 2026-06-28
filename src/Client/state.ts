import type { GameStateSnapshot, TeamId } from "../Core/types.js";

/**
 * Mutable client-side view of the match. Modules read and write this shared
 * object rather than threading state through every call. The server remains the
 * single source of truth; this is only the latest snapshot plus local UI intent.
 */
export interface ClientState {
  snapshot: GameStateSnapshot | null;
  myTeamId: TeamId | null;
  selectedSourceTerritoryId: string | null;
  matchEnded: boolean;
}

export const clientState: ClientState = {
  snapshot: null,
  myTeamId: null,
  selectedSourceTerritoryId: null,
  matchEnded: false,
};

/** Display names used before the first snapshot carries the authoritative team names. */
export const FALLBACK_TEAM_NAMES: Record<TeamId, string> = {
  blue: "Blue Team",
  red: "Red Team",
};
