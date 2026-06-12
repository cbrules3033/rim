// Seeded RNG utilities — deterministic across runs for a given seed string.

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  h += h << 13; h ^= h >>> 7;
  h += h << 3;  h ^= h >>> 17;
  h += h << 5;
  return h >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic per-tile seed, so a tile can later be expanded into a full
// playable map that always generates the same way.
export function tileSeed(worldSeed, col, row) {
  return hashSeed(`${worldSeed}:${col},${row}`);
}

const SYL = ['ka', 'zor', 'rim', 'tha', 'vel', 'un', 'dra', 'mo', 'qui', 'lex',
  'ar', 'ten', 'bel', 'os', 'nia', 'gul', 'fer', 'wyn', 'ash', 'tor'];

export function randomSeed() {
  const n = 2 + Math.floor(Math.random() * 2);
  let s = '';
  for (let i = 0; i < n; i++) s += SYL[Math.floor(Math.random() * SYL.length)];
  return s + '-' + Math.floor(Math.random() * 1000);
}
