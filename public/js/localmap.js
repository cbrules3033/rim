// Region & chunk generation: expands globe tiles into playable landscapes.
//
// CANONICAL GENERATION: every tile's chunk (cells, rivers, forests, resource
// deposits) is generated exactly once, in the tile's own canonical tangent
// frame, from the world seed + tile seed. Regions (the view you get when you
// enter a tile) merely RE-PROJECT canonical chunks into the anchor tile's
// frame. So a tile discovered from a neighbor is the *same tile* you get by
// entering it from the globe — same content, guaranteed.
//
// The terrain field itself is a pure function of position on the sphere:
// inverse-distance interpolation of tile attributes with a smooth distance
// cutoff (so the contributing tile set never causes seams), plus detail noise
// fields that are continuous across the whole planet.

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
const clamp1 = (x) => Math.max(-1, Math.min(1, x));

// ---------- canonical tangent frames ----------

const basisCache = new WeakMap(); // tile -> {n,u,v,K,S}
function tileBasis(tile) {
  let b = basisCache.get(tile);
  if (b) return b;
  const n = tile.center;
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(n, ref));
  const v = cross3(n, u);
  let maxR = 0, maxAngle = 0;
  for (const c of tile.corners) {
    const d = dot3(c, n);
    maxR = Math.max(maxR, Math.hypot(dot3(c, u) / d, dot3(c, v) / d));
    maxAngle = Math.max(maxAngle, Math.acos(clamp1(d)));
  }
  const K = POLY_R / maxR;          // gnomonic scale: map units per tangent unit
  const S = POLY_R / maxAngle;      // map units per radian (for angular distances)
  b = { n, u, v, K, S };
  basisCache.set(tile, b);
  return b;
}

function projWith(b, p3) {
  const d = dot3(p3, b.n);
  return [(dot3(p3, b.u) / d) * b.K, (dot3(p3, b.v) / d) * b.K];
}
function to3DWith(b, x, y) {
  return norm3([
    b.n[0] + (x / b.K) * b.u[0] + (y / b.K) * b.v[0],
    b.n[1] + (x / b.K) * b.u[1] + (y / b.K) * b.v[1],
    b.n[2] + (x / b.K) * b.u[2] + (y / b.K) * b.v[2],
  ]);
}

// ---------- canonical terrain field (per world) ----------

const fieldCache = new WeakMap(); // world -> field
function getField(world) {
  let field = fieldCache.get(world);
  if (field) return field;

  const seed = world.seed;
  const elevN = new Simplex(mulberry32(hashSeed(seed + ':lelev')));
  const elevN2 = new Simplex(mulberry32(hashSeed(seed + ':lelev2')));
  const moistN = new Simplex(mulberry32(hashSeed(seed + ':lmoist')));
  const sea = world.seaLevel;

  // tile spacing & smooth IDW cutoff (canonical: depends on geometry only)
  const t0 = world.tiles[0];
  const d0 = Math.acos(clamp1(dot3(t0.center, world.tiles[t0.neighbors[0]].center)));
  const D = 2.4 * d0;

  // contributing tiles: graph distance <= 3 from the owner. The smooth cutoff
  // zeroes anything near/beyond D, and tiles outside this set are always
  // beyond D, so the field is independent of the set choice (= seam-free).
  const poleCache = new Map();
  function polesOf(tile) {
    let p = poleCache.get(tile.id);
    if (p) return p;
    const seen = new Set([tile.id]);
    let frontier = [tile.id];
    for (let ring = 0; ring < 3; ring++) {
      const next = [];
      for (const id of frontier) {
        for (const nid of world.tiles[id].neighbors) {
          if (!seen.has(nid)) {
            seen.add(nid);
            next.push(nid);
          }
        }
      }
      frontier = next;
    }
    p = [...seen].map((id) => world.tiles[id]);
    poleCache.set(tile.id, p);
    return p;
  }

  // nearest tile (sphere Voronoi = the Goldberg polygon) via greedy climb
  function ownerOf(p3, hint) {
    let cur = hint || t0;
    for (;;) {
      let best = cur, bd = dot3(p3, cur.center);
      for (const nid of cur.neighbors) {
        const t = world.tiles[nid];
        const d = dot3(p3, t.center);
        if (d > bd) { bd = d; best = t; }
      }
      if (best === cur) return cur;
      cur = best;
    }
  }

  // per-tile feature shapers (volcano cone, lake dish, oasis pond), all in
  // canonical/angular terms so they're frame-independent; each is zero at its
  // tile's boundary so the field stays continuous
  const shaperCache = new Map();
  function shaperOf(tile) {
    if (shaperCache.has(tile.id)) return shaperCache.get(tile.id);
    let sh = null;
    const volcano = tile.features.includes('volcano');
    const lake = tile.biome === 'lake';
    const oasis = tile.features.includes('oasis');
    if (volcano || lake || oasis) {
      const b = tileBasis(tile);
      sh = { volcano, lake, oasis, b };
      if (oasis) {
        const aRng = mulberry32(hashSeed(seed + ':anchor:' + tile.id));
        sh.oasisXY = [(aRng() - 0.5) * POLY_R * 0.8, (aRng() - 0.5) * POLY_R * 0.8];
        sh.oasisP3 = to3DWith(b, sh.oasisXY[0], sh.oasisXY[1]);
      }
    }
    shaperCache.set(tile.id, sh);
    return sh;
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

  function sampleAt(p3, hint) {
    const owner = ownerOf(p3, hint);
    let sw = 0, e0 = 0, T0 = 0, m0 = 0, a0 = 0;
    for (const pt of polesOf(owner)) {
      const theta = Math.acos(clamp1(dot3(p3, pt.center)));
      if (theta >= D) continue;
      const cut = (1 - (theta / D) ** 2) ** 2;
      const w = cut / (theta * theta + 1e-12);
      sw += w;
      e0 += w * pt.elev;
      T0 += w * pt.temp;
      m0 += w * pt.moist;
      a0 += w * pt.elevAbove;
    }
    let e = e0 / sw
      + fbm(elevN, p3, 70, 4) * 0.05
      + fbm(elevN2, p3, 260, 2) * 0.018;

    const sh = shaperOf(owner);
    let lakeish = false;
    if (sh) {
      const dc = Math.acos(clamp1(dot3(p3, owner.center))) * sh.b.S / POLY_R;
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
        const d = Math.acos(clamp1(dot3(p3, sh.oasisP3))) * sh.b.S;
        if (d < CELL * 2.4) {
          e = Math.min(e, sea - 0.015 - (1 - d / (CELL * 2.4)) * 0.01);
          lakeish = true;
        }
      }
    }

    const water = e < sea;
    const elevAbove = water ? 0 : (e - sea) / (1 - sea);
    const depth = water ? Math.min(1, (sea - e) / sea) : 0;
    const T = (T0 / sw) - (elevAbove - a0 / sw) * 10;
    const m = Math.max(0, Math.min(1, m0 / sw + fbm(moistN, p3, 90, 2) * 0.09));

    let biome;
    if (water) biome = lakeish ? 'lake' : depth > 0.25 ? 'ocean' : 'shallows';
    else if (e < sea + 0.012 && T > 2) biome = 'beach';
    else biome = classifyBiome(elevAbove, T, m);

    return { e, elevAbove, depth, water, temp: T, moist: m, biome, owner };
  }

  field = { sea, sampleAt, ownerOf, shaperOf };
  fieldCache.set(world, field);
  return field;
}

