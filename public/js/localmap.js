// Local tile-map generation: expands one globe tile into a playable-scale
// landscape. Deterministic from the tile's seed + the world seed.
//
// Two layers:
// - `sample(x, y)` — a continuous terrain field (elevation/climate/biome/
//   color at any point), used by the 3D landscape renderer.
// - `cells` — a hex-cell data layer sampled from the same field, carrying
//   gameplay data (features, resource deposits, fertility) and info panels.
//
// Cohesion guarantees:
// - Terrain attributes are interpolated from this tile + its neighbors and
//   detailed with noise fields that are continuous across the whole sphere,
//   so coastlines/biomes flow smoothly toward adjacent tile maps.
// - Rivers enter/exit exactly at the shared edge midpoints stored on the
//   globe, so they connect with the neighboring tile's map.

import { hashSeed, mulberry32 } from './rng.js';
import { Simplex } from './noise.js';
import { classifyBiome } from './worldgen.js';
import { BIOMES, RESOURCES, hexToRgb, rgbStr, shade, mix } from './defs.js';

export const CELL = 10;                       // hex cell size (map units)
export const HEXW = Math.sqrt(3) * CELL;      // cell horizontal spacing
export const ROWH = 1.5 * CELL;               // cell row spacing
const GRID_R = 30;                            // cell rings to cover the tile
export const POLY_R = GRID_R * ROWH * 0.96;   // target polygon radius (map units)

// axial hex neighbors (pointy-top): E, NE, NW, W, SW, SE
const ADIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

const WATER_RES = new Set(['fish', 'crabs', 'whales', 'pearls', 'kelp']);
const HIGH_RES = new Set(['stone', 'marble', 'copper', 'tin', 'iron', 'coal', 'gold',
  'silver', 'gems', 'lapis', 'lead', 'nickel', 'bauxite', 'platinum', 'uranium',
  'sulfur', 'saltpeter', 'obsidian', 'geothermal']);

const norm3 = (p) => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
};
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// world-seeded detail noise, shared by every tile (continuity across edges)
let detail = null;
function getDetail(worldSeed) {
  if (!detail || detail.seed !== worldSeed) {
    detail = {
      seed: worldSeed,
      elevN: new Simplex(mulberry32(hashSeed(worldSeed + ':lelev'))),
      elevN2: new Simplex(mulberry32(hashSeed(worldSeed + ':lelev2'))),
      moistN: new Simplex(mulberry32(hashSeed(worldSeed + ':lmoist'))),
    };
  }
  return detail;
}

