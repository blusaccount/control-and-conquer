import type { MapDefinition, MapTerritoryDefinition, Point, TeamId, Territory } from "./types.js";

/**
 * A validated, runtime-ready map: territories keyed by id (with computed
 * centers) plus a stable iteration order. Produced by `loadMap` from an
 * untrusted `MapDefinition` (e.g. parsed JSON).
 */
export interface LoadedMap {
  name: string;
  territories: Record<string, Territory>;
  territoryOrder: string[];
}

const VALID_TEAM_IDS: readonly TeamId[] = ["blue", "red"];
const MIN_POLYGON_POINTS = 3;
const MIN_TERRITORIES = 2;

const fail = (message: string): never => {
  throw new Error(`Invalid map: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const computeCenter = (polygon: Point[]): Point => {
  let sumX = 0;
  let sumY = 0;
  for (const point of polygon) {
    sumX += point.x;
    sumY += point.y;
  }
  return {
    x: Math.round(sumX / polygon.length),
    y: Math.round(sumY / polygon.length),
  };
};

const validatePolygon = (value: unknown, territoryId: string): Point[] => {
  if (!Array.isArray(value) || value.length < MIN_POLYGON_POINTS) {
    fail(`territory "${territoryId}" needs a polygon with at least ${MIN_POLYGON_POINTS} points.`);
  }
  return (value as unknown[]).map((point, index) => {
    if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
      fail(`territory "${territoryId}" polygon point ${index} must have numeric x and y.`);
    }
    const { x, y } = point as { x: number; y: number };
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      fail(`territory "${territoryId}" polygon point ${index} must be finite.`);
    }
    return { x, y };
  });
};

const validateTerritory = (value: unknown, index: number): MapTerritoryDefinition => {
  if (!isRecord(value)) {
    fail(`territory at index ${index} must be an object.`);
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    fail(`territory at index ${index} must have a non-empty string id.`);
  }
  const id = raw.id as string;

  if (typeof raw.name !== "string" || raw.name.length === 0) {
    fail(`territory "${id}" must have a non-empty name.`);
  }

  if (typeof raw.ownerId !== "string" || !VALID_TEAM_IDS.includes(raw.ownerId as TeamId)) {
    fail(`territory "${id}" has an invalid ownerId (expected one of ${VALID_TEAM_IDS.join(", ")}).`);
  }

  if (typeof raw.troops !== "number" || !Number.isInteger(raw.troops) || raw.troops < 0) {
    fail(`territory "${id}" must have a non-negative integer troop count.`);
  }

  if (!Array.isArray(raw.neighbors) || raw.neighbors.some((n) => typeof n !== "string")) {
    fail(`territory "${id}" must have a neighbors array of ids.`);
  }

  return {
    id,
    name: raw.name as string,
    ownerId: raw.ownerId as TeamId,
    troops: raw.troops as number,
    neighbors: raw.neighbors as string[],
    polygon: validatePolygon(raw.polygon, id),
  };
};

/**
 * Validate an untrusted map definition and turn it into a runtime `LoadedMap`.
 *
 * Beyond structural checks this enforces the invariants the simulation relies
 * on: unique ids, neighbor references that resolve, and **symmetric adjacency**
 * (if A borders B then B must border A). Catching asymmetric edges here means
 * the attack/conflict code never has to defend against half-connected maps.
 *
 * Throws an `Error` with a descriptive message on the first problem found.
 */
export const loadMap = (raw: unknown): LoadedMap => {
  if (!isRecord(raw)) {
    fail("map must be an object.");
  }
  const map = raw as Record<string, unknown>;

  if (typeof map.name !== "string" || map.name.length === 0) {
    fail("map must have a non-empty name.");
  }

  if (!Array.isArray(map.territories) || map.territories.length < MIN_TERRITORIES) {
    fail(`map must have at least ${MIN_TERRITORIES} territories.`);
  }

  const definitions = (map.territories as unknown[]).map(validateTerritory);

  const territories: Record<string, Territory> = {};
  const territoryOrder: string[] = [];
  for (const definition of definitions) {
    if (territories[definition.id]) {
      fail(`duplicate territory id "${definition.id}".`);
    }
    territories[definition.id] = {
      ...definition,
      neighbors: [...definition.neighbors],
      polygon: definition.polygon.map((point) => ({ ...point })),
      center: computeCenter(definition.polygon),
    };
    territoryOrder.push(definition.id);
  }

  // Relational checks once every id is known.
  for (const id of territoryOrder) {
    const territory = territories[id];
    for (const neighborId of territory.neighbors) {
      if (neighborId === id) {
        fail(`territory "${id}" lists itself as a neighbor.`);
      }
      const neighbor = territories[neighborId];
      if (!neighbor) {
        fail(`territory "${id}" references unknown neighbor "${neighborId}".`);
      }
      if (!neighbor.neighbors.includes(id)) {
        fail(`adjacency between "${id}" and "${neighborId}" is not symmetric.`);
      }
    }
  }

  return {
    name: map.name as string,
    territories,
    territoryOrder,
  };
};

export const definitionToLoadedMap = (definition: MapDefinition): LoadedMap => loadMap(definition);
