import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodePngToGray } from "../src/Server/pngDecode.js";

/** Paeth predictor, mirrored from the decoder, for building test scanlines. */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

/** Build a chunk: 4-byte length + 4-byte type + data + 4-byte (zeroed) CRC. */
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
};

/**
 * Encode an 8-bit grayscale image to PNG bytes, applying a chosen filter type
 * per row so the test exercises every unfilter branch (the CRC is left zero —
 * the decoder skips it).
 */
const encodeGrayPng = (width: number, height: number, pixels: number[], filters: number[]): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  // 10,11,12 = compression, filter, interlace = 0

  const raw: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y];
    raw.push(filter);
    for (let x = 0; x < width; x += 1) {
      const orig = pixels[y * width + x];
      const a = x > 0 ? pixels[y * width + x - 1] : 0;
      const b = y > 0 ? pixels[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? pixels[(y - 1) * width + x - 1] : 0;
      let filt: number;
      switch (filter) {
        case 0: filt = orig; break;
        case 1: filt = orig - a; break;
        case 2: filt = orig - b; break;
        case 3: filt = orig - ((a + b) >> 1); break;
        case 4: filt = orig - paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      raw.push(filt & 0xff);
    }
  }

  const idat = deflateSync(Buffer.from(raw));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
};

test("decodePngToGray reconstructs pixels across all filter types", () => {
  const width = 4;
  const height = 5;
  const pixels = [
    10, 20, 30, 40,
    5, 50, 100, 200,
    255, 1, 128, 64,
    0, 99, 17, 240,
    33, 66, 132, 7,
  ];
  const filters = [0, 1, 2, 3, 4]; // None, Sub, Up, Average, Paeth
  const png = encodeGrayPng(width, height, pixels, filters);

  const decoded = decodePngToGray(new Uint8Array(png));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Array.from(decoded.gray), pixels);
});

test("decodePngToGray rejects a non-PNG buffer", () => {
  assert.throws(() => decodePngToGray(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /Not a PNG/);
});

test("decodePngToGray decodes the committed earth heightmap asset", () => {
  const path = fileURLToPath(new URL("../assets/maps/earth-topo.png", import.meta.url));
  const decoded = decodePngToGray(new Uint8Array(readFileSync(path)));
  assert.equal(decoded.width, 2048);
  assert.equal(decoded.height, 1024);

  // Ocean reads as 0; a high mountain reads bright. (Mid-Pacific vs Himalaya.)
  const sample = (lat: number, lon: number): number => {
    const x = Math.floor(((lon + 180) / 360) * decoded.width) % decoded.width;
    const y = Math.min(decoded.height - 1, Math.floor(((90 - lat) / 180) * decoded.height));
    return decoded.gray[y * decoded.width + x];
  };
  assert.equal(sample(0, -140), 0, "mid-Pacific should be ocean (0)");
  assert.ok(sample(28, 87) > 150, "Himalaya should be high terrain");
});