// ---------- canonical chunks (per world+tile, generated once) ----------

const chunkCache = new WeakMap(); // world -> Map(tileId -> chunk)
export function getCanonChunk(world, tile) {
  let perWorld = chunkCache.get(world);
  if (!perWorld) {
    perWorld = new Map();
    chunkCache.set(world, perWorld);
  }
  let chunk = perWorld.get(tile.id);
  if (chunk) return chunk;

  const field = getField(world);
  const b = tileBasis(tile);
  const rng = mulberry32(tile.seed);

  const poly = tile.corners.map((c) => projWith(b, c));
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const minX = Math.min(...xs) - CELL, maxX = Math.max(...xs) + CELL;
  const minY = Math.min(...ys) - CELL, maxY = Math.max(...ys) + CELL;

  // ---- cells on the tile's canonical lattice ----
  const cells = [];
  const byKey = new Map();
  const rMin = Math.floor(minY / ROWH), rMax = Math.ceil(maxY / ROWH);
  for (let r = rMin; r <= rMax; r++) {
    const qMin = Math.floor(minX / HEXW - r / 2), qMax = Math.ceil(maxX / HEXW - r / 2);
    for (let q = qMin; q <= qMax; q++) {
      const x = HEXW * (q + r / 2);
      const y = ROWH * r;
      const p3 = to3DWith(b, x, y);
      if (field.ownerOf(p3, tile).id !== tile.id) continue; // strict Voronoi
      const s = field.sampleAt(p3, tile);
      const cell = {
        q, r, x, y, p3, tid: tile.id,
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
  const cellAt = (q, r) => byKey.get(q + ',' + r) || null;
  const cellNbrs = (c) => ADIRS.map(([dq, dr]) => cellAt(c.q + dq, c.r + dr)).filter(Boolean);

  // ---- per-cell features ----
  const isReef = tile.features.includes('reef');
  const isVolcano = tile.features.includes('volcano');
  const sh = field.shaperOf(tile);
  for (const c of cells) {
    if (c.water && c.temp < -6) c.features.push('sea_ice');
    if (isReef && c.water && c.depth < 0.2 && rng() < 0.2) c.features.push('reef');
    if (isVolcano && Math.hypot(c.x, c.y) / POLY_R < 0.14 && !c.water) c.features.push('volcano');
    if (sh?.oasis && !c.water &&
        Math.hypot(c.x - sh.oasisXY[0], c.y - sh.oasisXY[1]) < CELL * 4.5) {
      c.biome = 'jungle';
      c.features.push('oasis');
    }
  }

  // ---- rivers: enter/exit at the globe's shared edge midpoints ----
  const crossings = tile.riverN.map((d) => {
    const p3 = tile.edgeMid[d];
    const [x, y] = projWith(b, p3);
    return { dir: d, x, y, p3 };
  });
  const rivers = []; // arrays of points {x, y, p3}
  function nearestCell(x, y, pred = () => true) {
    let best = null, bd = Infinity;
    for (const c of cells) {
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
    const pts = path.map((c) => ({ x: c.x, y: c.y, p3: c.p3 }));
    if (head) pts.unshift(head);
    if (tail) pts.push(tail);
    return pts;
  }
  if (crossings.length) {
    const entry = nearestCell(crossings[0].x, crossings[0].y);
    let target = null, tailPt = null;
    if (crossings.length >= 2) {
      target = nearestCell(crossings[1].x, crossings[1].y);
      tailPt = crossings[1];
    } else {
      target = nearestCell(0, 0, (c) => c.water) ||
        cells.reduce((a, b2) => (b2.elev < a.elev ? b2 : a));
    }
    if (entry && target) rivers.push(carve(entry, target, crossings[0], tailPt));
    for (let i = 2; i < crossings.length; i++) {
      const start = nearestCell(crossings[i].x, crossings[i].y);
      const join = nearestCell(start.x, start.y, (c) => c.river && c !== start);
      if (start && join) rivers.push(carve(start, join, crossings[i], null));
    }
  }

  // ---- trees & scatter features ----
  const TREE_DENSITY = { forest: 0.5, seasonal_forest: 0.5, jungle: 0.65, taiga: 0.45, swamp: 0.25, marsh: 0.15 };
  for (const c of cells) {
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
    let candidates = cells.filter((c) =>
      !c.resource && c.water === water &&
      (!high || c.elevAbove > 0.25 || c.water));
    if (!candidates.length && water) candidates = cells.filter((c) => !c.resource && c.river);
    if (!candidates.length) candidates = cells.filter((c) => !c.resource);
    if (high) candidates = candidates.sort((a, b2) => b2.elev - a.elev).slice(0, Math.max(30, candidates.length >> 2));
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

  chunk = {
    tile, tileId: tile.id,
    cells, byKey, rivers, crossings,
    flow: tile.flow,
  };
  perWorld.set(tile.id, chunk);
  return chunk;
}

// ---------- regions: a view of canonical chunks in the anchor's frame ----------

export function createRegion(world, anchorTile) {
  const field = getField(world);
  const b = tileBasis(anchorTile);
  const project = (p3) => projWith(b, p3);
  const to3D = (x, y) => to3DWith(b, x, y);

  const ring1 = anchorTile.neighbors.map((id) => world.tiles[id]);
  const regionTiles = [anchorTile, ...ring1];
  const polys = new Map();
  for (const t of regionTiles) polys.set(t.id, t.corners.map(project));

  let lastOwner = anchorTile;
  const sample = (x, y) => {
    const s = field.sampleAt(to3D(x, y), lastOwner);
    lastOwner = s.owner;
    return s;
  };
  const tileOf = (x, y) => {
    lastOwner = field.ownerOf(to3D(x, y), lastOwner);
    return lastOwner;
  };

  // world-level persistent state (shared by ALL regions of this world)
  world.discovered = world.discovered || new Set();
  world.settlements = world.settlements || [];
  world.civs = world.civs || [];

  // localized (region-frame) projections of canonical chunks
  const localCache = new Map();
  function localChunk(tileId) {
    let lc = localCache.get(tileId);
    if (lc) return lc;
    const canon = getCanonChunk(world, world.tiles[tileId]);
    const cells = canon.cells.map((c) => {
      const [x, y] = project(c.p3);
      return { ...c, x, y };
    });
    const byKey = new Map(cells.map((c) => [c.q + ',' + c.r, c]));
    lc = {
      tile: canon.tile, tileId,
      cells, byKey,
      poly: polys.get(tileId) || canon.tile.corners.map(project),
      rivers: canon.rivers.map((pts) => pts.map((p) => {
        const [x, y] = project(p.p3);
        return { x, y };
      })),
      crossings: canon.crossings.map((cr) => {
        const [x, y] = project(cr.p3);
        return { dir: cr.dir, x, y };
      }),
      flow: canon.flow,
    };
    localCache.set(tileId, lc);
    return lc;
  }

  // region-frame point -> localized cell (via the owner's canonical lattice)
  function cellAt(x, y) {
    const owner = tileOf(x, y);
    if (!polys.has(owner.id)) return null;
    const ob = tileBasis(owner);
    const [cx, cy] = projWith(ob, to3D(x, y));
    const r = Math.round(cy / ROWH);
    const q = Math.round(cx / HEXW - r / 2);
    return localChunk(owner.id).byKey.get(q + ',' + r) || null;
  }

  return {
    world,
    sea: world.seaLevel,
    anchor: anchorTile,
    tiles: regionTiles,
    polys,
    project, to3D, sample, tileOf, cellAt,
    localChunk,
    terrainData: new Map(),     // tileId -> renderer height grids (region frame)
    discovered: world.discovered,
    settlements: world.settlements,
    civs: world.civs,
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
