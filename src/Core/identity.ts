import { PLAYER_NAME_PATTERN } from "./messages.js";

/**
 * Player identity: a display name plus a chosen crest (flag or symbol emoji).
 *
 * The crest is the player's face on the homepage (lobby list, waiting room)
 * and in the match itself. In-game, names already flow everywhere a player is
 * shown (seats, nameplates, leaderboard), so rather than threading a second
 * field through every message and snapshot, a validated crest is simply
 * prefixed onto the display name server-side (`withCrest`). The client's
 * renderers then skip their auto-assigned per-id emoji whenever a name
 * already leads with a curated crest (`startsWithCrest`) — no double emoji.
 *
 * `PLAYER_NAME_PATTERN` only admits letters/digits/space/_.'- so a raw name
 * can never smuggle a fake crest past validation; only the server composes
 * crest + name.
 */

/** The crests a player may pick: flags, beasts, and war symbols. */
export const CRESTS: readonly string[] = [
  // Flags
  "🇩🇪", "🇺🇸", "🇬🇧", "🇫🇷", "🇪🇸", "🇮🇹", "🇵🇱", "🇺🇦",
  "🇹🇷", "🇧🇷", "🇦🇷", "🇲🇽", "🇨🇦", "🇦🇺", "🇯🇵", "🇰🇷",
  "🇨🇳", "🇮🇳", "🇷🇺", "🇸🇪", "🇳🇴", "🇳🇱", "🇨🇭", "🇦🇹",
  "🇬🇷", "🇵🇹", "🇪🇬", "🇿🇦", "🇳🇬", "🇸🇦", "🇮🇩", "🇻🇳",
  // Beasts
  "🦁", "🐺", "🦅", "🐉", "🐻", "🦈", "🦊", "🐍",
  "🐅", "🦏", "🐊", "🦂", "🦉", "🐗", "🦬", "🐙",
  // War symbols
  "⚔️", "🛡️", "👑", "🏴‍☠️", "🔱", "⚜️", "🎖️", "💀",
];

/** Fallback crest when a player never picked one. */
export const DEFAULT_CREST = "⚔️";

/** Runtime guard: is `value` one of the curated crests? */
export const isValidCrest = (value: unknown): value is string =>
  typeof value === "string" && CRESTS.includes(value);

/** Validate a display name against the shared player-name rules. */
export const isValidPlayerName = (value: unknown): value is string =>
  typeof value === "string" && PLAYER_NAME_PATTERN.test(value);

/** Compose the in-game display name: a validated crest prefixed to the name. */
export const withCrest = (name: string, crest?: string): string =>
  crest && isValidCrest(crest) ? `${crest} ${name}` : name;

/**
 * Whether a display name already leads with a curated crest — renderers use
 * this to skip their auto-assigned per-player-id emoji for such players.
 */
export const startsWithCrest = (name: string): boolean =>
  CRESTS.some((crest) => name.startsWith(`${crest} `));
