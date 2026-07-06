import type { River } from "./rivers.js";

/**
 * Strategic straits and canals for the real-world Earth maps.
 *
 * The strait problem is the mirror image of the river problem: rivers are
 * missing from the topography source entirely, while straits are *in* it but
 * too narrow to survive downsampling. Gibraltar is 14 km wide, the Bosporus
 * 1 km — at a 640-tile grid a tile is ~60 km, so the land-fraction vote closes
 * them and the Mediterranean, Black Sea, Baltic and Persian Gulf silently
 * become inland lakes. That destroys exactly the geography worth fighting
 * over: real-world naval strategy is about controlling these chokepoints.
 *
 * Each entry below is a short hand-authored `[lon, lat]` polyline running from
 * open water on one side, through the strait's midline, to open water on the
 * other side. They are carved with the same brush as rivers (`carveRivers` is
 * a hard land→water override), which guarantees a connected channel at every
 * grid size. On very fine grids where the strait already resolves naturally
 * the carve is a harmless no-op over existing water.
 *
 * Straits that are wide enough to survive every supported grid size (Sicily
 * ~145 km, Taiwan ~130 km, Korea ~200 km, Mozambique ~420 km) are deliberately
 * absent — they come free with the heightmap.
 *
 * Endpoint coordinates are validated by `tests/straits.test.ts`, which asserts
 * the seas these channels connect are classified as ocean (i.e. reachable from
 * the open sea) on the built Earth map.
 */
export const EARTH_STRAITS: readonly River[] = [
  // ── Canals ──────────────────────────────────────────────────────────────
  // Mediterranean → Port Said → Bitter Lakes → Suez, then on through the
  // narrow Gulf of Suez (itself only ~30 km wide, so it also needs the carve)
  // to the open Red Sea.
  {
    name: "Suez Canal",
    points: [[32.3, 31.6], [32.3, 31.25], [32.4, 30.4], [32.55, 29.95], [32.9, 29.1], [33.5, 28.4], [34.6, 27.0]],
  },
  // Caribbean → Colón → Gatún → Panama City → Pacific.
  {
    name: "Panama Canal",
    points: [[-79.8, 9.8], [-79.9, 9.35], [-79.7, 9.1], [-79.55, 8.95], [-79.3, 8.6]],
  },

  // ── Atlantic / Mediterranean / Black Sea ────────────────────────────────
  { name: "Strait of Gibraltar", points: [[-6.6, 35.9], [-5.6, 35.95], [-4.3, 36.0]] },
  // Aegean → Dardanelles → Sea of Marmara → Bosporus → Black Sea, as one
  // channel: the Marmara is barely a tile wide at coarse grids, so the whole
  // passage is carved together.
  {
    name: "Turkish Straits",
    points: [[25.1, 39.9], [26.2, 40.05], [26.75, 40.4], [27.6, 40.7], [28.6, 40.8], [29.05, 41.05], [29.15, 41.5]],
  },

  // ── Northern Europe ─────────────────────────────────────────────────────
  { name: "Strait of Dover", points: [[0.2, 50.2], [1.3, 50.7], [1.6, 51.1], [2.3, 51.8]] },
  // Kattegat → Øresund → western Baltic: the only way in or out of the Baltic.
  {
    name: "Danish Straits",
    points: [[11.6, 56.6], [12.5, 56.1], [12.75, 55.7], [12.85, 55.4], [13.2, 55.15], [14.2, 55.1]],
  },

  // ── Middle East ─────────────────────────────────────────────────────────
  // Persian Gulf around the Musandam peninsula into the Gulf of Oman.
  { name: "Strait of Hormuz", points: [[55.6, 26.7], [56.4, 26.65], [56.9, 26.2], [57.4, 25.6]] },
  // Red Sea → Gulf of Aden: the southern exit that makes Suez worth holding.
  { name: "Bab-el-Mandeb", points: [[42.8, 13.3], [43.3, 12.6], [43.7, 12.2], [44.3, 12.1]] },

  // ── Asia / Pacific ──────────────────────────────────────────────────────
  // Andaman Sea down the length of the strait to the Singapore Strait and out
  // into the South China Sea.
  {
    name: "Strait of Malacca",
    points: [[95.8, 6.3], [97.8, 5.2], [99.5, 4.0], [100.8, 2.9], [101.9, 1.95], [103.0, 1.35], [103.9, 1.15], [104.8, 1.6]],
  },
  // Java Sea → Indian Ocean between Sumatra and Java: the Malacca bypass.
  { name: "Sunda Strait", points: [[106.2, -5.5], [105.7, -6.0], [105.4, -6.4], [104.9, -6.9]] },
  // Bering Sea → Chukchi Sea: the amphibious shortcut between Asia and the
  // Americas.
  { name: "Bering Strait", points: [[-170.6, 64.4], [-169.0, 65.4], [-168.9, 65.9], [-168.0, 66.9]] },
];
