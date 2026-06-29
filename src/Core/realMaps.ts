import { GameMap } from "./GameMap.js";
import { buildTerrainFromMask } from "./terrainBuilder.js";
import { IMPASSABLE_MAGNITUDE } from "./terrainCodec.js";

/**
 * Hand-authored maps based on real-world geography.
 *
 * OpenFront's appeal is recognisable real coastlines, so instead of only
 * procedural noise we ship maps drawn from actual landmasses. Each map is an
 * ASCII landmask — one character per tile — which keeps the data human-editable
 * and dependency-free while still going through the exact same finishing
 * pipeline (coast/ocean/lake/depth) as the procedural generator.
 *
 * Legend (per character):
 *   '#'  passable land (low elevation)
 *   '+'  passable highland (raised elevation — costlier to capture)
 *   '^'  impassable mountain (solid rock: not ownable, blocks expansion)
 *   '~'  river / inland water (drawn explicitly for readability)
 *   any other character (space, '.') is open water
 *
 * Rivers ('~') are just water: narrow ones become crossable straits for the
 * amphibious-landing mechanic, so a river is a soft defensive line rather than a
 * wall. Trailing whitespace on a row is treated as open water, so the source art
 * does not need padding; a row longer than the width is an authoring error.
 */
export interface RealMapDefinition {
  /** Stable id used to select the map (e.g. via `RASTER_MAP`). */
  id: string;
  /** Human-readable name shown in the UI. */
  name: string;
  /** Tiles per row. Every art row (trimmed of trailing water) must fit. */
  width: number;
  /** Number of rows. Must equal `rows.length`. */
  height: number;
  /** ASCII landmask, one string per row. */
  rows: string[];
}

/** Elevation assigned to a plain '#' land tile. */
const LAND_ELEVATION = 3;
/** Elevation assigned to a '+' highland tile. */
const HIGHLAND_ELEVATION = 16;

