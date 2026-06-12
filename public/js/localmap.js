// Region generation: expands globe tiles into playable-scale landscapes.
//
// A "region" is one shared 2D frame (gnomonic tangent plane) anchored on the
// tile you entered, covering that tile and its 6 neighbors. Everything — the
// hex-cell lattice, the continuous terrain field, river crossings — lives in
// this single frame, so adjacent tile maps ("chunks") line up *exactly*:
// boundary vertices are computed from the same field at the same coordinates,
// and rivers meet at the exact shared edge midpoints stored on the globe.
//
// Chunks are generated lazily (fog of war): only when discovered.

import { hashSeed, mulberry32 } from './rng.js';
import { Simplex } from './noise.js';
import { classifyBiome } from './worldgen.js';
import { BIOMES, RESOURCES, hexToRgb, rgbStr, shade, mix } from './defs.js';

export const CELL = 10;                       // hex cell size (map units)
export const HEXW = Math.sqrt(3) * CELL;      // cell horizontal spacing
export const ROWH = 1.5 * CELL;               // cell row spacing
const GRID_R = 30;                            // cell rings per tile (roughly)
export const POLY_R = GRID_R * ROWH * 0.96;   // tile polygon radius (map units)

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

// world-seeded detail noise, shared by every region (continuity everywhere)
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

