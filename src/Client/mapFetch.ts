import { GameMap } from "../Core/GameMap.js";

/**
 * Fetch a prebuilt terrain plane from the server and decode it into a
 * {@link GameMap}. One definition of the `/api/solo/map` wire layout
 * ([width u32 LE][height u32 LE][terrain bytes]) shared by the solo worker
 * and the lockstep replica worker, so a header change can't silently break
 * just one of them. Throws with a descriptive message on HTTP errors or a
 * body too short to carry the header — callers surface that instead of
 * constructing a garbage map.
 */
export const fetchPrebuiltMap = async (
  mapId?: string,
  mapToken?: string,
): Promise<{ map: GameMap; name: string }> => {
  // A map token (a running match's player-made map) wins over the catalogue id.
  const url = mapToken
    ? `/api/solo/map?token=${encodeURIComponent(mapToken)}`
    : mapId
      ? `/api/solo/map?id=${encodeURIComponent(mapId)}`
      : "/api/solo/map";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Map download failed: ${res.status} ${res.statusText} for ${url}.`);
  }
  const name = decodeURIComponent(res.headers.get("x-map-name") ?? "");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength < 8) {
    throw new Error(`Map download truncated: ${bytes.byteLength} bytes.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  return { map: new GameMap(width, height, bytes.subarray(8)), name };
};