export function generateLocalMap(world, tile) {
  const t0 = performance.now();
  const rng = mulberry32(tile.seed);
  const { elevN, elevN2, moistN } = getDetail(world.seed);
  const sea = world.seaLevel;

  // ---- tangent plane projection (map 2D <-> sphere) ----
  const n = tile.center;
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(n, ref));
  const v = cross3(n, u);
  const rawCorners = tile.corners.map((c) => [dot3(c, u), dot3(c, v)]);
  const maxR = Math.max(...rawCorners.map(([x, y]) => Math.hypot(x, y)));
  const K = POLY_R / maxR; // map units per tangent unit
  const poly = rawCorners.map(([x, y]) => [x * K, y * K]);
  const to3D = (x, y) => norm3([
    n[0] + (x / K) * u[0] + (y / K) * v[0],
    n[1] + (x / K) * u[1] + (y / K) * v[1],
    n[2] + (x / K) * u[2] + (y / K) * v[2],
  ]);

  // ---- interpolation poles: this tile + neighbors (IDW on the sphere) ----
  const poles = [tile, ...tile.neighbors.map((id) => world.tiles[id])];
  function interp(p3) {
    let sw = 0, e = 0, T = 0, m = 0;
    for (const pt of poles) {
      const d = 1 - dot3(p3, pt.center) + 1e-9;
      const w = 1 / (d * d);
      sw += w;
      e += w * pt.elev;
      T += w * pt.temp;
      m += w * pt.moist;
    }
    return { e: e / sw, T: T / sw, m: m / sw };
  }

  const fbm = (nz, p, f, oct) => {
    let val = 0, amp = 1, normAmp = 0;
    for (let o = 0; o < oct; o++) {
      val += amp * nz.noise3(p[0] * f, p[1] * f, p[2] * f);
      normAmp += amp;
      amp *= 0.5;
      f *= 2;
    }
    return val / normAmp;
  };

  // ---- deterministic feature anchors (independent of cell-loop rng order) ----
  const isVolcano = tile.features.includes('volcano');
  const isOasis = tile.features.includes('oasis');
  const isLake = tile.biome === 'lake';
  const anchorRng = mulberry32(hashSeed(world.seed + ':anchor:' + tile.id));
  const oasisAt = [(anchorRng() - 0.5) * POLY_R * 0.8, (anchorRng() - 0.5) * POLY_R * 0.8];

  // ---- the continuous terrain field ----
  function sample(x, y) {
    const p3 = to3D(x, y);
    const base = interp(p3);
    let e = base.e
      + fbm(elevN, p3, 70, 4) * 0.05
      + fbm(elevN2, p3, 260, 2) * 0.018;

    const dc = Math.hypot(x, y) / POLY_R; // 0 center .. ~1 edge
    if (isVolcano) {
      const cone = Math.max(0, 1 - dc * 2.1);
      e += cone * cone * 0.3;
      if (dc < 0.09) e -= 0.12; // crater
    }
    if (isLake) e -= Math.max(0, 1 - dc * 1.5) * 0.5 * sea;
    if (isOasis) {
      const d = Math.hypot(x - oasisAt[0], y - oasisAt[1]);
      if (d < CELL * 2.4) e = Math.min(e, sea - 0.015 - (1 - d / (CELL * 2.4)) * 0.01);
    }

    const water = e < sea;
    const elevAbove = water ? 0 : (e - sea) / (1 - sea);
    const depth = water ? Math.min(1, (sea - e) / sea) : 0;
    const T = base.T - (elevAbove - tile.elevAbove) * 10;
    const m = Math.max(0, Math.min(1, base.m + fbm(moistN, p3, 90, 2) * 0.09));

    let biome;
    if (water) biome = (isLake || isOasis) ? 'lake' : depth > 0.25 ? 'ocean' : 'shallows';
    else if (e < sea + 0.012 && T > 2) biome = 'beach';
    else biome = classifyBiome(elevAbove, T, m);

    return { e, elevAbove, depth, water, temp: T, moist: m, biome };
  }

  // ---- hex-cell data layer ----
  const cells = [];
  const byKey = new Map();
  for (let q = -GRID_R - 2; q <= GRID_R + 2; q++) {
    for (let r = -GRID_R - 2; r <= GRID_R + 2; r++) {
      const x = HEXW * (q + r / 2);
      const y = ROWH * r;
      if (!pointInPoly(x, y, poly)) continue;
      const s = sample(x, y);
      const cell = {
        q, r, x, y,
        elev: s.e, elevAbove: s.elevAbove, depth: s.depth, water: s.water,
        temp: Math.round(s.temp * 10) / 10, moist: s.moist,
        biome: s.biome,
        features: [],
        resource: null, river: false,
      };
      cells.push(cell);
      byKey.set(q + ',' + r, cell);
    }
  }
  const cellAt = (q, r) => byKey.get(q + ',' + r);
  const cellNbrs = (c) => ADIRS.map(([dq, dr]) => cellAt(c.q + dq, c.r + dr)).filter(Boolean);

  // ---- per-cell features ----
  const isReef = tile.features.includes('reef');
  for (const c of cells) {
    if (c.water && c.temp < -6) c.features.push('sea_ice');
    if (isReef && c.water && c.depth < 0.2 && rng() < 0.2) c.features.push('reef');
    if (isVolcano && Math.hypot(c.x, c.y) / POLY_R < 0.14 && !c.water) c.features.push('volcano');
    if (isOasis && !c.water &&
        Math.hypot(c.x - oasisAt[0], c.y - oasisAt[1]) < CELL * 4.5) {
      c.biome = 'jungle';
      c.features.push('oasis');
    }
  }

  // ---- rivers: enter/exit at the globe's shared edge midpoints ----
  const crossings = tile.riverN.map((d) => {
    const mid = tile.edgeMid[d];
    const x = dot3(mid, u) * K, y = dot3(mid, v) * K;
    return { dir: d, x, y, p3: mid };
  });
  const rivers = [];
  function nearestCell(x, y, pred = () => true) {
    let best = null, bd = Infinity;
    for (const c of cells) {
      if (!pred(c)) continue;
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  function carve(from, target) {
    const path = [from];
    let cur = from;
    for (let step = 0; step < 400 && cur !== target; step++) {
      const nbrs = cellNbrs(cur);
      if (!nbrs.length) break;
      let best = null, bs = Infinity;
      for (const nc of nbrs) {
        if (path.includes(nc)) continue;
        const dist = Math.hypot(nc.x - target.x, nc.y - target.y);
        // wander: deterministic per-cell jitter makes rivers meander instead
        // of running straight at the target
        const wander = (mulberry32(nc.q * 73856093 ^ nc.r * 19349663 ^ tile.seed)() - 0.5) * 34;
        const s = dist + nc.elev * 120 + wander;
        if (s < bs) { bs = s; best = nc; }
      }
      if (!best) break;
      path.push(best);
      cur = best;
      if (cur.water || cur.river) break; // reached sea/lake or merged
    }
    for (const c of path) {
      c.river = true;
      if (!c.water) {
        c.moist = Math.min(1, c.moist + 0.15);
        if (c.biome === 'desert') c.biome = 'savanna'; // river banks aren't bare sand
      }
    }
    return path;
  }
  if (crossings.length) {
    const entry = nearestCell(crossings[0].x, crossings[0].y);
    let target;
    if (crossings.length >= 2) {
      target = nearestCell(crossings[1].x, crossings[1].y);
    } else {
      target = nearestCell(0, 0, (c) => c.water) ||
        cells.reduce((a, b) => (b.elev < a.elev ? b : a));
    }
    if (entry && target) rivers.push(carve(entry, target));
    for (let i = 2; i < crossings.length; i++) {
      const start = nearestCell(crossings[i].x, crossings[i].y);
      const join = nearestCell(start.x, start.y, (c) => c.river && c !== start);
      if (start && join) rivers.push(carve(start, join));
    }
  }

  // ---- trees & scatter features ----
  const TREE_DENSITY = { forest: 0.5, seasonal_forest: 0.5, jungle: 0.65, taiga: 0.45, swamp: 0.25, marsh: 0.15 };
  for (const c of cells) {
    if (c.water || c.river) continue;
    const td = TREE_DENSITY[c.biome];
    if (td && rng() < td + 0.25) c.features.push('tree'); // landscapes want dense woods
    else if (c.biome === 'desert' && rng() < 0.05) c.features.push('cactus');
    else if ((c.biome === 'mountain' || c.biome === 'peak') && rng() < 0.12) c.features.push('rocks');
    else if (c.features.includes('oasis') && rng() < 0.5) c.features.push('tree');
  }

  // ---- resource deposits ----
  for (const resId of tile.resources) {
    const water = WATER_RES.has(resId);
    const high = HIGH_RES.has(resId);
    let candidates = cells.filter((c) =>
      !c.resource && c.water === water &&
      (!high || c.elevAbove > 0.25 || c.water));
    if (!candidates.length && water) candidates = cells.filter((c) => !c.resource && c.river);
    if (!candidates.length) candidates = cells.filter((c) => !c.resource);
    if (high) candidates = candidates.sort((a, b) => b.elev - a.elev).slice(0, Math.max(30, candidates.length >> 2));
    const count = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < count && candidates.length; i++) {
      const c = candidates.splice(Math.floor(rng() * candidates.length), 1)[0];
      c.resource = resId;
    }
  }

  // ---- fertility + colors ----
  const gauss = (xv, mu, sig) => Math.exp(-(((xv - mu) / sig) ** 2));
  for (const c of cells) {
    const B = BIOMES[c.biome];
    let f = c.water
      ? B.fert + c.moist * 10
      : B.fert + (c.moist - 0.5) * 30 + gauss(c.temp, 18, 14) * 18 - c.elevAbove * 15 + (c.river ? 15 : 0);
    c.fertility = Math.round(Math.max(0, Math.min(100, f)));
    c.elevM = c.water ? Math.round(-c.depth * 5500) : Math.round(20 + c.elevAbove * 4800);
    colorCell(c, rng);
  }

  return {
    tileId: tile.id,
    tile,
    sample,            // continuous terrain field for the landscape renderer
    sea,
    cells, byKey, poly, rivers,
    crossings,         // {dir, x, y, p3} — p3 is the exact shared edge midpoint
    genMs: Math.round(performance.now() - t0),
  };
}