/** Build a fully-classified {@link GameMap} from a real-world ASCII landmask. */
export const buildRealMap = (def: RealMapDefinition): GameMap => {
  const { width, height, rows } = def;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Real map "${def.id}" has invalid dimensions ${width}x${height}.`);
  }
  if (rows.length !== height) {
    throw new Error(`Real map "${def.id}" declares height ${height} but has ${rows.length} rows.`);
  }

  const size = width * height;
  const land = new Uint8Array(size);
  const elevation = new Uint8Array(size);

  for (let y = 0; y < height; y += 1) {
    // Trailing whitespace is always open water (identical to right-padding), so
    // trim it — that keeps hand-authored art forgiving. Leading water matters
    // and is preserved.
    const row = rows[y].replace(/\s+$/, "");
    if (row.length > width) {
      throw new Error(`Real map "${def.id}" row ${y} is ${row.length} chars, exceeding width ${width}.`);
    }
    for (let x = 0; x < row.length; x += 1) {
      const ch = row[x];
      const i = y * width + x;
      if (ch === "#") {
        land[i] = 1;
        elevation[i] = LAND_ELEVATION;
      } else if (ch === "+") {
        land[i] = 1;
        elevation[i] = HIGHLAND_ELEVATION;
      } else if (ch === "^") {
        land[i] = 1;
        elevation[i] = IMPASSABLE_MAGNITUDE;
      }
      // '~' and any other character (including the implicit right-padding) stay
      // water and are classified downstream as ocean or lake.
    }
  }

  return buildTerrainFromMask({ width, height, land, elevation });
};

// ---------------------------------------------------------------------------
// Map data. Coarse but recognisable — peninsulas, islands, straits and rivers
// are placed so the sea-crossing mechanic has narrow gaps to hop across.
// ---------------------------------------------------------------------------

/**
 * The Mediterranean basin: Europe to the north, North Africa to the south, with
 * Iberia, the Italian boot, the Balkans/Greece and Anatolia framing a central
 * sea dotted with islands. The Nile cuts north through Africa and a short river
 * notches western Europe; the Alps and Atlas add impassable highland. Island
 * chains keep every landmass within sea-crossing range, so a single player can
 * conquer the whole basin by hopping the straits.
 */
const MEDITERRANEAN: RealMapDefinition = {
  id: "mediterranean",
  name: "Mediterranean",
  width: 60,
  height: 32,
  rows: [
    "          ########          ##############          ####",
    "       ##############     ###################      ######",
    "      #################  #######################   #######",
    "  ##########################################################",
    " #######################^^^#################################",
    " #########   ##~#########^#################################",
    "  #######     #~#########################################",
    "   #####       ~######## ####  #########################",
    "    ####        ######          ###  ###  ##############",
    "    ###          ####            #    #    ###  #######",
    "     ##           ##  ##                        ####",
    "     #             # ####                        ##",
    "                     ###",
    "         ##          ###          ##",
    "        ####          #          ####          ###",
    "         ##                       ##          #####",
    "                   ##                          ###",
    "                  ####         ##",
    "                   ##         ####        ###",
    "                    #         ##         #####       ##",
    "          ##                  #          ###        ####",
    "                                                     ##",
    "                         ##",
    "       ###############   ##    #############",
    "     ##########################################~########",
    "   ############################################~##########",
    "  #############################################~############",
    "  #############################################~############",
    "   ############################################~###########",
    "    ########^^^################################~##########",
    "      #######^#################################~########",
    "        #######################################~######",
  ],
};

/**
 * A stylised world map: the six continents in roughly their real positions,
 * separated by oceans far wider than the sea-crossing range. The Amazon,
 * Mississippi and Nile thread the continents and the Andes, Rockies and
 * Himalaya raise impassable spines. Most fronts stay continental; islands are
 * the places naval expansion opens up.
 */
const WORLD: RealMapDefinition = {
  id: "world",
  name: "World",
  width: 72,
  height: 36,
  rows: [
    "      ####                              ####",
    "    ##########          ##            ########  ###    ####",
    "   ##############     ####           ###############  ######  ##",
    "  ###^############   ##      ##      #######################  ####",
    "  ###^##~##########        ####    ##############################",
    "   ##^##~#########        ######    #################################",
    "    #^##~########          ####      #####~##########################",
    "     ^##~#######                      ####~#######^^#############",
    "      ##~######            ##          ###~#######^^############",
    "       #~######          ####           ##~#######^##########  ##",
    "        #######           ##             #~###########  ####",
    "         #####                            ~########   ###",
    "          ###                              #####    ##  ##",
    "           #                                ###   ####",
    "          ##                                 #   ###",
    "         ####                                   ###",
    "         #####                                 ##",
    "          #####         #                                  ##",
    "           ####^       ###",
    "            ###^##    ###",
    "             ##^##   ####                              ####",
    "              #^########                              ######",
    "              #^~~~~~~#               ##              ####",
    "               ^######               ####",
    "               ^#####                #####",
    "               ^####                 ####",
    "               ^###                  ###                ##",
    "               ^##                    #             #########",
    "                ##                                  ###########",
    "                ##                                   #########",
    "                 #                                     #####",
    "",
    "",
    "        ###                                              ###",
    "      #######                                          #######",
    "    ###########                                      ###########",
  ],
};

/** All registered real-world maps, keyed by id. */
export const REAL_MAPS: ReadonlyMap<string, RealMapDefinition> = new Map(
  [MEDITERRANEAN, WORLD].map((m) => [m.id, m]),
);

/** Default real map used when none is explicitly requested. */
export const DEFAULT_REAL_MAP_ID = MEDITERRANEAN.id;

/** Look up a real map definition by id, or `undefined` if unknown. */
export const getRealMap = (id: string): RealMapDefinition | undefined => REAL_MAPS.get(id);
