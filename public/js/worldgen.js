// Procedural planet generation on a Goldberg sphere. Deterministic per seed.
// Pipeline: elevation (3D noise on the sphere, naturally seamless) -> sea
// level -> temperature/moisture -> rivers & lakes -> biomes -> features ->
// fertility -> resources.

import { hashSeed, mulberry32, tileSeed } from './rng.js';
import { Simplex } from './noise.js';
import { buildGoldberg } from './sphere.js';
import {
  BIOMES, RESOURCES, HILL_MINERALS, fertilityLevel, elevationLevel,
  hexToRgb, rgbStr, shade, mix,
} from './defs.js';

const WATER_FRACTION = 0.60;

// Land biome from elevation-above-sea (0..1), temperature (°C), moisture (0..1).
// Shared with the local tile-map generator so both levels of detail agree.
export function classifyBiome(a, T, m) {
  if (a > 0.82) return 'peak';
  if (a > 0.62) return 'mountain';
  if (T < -12) return m > 0.5 ? 'glacier' : 'snow';
  if (T < -2) return m > 0.5 ? 'taiga' : 'tundra';
  if (T < 6) return m < 0.25 ? 'steppe' : m < 0.55 ? 'grassland' : 'taiga';
  if (T < 16) {
    if (a < 0.1 && m > 0.8) return 'swamp';
    return m < 0.2 ? 'steppe' : m < 0.45 ? 'plains' : m < 0.7 ? 'forest' : 'seasonal_forest';
  }
  if (a < 0.1 && m > 0.78) return 'marsh';
  return m < 0.22 ? 'desert' : m < 0.45 ? 'savanna' : m < 0.65 ? 'seasonal_forest' : 'jungle';
}

function pickWeighted(rng, entries) {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng() * total;
  for (const e of entries) {
    r -= e[1];
    if (r <= 0) return e[0];
  }
  return entries[entries.length - 1][0];
}