// css/srgb color for a sampled point (vertex colors handle linear conversion)
export function sampleColor(s, jitter = 0) {
  let rgb;
  if (s.water && s.biome !== 'lake') {
    // seabed: sandy shallows fading to deep blue
    rgb = mix([196, 178, 128], [16, 38, 64], Math.min(1, s.depth * 2.2));
  } else if (s.water) {
    rgb = mix([150, 142, 110], [24, 52, 70], Math.min(1, s.depth * 4));
  } else {
    rgb = hexToRgb(BIOMES[s.biome].color);
    rgb = shade(rgb, s.elevAbove * 0.25);
  }
  if (jitter) rgb = shade(rgb, jitter);
  return rgb;
}

function colorCell(c, rng) {
  let rgb = sampleColor(c);
  if (c.features.includes('sea_ice')) rgb = mix(rgb, [225, 238, 246], 0.7);
  if (c.features.includes('reef')) rgb = mix(rgb, [120, 200, 190], 0.4);
  if (c.features.includes('volcano')) rgb = mix(rgb, [70, 52, 48], 0.55);
  rgb = shade(rgb, (rng() - 0.5) * 0.08);
  c.color = rgbStr(rgb);
}

export function cellIcon(c) {
  if (c.resource) return RESOURCES[c.resource].i;
  if (c.features.includes('tree')) return c.biome === 'jungle' ? '🌴' : c.biome === 'taiga' ? '🌲' : '🌳';
  if (c.features.includes('cactus')) return '🌵';
  if (c.features.includes('rocks')) return '🪨';
  return null;
}
