/**
 * Compact number formatting for the HUD, leaderboard and stats screens.
 *
 * Pure helpers (no DOM) so the exact display format is unit-testable. The
 * count format mirrors OpenFront's: uppercase "K"/"M"/"B" suffixes with a
 * tiered number of decimals per magnitude — 2 decimals while the scaled value
 * is below 10 (e.g. "1.23K"), 1 below 100 ("19.6K"), none above ("196K") —
 * so figures stay the same visual width as an empire grows.
 */

/**
 * Compact integer formatting for large counts (troops, gold, tiles):
 * 1234 → "1.23K", 19595 → "19.6K", 196000 → "196K", 1_250_000 → "1.25M".
 * Values that round up past their unit (999_950) promote to the next one
 * ("1.00M" rather than "1000K").
 */
export const formatCount = (n: number): string => {
  const v = Math.round(n);
  if (Math.abs(v) < 1000) return String(v);
  let unit = 1_000;
  let suffix = "K";
  if (Math.abs(v) >= 1_000_000_000) {
    unit = 1_000_000_000;
    suffix = "B";
  } else if (Math.abs(v) >= 1_000_000) {
    unit = 1_000_000;
    suffix = "M";
  }
  const scaled = v / unit;
  const abs = Math.abs(scaled);
  const decimals = abs < 10 ? 2 : abs < 100 ? 1 : 0;
  const text = scaled.toFixed(decimals);
  // Rounding can carry the scaled value to 1000 of its unit ("1000K"); render
  // it in the next unit instead. B is the largest unit, so it never promotes.
  if (Math.abs(Number(text)) >= 1000 && suffix !== "B") {
    return formatCount(Math.sign(v) * unit * 1000);
  }
  return `${text}${suffix}`;
};

/**
 * Format a per-second rate compactly: large rates use the compact notation
 * (K/M/B); small early-game rates keep one decimal so they don't read as
 * "+0/s".
 */
export const formatRate = (rate: number): string =>
  rate >= 1000 ? formatCount(rate) : rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);

/** Format whole seconds as m:ss for the match timer and stats screen. */
export const formatDuration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};
