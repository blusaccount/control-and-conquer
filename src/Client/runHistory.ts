import type { RasterMatchEndedPayload } from "../Core/types.js";

/**
 * Persistent per-run record for the roguelite run history. Stored in
 * `localStorage` as a JSON array; no backend is needed for the MVP.
 */
export interface RunRecord {
  /** 1-based run number ("Run #N"). */
  run: number;
  /** Epoch milliseconds when the run ended (supplied by the caller). */
  endedAt: number;
  won: boolean;
  reason: RasterMatchEndedPayload["reason"];
  peakTiles: number;
  finalTiles: number;
  kills: number;
  /** Whole seconds the player survived. */
  survivedSeconds: number;
}

/**
 * The slice of the `Storage` API this module needs. Abstracted so the logic can
 * be unit-tested against an in-memory stub without a browser.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "cnc-run-history";
/** Keep history bounded so the entry can't grow without limit. */
const MAX_HISTORY = 25;

/** Read the run history, tolerating absent or corrupt storage (returns []). */
export const loadRunHistory = (storage: StorageLike): RunRecord[] => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
  } catch {
    return [];
  }
};

/**
 * Append a completed run derived from a match-ended payload and persist it.
 * Returns the new record (with its assigned run number) so the caller can show
 * it immediately. `endedAt` is injected rather than read from the clock here so
 * the function stays pure and testable.
 */
export const recordRun = (
  storage: StorageLike,
  payload: RasterMatchEndedPayload,
  endedAt: number,
): RunRecord => {
  const history = loadRunHistory(storage);
  const survivedSeconds = payload.tickRate > 0
    ? Math.round(payload.stats.survivedTicks / payload.tickRate)
    : 0;
  const record: RunRecord = {
    run: history.length + 1,
    endedAt,
    won: payload.stats.won,
    reason: payload.reason,
    peakTiles: payload.stats.peakTiles,
    finalTiles: payload.stats.finalTiles,
    kills: payload.stats.kills,
    survivedSeconds,
  };
  const next = [...history, record].slice(-MAX_HISTORY);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable or full: the run still shows on screen this session.
  }
  return record;
};