export function generateWorld(seed, freq = 24) {
  const t0 = performance.now();
  const mesh = buildGoldberg(freq);
  const N = mesh.tiles.length;

  const elevN = new Simplex(mulberry32(hashSeed(seed + ':elev')));
  const detailN = new Simplex(mulberry32(hashSeed(seed + ':detail')));
  const ridgeN = new Simplex(mulberry32(hashSeed(seed + ':ridge')));
  const tempN = new Simplex(mulberry32(hashSeed(seed + ':temp')));
  const moistN = new Simplex(mulberry32(hashSeed(seed + ':moist')));
  const rng = mulberry32(hashSeed(seed + ':world'));

  const sample = (n, p, f) => n.noise3(p[0] * f, p[1] * f, p[2] * f);
  function fbm(n, p, f, octaves) {
    let v = 0, amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      v += amp * sample(n, p, f);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return v / norm; // ~[-1, 1]
  }

  // ---- elevation field ----
  const elev = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const p = mesh.tiles[i].center;
    const cont = fbm(elevN, p, 1.2, 4);                 // continents
    const det = fbm(detailN, p, 3.4, 5);                // local detail
    const ridge = 1 - Math.abs(fbm(ridgeN, p, 2.3, 4)); // mountain ridges
    elev[i] = 0.55 * cont + 0.28 * det + 0.17 * (ridge * 2 - 1);
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N; i++) { if (elev[i] < mn) mn = elev[i]; if (elev[i] > mx) mx = elev[i]; }
  for (let i = 0; i < N; i++) elev[i] = (elev[i] - mn) / (mx - mn);
  const sorted = Float64Array.from(elev).sort();
  const seaLevel = sorted[Math.floor(WATER_FRACTION * N)];

  // ---- tiles with climate ----
  const tiles = new Array(N);
  for (let i = 0; i < N; i++) {
    const m = mesh.tiles[i];
    const p = m.center;
    const latRad = Math.asin(Math.max(-1, Math.min(1, p[1])));
    const lonRad = Math.atan2(p[2], p[0]);
    const absLat = Math.abs(latRad) / (Math.PI / 2); // 0 equator .. 1 pole
    const eq = 1 - absLat;
    const dryBand = 0.32 * Math.exp(-(((absLat - 0.3) / 0.18) ** 2));

    const e = elev[i];
    const water = e < seaLevel;
    const elevAbove = water ? 0 : (e - seaLevel) / (1 - seaLevel);
    const depth = water ? (seaLevel - e) / seaLevel : 0;

    let temp = -16 + eq * 51 + fbm(tempN, p, 2.0, 3) * 7;
    if (!water) temp -= elevAbove * 26;

    let moist = (fbm(moistN, p, 1.8, 4) + 1) / 2;
    moist = moist * 0.8 + eq * 0.2 - dryBand;
    moist = Math.max(0, Math.min(1, moist));

    tiles[i] = {
      id: i,
      center: p, corners: m.corners, neighbors: m.neighbors, edgeMid: m.edgeMid,
      pentagon: m.neighbors.length === 5,
      seed: tileSeed(seed, i, m.neighbors.length),
      elev: e, elevAbove, depth, water,
      lat: Math.round((latRad * 180) / Math.PI),
      lon: Math.round((lonRad * 180) / Math.PI),
      temp, moist,
      biome: null, features: [], riverN: [], flow: 0,
      resources: [],
    };
  }

  // ---- rivers (downhill from springs to the sea; per-edge, reciprocal) ----
  const springCount = Math.round(N / 140);
  const springs = [];
  for (const t of tiles) {
    if (!t.water && t.elevAbove > 0.42 && t.moist > 0.35) springs.push(t);
  }
  for (let s = 0; s < springCount && springs.length; s++) {
    let cur = springs[Math.floor(rng() * springs.length)];
    if (cur.flow > 0) continue;
    const visited = new Set();
    for (let step = 0; step < 600; step++) {
      visited.add(cur.id);
      cur.flow++;
      let best = null, bestIdx = -1, bestElev = Infinity;
      for (let d = 0; d < cur.neighbors.length; d++) {
        const nt = tiles[cur.neighbors[d]];
        if (nt.elev < bestElev) { bestElev = nt.elev; best = nt; bestIdx = d; }
      }
      if (!best || (bestElev >= cur.elev && !best.water)) {
        // depression: form a lake and stop
        cur.water = true;
        cur.biome = 'lake';
        cur.depth = 0.05;
        cur.elevAbove = 0;
        break;
      }
      cur.riverN.push(bestIdx);
      best.riverN.push(best.neighbors.indexOf(cur.id));
      if (best.water || visited.has(best.id)) {
        best.flow++;
        break;
      }
      const merging = best.flow > 0;
      cur = best;
      if (merging) {
        cur.flow++;
        break;
      }
    }
  }

  for (const t of tiles) {
    t.riverN = [...new Set(t.riverN)];
    if (t.riverN.length && !t.water) t.features.push('river');
  }
  for (const t of tiles) {
    if (t.water) continue;
    let boost = 0;
    if (t.features.includes('river')) boost += 0.15;
    for (const nid of t.neighbors) {
      const nt = tiles[nid];
      if (nt.biome === 'lake' || nt.riverN.length) { boost += 0.05; break; }
    }
    t.moist = Math.min(1, t.moist + boost);
  }

  // ---- biomes ----
  for (const t of tiles) {
    if (t.biome === 'lake') continue;
    if (t.water) {
      t.biome = t.depth > 0.45 ? 'deep_ocean' : t.depth > 0.12 ? 'ocean' : 'shallows';
      if (t.temp < -6) t.features.push('sea_ice');
      continue;
    }
    t.biome = classifyBiome(t.elevAbove, t.temp, t.moist);
  }

  // ---- features ----
  for (const t of tiles) {
    if (!t.water && t.elevAbove < 0.08 && t.temp > 2 &&
        !['swamp', 'marsh'].includes(t.biome)) {
      for (const nid of t.neighbors) {
        const nt = tiles[nid];
        if (nt.water && nt.biome !== 'lake') { t.biome = 'beach'; break; }
      }
    }
    if (t.biome === 'shallows' && t.temp > 16 && rng() < 0.07) t.features.push('reef');
    if (t.biome === 'desert' && rng() < 0.03) t.features.push('oasis');
    if ((t.biome === 'mountain' || t.biome === 'peak') && rng() < 0.03) t.features.push('volcano');
    if (!t.water && t.elevAbove > 0.62 && t.temp < 2) t.features.push('snowcap');
    if (['forest', 'seasonal_forest', 'jungle', 'taiga'].includes(t.biome)) t.features.push('forest');
  }

  // ---- fertility, labels, colors, resources ----
  const gauss = (x, mu, sig) => Math.exp(-(((x - mu) / sig) ** 2));
  for (const t of tiles) {
    const B = BIOMES[t.biome];
    let f;
    if (t.water) {
      f = B.fert + t.moist * 10;
    } else {
      f = B.fert + (t.moist - 0.5) * 30 + gauss(t.temp, 18, 14) * 18 - t.elevAbove * 15;
      if (t.features.includes('river')) f += 15;
      if (t.features.includes('oasis')) f += 30;
      if (t.features.includes('volcano')) f += 20;
    }
    t.fertility = Math.round(Math.max(0, Math.min(100, f)));
    t.fertLevel = fertilityLevel(t.fertility);
    t.elevM = t.water
      ? Math.round(-t.depth * 5500)
      : Math.round(20 + t.elevAbove * 4800);
    t.elevLevel = elevationLevel(t);
    t.temp = Math.round(t.temp * 10) / 10;

    const trng = mulberry32(t.seed);
    const cand = B.res.map(([id, w]) => [id, w]);
    if (t.features.includes('river')) {
      cand.push(['fish', 3], ['clay', 2]);
      cand.push(t.temp > 14 ? ['rice', 2] : ['reeds', 1]);
    }
    if (t.features.includes('oasis')) cand.push(['dates', 6], ['citrus', 2]);
    if (t.features.includes('reef')) cand.push(['pearls', 4], ['fish', 3], ['crabs', 2]);
    if (t.features.includes('volcano')) cand.push(['obsidian', 4], ['sulfur', 3], ['geothermal', 2], ['gems', 1]);
    if (!t.water && t.elevAbove > 0.3 && t.elevAbove <= 0.62 && trng() < 0.45) {
      cand.push(...HILL_MINERALS.map(([id, w]) => [id, w]));
    }
    const roll = trng();
    let count = roll < 0.07 ? 0 : roll < 0.5 ? 1 : roll < 0.85 ? 2 : 3;
    while (count-- > 0 && cand.length) {
      const id = pickWeighted(trng, cand);
      if (!t.resources.includes(id)) t.resources.push(id);
      for (let i = cand.length - 1; i >= 0; i--) if (cand[i][0] === id) cand.splice(i, 1);
    }

    computeColors(t, trng);
    t.icon = pickIcon(t);
  }

  // ---- stats ----
  const stats = { seed, N, water: 0, rivers: 0, biomes: {} };
  for (const t of tiles) {
    if (t.water) stats.water++;
    if (t.features.includes('river')) stats.rivers++;
    stats.biomes[t.biome] = (stats.biomes[t.biome] || 0) + 1;
  }
  stats.waterPct = Math.round((stats.water / N) * 100);
  stats.genMs = Math.round(performance.now() - t0);

  return { seed, tiles, seaLevel, stats };
}