export function createRegion(world, anchorTile) {
  const { elevN, elevN2, moistN } = getDetail(world.seed);
  const sea = world.seaLevel;

  // ---- frame: gnomonic projection on the anchor's tangent plane ----
  const n = anchorTile.center;
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(n, ref));
  const v = cross3(n, u);
  const projRaw = (p3) => {
    const d = dot3(p3, n);
    return [dot3(p3, u) / d, dot3(p3, v) / d];
  };
  const maxR = Math.max(...anchorTile.corners.map((c) => {
    const [x, y] = projRaw(c);
    return Math.hypot(x, y);
  }));
  const K = POLY_R / maxR;
  const project = (p3) => {
    const [x, y] = projRaw(p3);
    return [x * K, y * K];
  };
  const to3D = (x, y) => norm3([
    n[0] + (x / K) * u[0] + (y / K) * v[0],
    n[1] + (x / K) * u[1] + (y / K) * v[1],
    n[2] + (x / K) * u[2] + (y / K) * v[2],
  ]);

  // ---- region tiles: anchor + ring1 (explorable); poles include ring2 ----
  const ring1 = anchorTile.neighbors.map((id) => world.tiles[id]);
  const ring2ids = new Set([anchorTile.id, ...anchorTile.neighbors]);
  for (const t of ring1) for (const nid of t.neighbors) ring2ids.add(nid);
  const poles = [...ring2ids].map((id) => {
    const t = world.tiles[id];
    const [cx, cy] = project(t.center);
    return { t, cx, cy };
  });

  const regionTiles = [anchorTile, ...ring1];
  const polys = new Map();
  for (const t of regionTiles) polys.set(t.id, t.corners.map(project));

  // per-tile terrain shapers (volcano cone, lake dish, oasis pond) — each is
  // zero at its tile's boundary, so the field stays continuous across edges
  const shapers = new Map();
  for (const { t, cx, cy } of poles) {
    const sh = {
      volcano: t.features.includes('volcano'),
      lake: t.biome === 'lake',
      oasis: t.features.includes('oasis'),
      cx, cy,
    };
    if (sh.oasis) {
      const aRng = mulberry32(hashSeed(world.seed + ':anchor:' + t.id));
      sh.oasisAt = [cx + (aRng() - 0.5) * POLY_R * 0.8, cy + (aRng() - 0.5) * POLY_R * 0.8];
    }
    if (sh.volcano || sh.lake || sh.oasis) shapers.set(t.id, sh);
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

  // nearest pole tile = owner (this is exactly the tile's polygon, since
  // Goldberg tiles are the Voronoi cells of their centers)
  function tileOf(x, y) {
    const p3 = to3D(x, y);
    let best = null, bd = -Infinity;
    for (const pole of poles) {
      const d = dot3(p3, pole.t.center);
      if (d > bd) { bd = d; best = pole.t; }
    }
    return best;
  }

  // ---- the continuous terrain field, valid across the whole region ----
  function sample(x, y) {
    const p3 = to3D(x, y);
    let sw = 0, e0 = 0, T0 = 0, m0 = 0;
    let owner = null, od = -Infinity;
    for (const pole of poles) {
      const dotc = dot3(p3, pole.t.center);
      if (dotc > od) { od = dotc; owner = pole.t; }
      const d = 1 - dotc + 1e-9;
      const w = 1 / (d * d);
      sw += w;
      e0 += w * pole.t.elev;
      T0 += w * pole.t.temp;
      m0 += w * pole.t.moist;
    }
    let e = e0 / sw
      + fbm(elevN, p3, 70, 4) * 0.05
      + fbm(elevN2, p3, 260, 2) * 0.018;

    const sh = shapers.get(owner.id);
    let lakeish = false;
    if (sh) {
      const dc = Math.hypot(x - sh.cx, y - sh.cy) / POLY_R;
      if (sh.volcano) {
        const cone = Math.max(0, 1 - dc * 2.1);
        e += cone * cone * 0.3;
        if (dc < 0.09) e -= 0.12; // crater
      }
      if (sh.lake) {
        e -= Math.max(0, 1 - dc * 1.5) * 0.5 * sea;
        lakeish = true;
      }
      if (sh.oasis) {
        const d = Math.hypot(x - sh.oasisAt[0], y - sh.oasisAt[1]);
        if (d < CELL * 2.4) {
          e = Math.min(e, sea - 0.015 - (1 - d / (CELL * 2.4)) * 0.01);
          lakeish = true;
        }
      }
    }

    const water = e < sea;
    const elevAbove = water ? 0 : (e - sea) / (1 - sea);
    const depth = water ? Math.min(1, (sea - e) / sea) : 0;
    const T = (T0 / sw) - (elevAbove - owner.elevAbove) * 10;
    const m = Math.max(0, Math.min(1, m0 / sw + fbm(moistN, p3, 90, 2) * 0.09));

    let biome;
    if (water) biome = lakeish ? 'lake' : depth > 0.25 ? 'ocean' : 'shallows';
    else if (e < sea + 0.012 && T > 2) biome = 'beach';
    else biome = classifyBiome(elevAbove, T, m);

    return { e, elevAbove, depth, water, temp: T, moist: m, biome, owner };
  }

  const cells = new Map();   // 'q,r' -> cell, region-wide
  const chunks = new Map();  // tileId -> chunk

  // ---- lazy chunk generation (one globe tile's worth of cells) ----
  function getChunk(tileId) {
    let chunk = chunks.get(tileId);
    if (chunk) return chunk;
    const tile = world.tiles[tileId];
    const t0 = performance.now();
    const rng = mulberry32(tile.seed);
    const [tcx, tcy] = project(tile.center);

    // cell bbox around the tile's polygon
    const poly = tile.corners.map(project);
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const minX = Math.min(...xs) - CELL, maxX = Math.max(...xs) + CELL;
    const minY = Math.min(...ys) - CELL, maxY = Math.max(...ys) + CELL;

    const chunkCells = [];
    const rMin = Math.floor(minY / ROWH), rMax = Math.ceil(maxY / ROWH);
    for (let r = rMin; r <= rMax; r++) {
      const qMin = Math.floor(minX / HEXW - r / 2), qMax = Math.ceil(maxX / HEXW - r / 2);
      for (let q = qMin; q <= qMax; q++) {
        const x = HEXW * (q + r / 2);
        const y = ROWH * r;
        if (tileOf(x, y).id !== tileId) continue; // strict Voronoi ownership
        const s = sample(x, y);
        const cell = {
          q, r, x, y, tid: tileId,
          elev: s.e, elevAbove: s.elevAbove, depth: s.depth, water: s.water,
          temp: Math.round(s.temp * 10) / 10, moist: s.moist,
          biome: s.biome,
          features: [],
          resource: null, river: false,
        };
        chunkCells.push(cell);
        cells.set(q + ',' + r, cell);
      }
    }
    const cellAt = (q, r) => {
      const c = cells.get(q + ',' + r);
      return c && c.tid === tileId ? c : null;
    };
    const cellNbrs = (c) => ADIRS.map(([dq, dr]) => cellAt(c.q + dq, c.r + dr)).filter(Boolean);

    // ---- per-cell features ----
    const isReef = tile.features.includes('reef');
    const isVolcano = tile.features.includes('volcano');
    const sh = shapers.get(tileId);
    for (const c of chunkCells) {
      if (c.water && c.temp < -6) c.features.push('sea_ice');
      if (isReef && c.water && c.depth < 0.2 && rng() < 0.2) c.features.push('reef');
      if (isVolcano && Math.hypot(c.x - tcx, c.y - tcy) / POLY_R < 0.14 && !c.water) c.features.push('volcano');
      if (sh?.oasis && !c.water &&
          Math.hypot(c.x - sh.oasisAt[0], c.y - sh.oasisAt[1]) < CELL * 4.5) {
        c.biome = 'jungle';
        c.features.push('oasis');
      }
    }

    // ---- rivers: enter/exit at the globe's shared edge midpoints ----
    // crossings are projections of the exact 3D edge midpoints, so this
    // chunk's river endpoint coincides with the neighbor chunk's endpoint
    const crossings = tile.riverN.map((d) => {
      const [x, y] = project(tile.edgeMid[d]);
      return { dir: d, x, y };
    });
    const rivers = []; // arrays of points {x,y} (crossing endpoints + cells)
    function nearestCell(x, y, pred = () => true) {
      let best = null, bd = Infinity;
      for (const c of chunkCells) {
        if (!pred(c)) continue;
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    }
    function carve(from, target, head, tail) {
      const path = [from];
      let cur = from;
      for (let step = 0; step < 500 && cur !== target; step++) {
        const nbrs = cellNbrs(cur);
        if (!nbrs.length) break;
        let best = null, bs = Infinity;
        for (const nc of nbrs) {
          if (path.includes(nc)) continue;
          const dist = Math.hypot(nc.x - target.x, nc.y - target.y);
          const wander = (mulberry32(nc.q * 73856093 ^ nc.r * 19349663 ^ tile.seed)() - 0.5) * 34;
          const s = dist + nc.elev * 120 + wander;
          if (s < bs) { bs = s; best = nc; }
        }
        if (!best) break;
        path.push(best);
        cur = best;
        if (cur.water || cur.river) break;
      }
      for (const c of path) {
        c.river = true;
        if (!c.water) {
          c.moist = Math.min(1, c.moist + 0.15);
          if (c.biome === 'desert') c.biome = 'savanna';
        }
      }
      const pts = path.map((c) => ({ x: c.x, y: c.y }));
      if (head) pts.unshift(head);   // exact shared-edge crossing point
      if (tail) pts.push(tail);
      return pts;
    }
    if (crossings.length) {
      const entry = nearestCell(crossings[0].x, crossings[0].y);
      let target = null, tailPt = null;
      if (crossings.length >= 2) {
        target = nearestCell(crossings[1].x, crossings[1].y);
        tailPt = { x: crossings[1].x, y: crossings[1].y };
      } else {
        target = nearestCell(tcx, tcy, (c) => c.water) ||
          chunkCells.reduce((a, b) => (b.elev < a.elev ? b : a));
      }
      if (entry && target) {
        rivers.push(carve(entry, target, { x: crossings[0].x, y: crossings[0].y }, tailPt));
      }
      for (let i = 2; i < crossings.length; i++) {
        const start = nearestCell(crossings[i].x, crossings[i].y);
        const join = nearestCell(start.x, start.y, (c) => c.river && c !== start);
        if (start && join) {
          rivers.push(carve(start, join, { x: crossings[i].x, y: crossings[i].y }, null));
        }
      }
    }

    // ---- trees & scatter features ----
    const TREE_DENSITY = { forest: 0.5, seasonal_forest: 0.5, jungle: 0.65, taiga: 0.45, swamp: 0.25, marsh: 0.15 };
    for (const c of chunkCells) {
      if (c.water || c.river) continue;
      const td = TREE_DENSITY[c.biome];
      if (td && rng() < td + 0.25) c.features.push('tree');
      else if (c.biome === 'desert' && rng() < 0.05) c.features.push('cactus');
      else if ((c.biome === 'mountain' || c.biome === 'peak') && rng() < 0.12) c.features.push('rocks');
      else if (c.features.includes('oasis') && rng() < 0.5) c.features.push('tree');
    }

    // ---- resource deposits ----
    for (const resId of tile.resources) {
      const water = WATER_RES.has(resId);
      const high = HIGH_RES.has(resId);
      let candidates = chunkCells.filter((c) =>
        !c.resource && c.water === water &&
        (!high || c.elevAbove > 0.25 || c.water));
      if (!candidates.length && water) candidates = chunkCells.filter((c) => !c.resource && c.river);
      if (!candidates.length) candidates = chunkCells.filter((c) => !c.resource);
      if (high) candidates = candidates.sort((a, b) => b.elev - a.elev).slice(0, Math.max(30, candidates.length >> 2));
      const count = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < count && candidates.length; i++) {
        const c = candidates.splice(Math.floor(rng() * candidates.length), 1)[0];
        c.resource = resId;
      }
    }

    // ---- fertility + colors ----
    const gauss = (xv, mu, sig) => Math.exp(-(((xv - mu) / sig) ** 2));
    for (const c of chunkCells) {
      const B = BIOMES[c.biome];
      let f = c.water
        ? B.fert + c.moist * 10
        : B.fert + (c.moist - 0.5) * 30 + gauss(c.temp, 18, 14) * 18 - c.elevAbove * 15 + (c.river ? 15 : 0);
      c.fertility = Math.round(Math.max(0, Math.min(100, f)));
      c.elevM = c.water ? Math.round(-c.depth * 5500) : Math.round(20 + c.elevAbove * 4800);
      colorCell(c, rng);
    }

    chunk = {
      tile, tileId,
      cells: chunkCells,
      poly, rivers, crossings,
      center: [tcx, tcy],
      flow: tile.flow,
      genMs: Math.round(performance.now() - t0),
    };
    chunks.set(tileId, chunk);
    return chunk;
  }

  return {
    world, sea,
    anchor: anchorTile,
    tiles: regionTiles,       // anchor + ring1 (explorable)
    polys,                    // tileId -> projected polygon
    project, to3D, sample, tileOf,
    cells, chunks, getChunk,
    discovered: new Set([anchorTile.id]),
    settlements: [],
    civs: [],
  };
}

// css/srgb color for a sampled point
export function sampleColor(s, jitter = 0) {
  let rgb;
  if (s.water && s.biome !== 'lake') {
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
