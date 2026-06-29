/**
 * Map asset build tool: turn an arbitrary real-world heightmap PNG into the
 * canonical grayscale asset the server downsamples at runtime.
 *
 * The game derives its large, real-world maps from a committed equirectangular
 * topology raster (`assets/maps/earth-topo.png`, ocean = 0, land = elevation).
 * This script is how you (re)generate or replace that raster from any source
 * heightmap — e.g. a higher-resolution NASA/GEBCO/Natural Earth export, or a
 * different projection/crop — without pulling in an image-library dependency:
 * it decodes the source with the same in-tree PNG decoder the server uses,
 * optionally downsamples it (area-average) to bound the committed file size,
 * and re-encodes a clean 8-bit grayscale PNG.
 *
 * Usage:
 *   tsx scripts/buildMap.ts --in <source.png> --out earth-topo.png [--max-width 2048]
 *
 * The source may be grayscale or RGB (RGB is collapsed to luminance). Output is
 * written under assets/maps/. The runtime then crops/downsamples this asset to
 * the configured grid size (see src/Server/heightmapMaps.ts), so the asset only
 * needs to be at least as wide as the largest map you intend to play.
 */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { decodePngToGray, type DecodedGray } from "../src/Server/pngDecode.js";

// ---- CRC32 (PNG chunk checksums) -----------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
};

/** Encode an 8-bit grayscale plane to a valid PNG (filter 0 on every row). */
const encodeGrayPng = (width: number, height: number, gray: Uint8Array): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale

  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter type None
    gray.subarray(y * width, (y + 1) * width).forEach((v, x) => {
      raw[y * (width + 1) + 1 + x] = v;
    });
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Area-average downsample of a grayscale plane to at most `maxWidth` wide. */
const downsample = (src: DecodedGray, maxWidth: number): DecodedGray => {
  if (src.width <= maxWidth) return src;
  const width = maxWidth;
  const height = Math.max(1, Math.round((src.height * width) / src.width));
  const gray = new Uint8Array(width * height);
  for (let ty = 0; ty < height; ty += 1) {
    const sy0 = Math.floor((ty / height) * src.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) / height) * src.height));
    for (let tx = 0; tx < width; tx += 1) {
      const sx0 = Math.floor((tx / width) * src.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) / width) * src.width));
      let sum = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          sum += src.gray[sy * src.width + sx];
          count += 1;
        }
      }
      gray[ty * width + tx] = Math.round(sum / count);
    }
  }
  return { width, height, gray };
};

// ---- CLI ------------------------------------------------------------------
const parseArgs = (argv: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) out[arg.slice(2)] = argv[i + 1] ?? "";
  }
  return out;
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error("Usage: tsx scripts/buildMap.ts --in <source.png> --out <name.png> [--max-width 2048]");
    process.exit(1);
  }
  const maxWidth = Number(args["max-width"] ?? 2048) || 2048;

  const decoded = decodePngToGray(new Uint8Array(readFileSync(args.in)));
  const resampled = downsample(decoded, maxWidth);

  let land = 0;
  for (const v of resampled.gray) if (v > 0) land += 1;

  const assetsDir = fileURLToPath(new URL("../assets/maps/", import.meta.url));
  mkdirSync(assetsDir, { recursive: true });
  const outPath = fileURLToPath(new URL(`../assets/maps/${args.out}`, import.meta.url));
  writeFileSync(outPath, encodeGrayPng(resampled.width, resampled.height, resampled.gray));

  console.log(`Wrote ${args.out}: ${resampled.width}x${resampled.height}, ` +
    `${((land / resampled.gray.length) * 100).toFixed(1)}% land (value > 0).`);
};

main();
