/**
 * Seeded pseudo-random number generator for the simulation — the same
 * *mechanism* OpenFront uses for its combat randomness (its `PseudoRandom` is
 * a splitmix32-seeded sfc32 stream; both are standard public-domain
 * algorithms, implemented here from their published definitions).
 *
 * OpenFront's engine is deterministic too: every consumer owns a PRNG with a
 * game-state seed (each `AttackExecution` seeds a fixed `123`, a nuke blast
 * seeds the current tick, …), so identical inputs replay identically. This
 * module lets this engine draw randomness the exact same way — sequential
 * draws from seeded streams — instead of approximating it with per-call
 * integer hashes. All state is 32-bit integer math, so streams are identical
 * across platforms, and there is no `Math.random`/wall-clock anywhere.
 */
export class Prng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // Expand the (32-bit-truncated) numeric seed into four sfc32 state words
    // with splitmix32, then warm the stream up so low-entropy seeds (small or
    // sequential integers — ticks, tile refs) diffuse before the first draw.
    let h = seed | 0;
    const split = (): number => {
      h = (h + 0x9e3779b9) | 0;
      let t = h ^ (h >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      return (t ^ (t >>> 15)) | 0;
    };
    this.s0 = split();
    this.s1 = split();
    this.s2 = split();
    this.s3 = split();
    for (let i = 0; i < 12; i += 1) this.next();
  }

  /** Next draw in [0, 1). */
  next(): number {
    const t = (((this.s0 + this.s1) | 0) + this.s3) | 0;
    this.s3 = (this.s3 + 1) | 0;
    this.s0 = this.s1 ^ (this.s1 >>> 9);
    this.s1 = (this.s2 + (this.s2 << 3)) | 0;
    this.s2 = ((this.s2 << 21) | (this.s2 >>> 11)) + t | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Random integer in [min, max) — max is exclusive, as in OpenFront's `nextInt`. */
  nextInt(min: number, max: number): number {
    const lo = Math.floor(min);
    const hi = Math.floor(max);
    return Math.floor(this.next() * (hi - lo)) + lo;
  }

  /** True with probability `p` (0..1). OpenFront's `chance(odds)` is `p = 1/odds`. */
  roll(p: number): boolean {
    return this.next() < p;
  }
}