function computeColors(t, trng) {
  let rgb = hexToRgb(BIOMES[t.biome].color);
  if (t.water && t.biome !== 'lake') {
    const deep = hexToRgb(BIOMES.deep_ocean.color);
    const shallow = hexToRgb(BIOMES.shallows.color);
    rgb = mix(shallow, deep, Math.min(1, t.depth * 1.6));
    if (t.features.includes('sea_ice')) rgb = mix(rgb, [225, 238, 246], 0.75);
  } else if (!t.water) {
    rgb = shade(rgb, t.elevAbove * 0.22);
    if (t.features.includes('snowcap')) rgb = mix(rgb, [235, 242, 248], 0.6);
    if (t.features.includes('volcano')) rgb = mix(rgb, [96, 70, 64], 0.5);
    if (t.features.includes('oasis')) rgb = mix(rgb, [110, 170, 90], 0.45);
  }
  rgb = shade(rgb, (trng() - 0.5) * 0.07);
  const side = shade(rgb, -0.4);
  t.color = rgbStr(rgb);                       // css, for the info panel
  // sRGB -> linear for WebGL vertex colors (three renders in sRGB output)
  const lin = (c) => Math.pow(c / 255, 2.2);
  t.rgbF = [lin(rgb[0]), lin(rgb[1]), lin(rgb[2])];
  t.sideF = [lin(side[0]), lin(side[1]), lin(side[2])];
}

function pickIcon(t) {
  if (t.features.includes('volcano')) return '🌋';
  if (t.resources.length) return RESOURCES[t.resources[0]].i;
  if (t.features.includes('forest')) return t.biome === 'jungle' ? '🌴' : '🌲';
  return null;
}
