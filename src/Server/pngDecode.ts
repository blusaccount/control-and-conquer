import { inflateSync } from "node:zlib";

/**
 * Minimal, dependency-free PNG decoder for the map pipeline.
 *
 * We only ever decode our own committed heightmap assets, so this intentionally
 * supports just the subset those use: 8-bit, non-interlaced, colour types
 * grayscale / RGB / RGBA (palette and 16-bit are rejected with a clear error).
 * Output is a single grayscale plane — for RGB sources we collapse to luminance,
 * which is what a height/topology map encodes anyway.
 *
 * Keeping this in-tree (over a dependency like `pngjs`) preserves the project's
 * zero-runtime-dependency property and keeps map building deterministic: the
 * decode is pure byte math with no platform-specific image library involved.
 */
export interface DecodedGray {
  width: number;
  height: number;
  /** Length `width*height`, row-major, one luminance byte (0..255) per pixel. */
  gray: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Paeth predictor (PNG filter type 4). */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

/** Decode an 8-bit PNG buffer into a single grayscale plane. */
export const decodePngToGray = (buffer: Uint8Array): DecodedGray => {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buffer[i] !== PNG_SIGNATURE[i]) throw new Error("Not a PNG file (bad signature).");
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset < buffer.length) {
    const length = view.getUint32(offset);
    const type =
      String.fromCharCode(buffer[offset + 4], buffer[offset + 5], buffer[offset + 6], buffer[offset + 7]);
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === "IDAT") {
      idatChunks.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // skip data + CRC
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8 is supported).`);
  if (interlace !== 0) throw new Error("Interlaced PNGs are not supported.");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`Unsupported PNG colour type ${colorType}.`);

  const idat = idatChunks.length === 1 ? idatChunks[0] : Buffer.concat(idatChunks);
  const raw = inflateSync(idat);

  const bpp = channels; // bytes per pixel at 8-bit depth
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) {
    throw new Error("PNG data is shorter than declared dimensions.");
  }

  // Unfilter scanlines in place into a tightly packed pixel buffer.
  const pixels = new Uint8Array(stride * height);
  let rawPos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawPos];
    rawPos += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawPos + x];
      const a = x >= bpp ? pixels[rowStart + x - bpp] : 0; // left
      const b = y > 0 ? pixels[prevStart + x] : 0; // up
      const c = y > 0 && x >= bpp ? pixels[prevStart + x - bpp] : 0; // up-left
      let recon: number;
      switch (filter) {
        case 0: recon = value; break;
        case 1: recon = value + a; break;
        case 2: recon = value + b; break;
        case 3: recon = value + ((a + b) >> 1); break;
        case 4: recon = value + paeth(a, b, c); break;
        default: throw new Error(`Unsupported PNG filter type ${filter}.`);
      }
      pixels[rowStart + x] = recon & 0xff;
    }
    rawPos += stride;
  }

  // Collapse to a single grayscale plane (luminance for colour sources).
  const gray = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const base = p * bpp;
    if (channels === 1 || channels === 2) {
      gray[p] = pixels[base];
    } else {
      const r = pixels[base];
      const g = pixels[base + 1];
      const bl = pixels[base + 2];
      gray[p] = (r * 77 + g * 150 + bl * 29) >> 8; // ~Rec.601 luminance
    }
  }

  return { width, height, gray };
};
