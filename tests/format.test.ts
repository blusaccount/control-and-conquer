import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCount, formatDuration, formatRate, formatTroopRate, formatTroops } from "../src/Client/format.js";

test("formatCount keeps values under a thousand raw", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(-42), "-42");
  assert.equal(formatCount(999.4), "999");
});

test("formatCount tiers decimals per magnitude with uppercase suffixes", () => {
  // Below 10 of the unit: two decimals.
  assert.equal(formatCount(1234), "1.23K");
  assert.equal(formatCount(5000), "5.00K");
  assert.equal(formatCount(1_250_000), "1.25M");
  // Below 100 of the unit: one decimal.
  assert.equal(formatCount(19_595), "19.6K");
  assert.equal(formatCount(25_000_000), "25.0M");
  // At or above 100 of the unit: whole numbers.
  assert.equal(formatCount(123_456), "123K");
  assert.equal(formatCount(750_000), "750K");
  assert.equal(formatCount(250_000_000), "250M");
  // Billions.
  assert.equal(formatCount(2_500_000_000), "2.50B");
  // Negative values keep the same tiering.
  assert.equal(formatCount(-19_595), "-19.6K");
});

test("formatCount promotes values that round past their unit", () => {
  assert.equal(formatCount(999_950), "1.00M", "not 1000K");
  assert.equal(formatCount(999_950_000), "1.00B", "not 1000M");
});

test("formatRate keeps small rates readable and reuses the compact notation", () => {
  assert.equal(formatRate(0.4), "0.4");
  assert.equal(formatRate(42), "42");
  assert.equal(formatRate(19_595), "19.6K");
});

test("formatTroops renders at OpenFront's display scale (manpower ÷ 10)", () => {
  // OpenFront's client shows troops/10 (`renderTroops`): a fresh human's
  // 25,000 starting manpower reads "2.5K" on the real openfront.io.
  assert.equal(formatTroops(25_000), "2.50K");
  assert.equal(formatTroops(115_000), "11.5K");
  assert.equal(formatTroops(394_000), "39.4K");
  assert.equal(formatTroops(682), "68");
  // The per-second rate scales the same way.
  assert.equal(formatTroopRate(3_270), "327");
});

test("formatDuration renders m:ss", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(600), "10:00");
});
