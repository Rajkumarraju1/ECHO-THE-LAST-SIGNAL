export interface SeededRng {
  nextUint32(): number;
  nextInt(maxExclusive: number): number;
}

/** Deterministic scenario RNG. Server-only seed use keeps variation reproducible. */
export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return {
    nextUint32() {
      state += 0x6d2b79f5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return (value ^ (value >>> 14)) >>> 0;
    },
    nextInt(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("maxExclusive must be positive.");
      return this.nextUint32() % maxExclusive;
    }
  };
}
