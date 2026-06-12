// Invariant tests for the sphere geometry, world generation, and regions.
// Run with: npm test  (plain node, no test framework needed)

import { buildGoldberg } from './public/js/sphere.js';
import { generateWorld } from './public/js/worldgen.js';
import { createRegion } from './public/js/localmap.js';

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// ---- geometry ----
const FREQ = 24;
const { tiles: mesh } = buildGoldberg(FREQ);

check(`tile count is 10*f^2+2 (${10 * FREQ * FREQ + 2})`, mesh.length === 10 * FREQ * FREQ + 2);
check('exactly 12 pentagons', mesh.filter((t) => t.neighbors.length === 5).length === 12);
check('rest are hexagons', mesh.filter((t) => t.neighbors.length === 6).length === mesh.length - 12);

let badNbr = 0, badMid = 0, badCorners = 0;
for (const t of mesh) {
  if (t.corners.length !== t.neighbors.length) badCorners++;
  t.neighbors.forEach((nid, d) => {
    const nt = mesh[nid];
    const back = nt.neighbors.indexOf(t.id);
    if (back < 0) { badNbr++; return; }
    const a = t.edgeMid[d], b = nt.edgeMid[back];
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-9) badMid++;
  });
}
check('neighbor links are reciprocal', badNbr === 0);
check('shared edge midpoints identical from both tiles', badMid === 0);
check('corner count matches neighbor count', badCorners === 0);

// ---- worldgen ----
const SEED = 'test-seed-42';
const w = generateWorld(SEED);

check('water fraction ~60%', Math.abs(w.stats.waterPct - 60) <= 2);
check('every tile has a biome', w.tiles.every((t) => t.biome));
check('rivers exist', w.stats.rivers > 0);

let badRiver = 0, riverPairs = 0;
for (const t of w.tiles) {
  for (const d of t.riverN) {
    const nt = w.tiles[t.neighbors[d]];
    riverPairs++;
    if (!nt.riverN.includes(nt.neighbors.indexOf(t.id))) badRiver++;
  }
}
check(`river edges reciprocal (${riverPairs} pairs)`, riverPairs > 0 && badRiver === 0);

const w2 = generateWorld(SEED);
check('generation is deterministic', w.tiles.every((t, i) =>
  t.elev === w2.tiles[i].elev &&
  t.biome === w2.tiles[i].biome &&
  JSON.stringify(t.resources) === JSON.stringify(w2.tiles[i].resources)));

const w3 = generateWorld('a-different-seed');
check('different seed gives a different world', w3.tiles.some((t, i) => t.elev !== w.tiles[i].elev));

check('fertility in range', w.tiles.every((t) => t.fertility >= 0 && t.fertility <= 100));
check('most tiles have resources', w.tiles.filter((t) => t.resources.length).length / w.tiles.length > 0.85);

// ---- regions / local maps ----
// pick a land tile whose river flows to a land neighbor (to test alignment)
const riverTile = w.tiles.find((t) =>
  t.riverN.length >= 1 && !t.water &&
  t.riverN.some((d) => !w.tiles[t.neighbors[d]].water));
const region = createRegion(w, riverTile);
const chunk = region.getChunk(riverTile.id);

check('anchor chunk has cells', chunk.cells.length > 1000);
check('chunk deterministic', (() => {
  const r2 = createRegion(w, riverTile);
  const c2 = r2.getChunk(riverTile.id);
  return chunk.cells.length === c2.cells.length && chunk.cells.every((c, i) =>
    c.biome === c2.cells[i].biome &&
    c.elev === c2.cells[i].elev &&
    c.resource === c2.cells[i].resource);
})());
check('chunk has a river path', chunk.rivers.length > 0 && chunk.rivers[0].length > 2);
check('all tile resources placed as deposits', riverTile.resources.every((id) =>
  chunk.cells.some((c) => c.resource === id)));

// cross-chunk alignment: the river leaves this chunk at exactly the same
// point where it enters the neighbor's chunk (shared frame, shared edgeMid)
const dirToLand = riverTile.riverN.find((d) => !w.tiles[riverTile.neighbors[d]].water);
const neighborTile = w.tiles[riverTile.neighbors[dirToLand]];
const nChunk = region.getChunk(neighborTile.id);
const myCrossing = chunk.crossings.find((c) => c.dir === dirToLand);
const theirDir = neighborTile.neighbors.indexOf(riverTile.id);
const theirCrossing = nChunk.crossings.find((c) => c.dir === theirDir);
check('shared river crossing exists in both chunks', !!myCrossing && !!theirCrossing);
check('river crossings coincide exactly across the boundary',
  myCrossing && theirCrossing &&
  Math.hypot(myCrossing.x - theirCrossing.x, myCrossing.y - theirCrossing.y) < 1e-9);
check('both chunks have a river endpoint at the shared crossing', (() => {
  const at = (pts, cr) => pts.some((p) => Math.hypot(p.x - cr.x, p.y - cr.y) < 1e-9);
  return chunk.rivers.some((pts) => at(pts, myCrossing)) &&
    nChunk.rivers.some((pts) => at(pts, theirCrossing));
})());

// adjacent chunks never claim the same cell, and ownership is exclusive
check('no cell claimed by two chunks', (() => {
  const seen = new Set();
  for (const c of [...chunk.cells, ...nChunk.cells]) {
    const k = c.q + ',' + c.r;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
})());
check('terrain field is identical across the boundary', (() => {
  // sample the exact crossing point twice via both chunk paths — same region
  // field, must be bit-identical
  const a = region.sample(myCrossing.x, myCrossing.y);
  const b = region.sample(theirCrossing.x, theirCrossing.y);
  return a.e === b.e && a.biome === b.biome;
})());

const coastTile = w.tiles.find((t) => !t.water &&
  t.neighbors.some((nid) => w.tiles[nid].water && w.tiles[nid].biome !== 'lake'));
const clm = createRegion(w, coastTile).getChunk(coastTile.id);
check('coastal chunk contains ocean cells', clm.cells.some((c) => c.water));
check('coastal chunk contains land cells', clm.cells.some((c) => !c.water));

const oceanTile = w.tiles.find((t) => t.biome === 'deep_ocean');
const olm = createRegion(w, oceanTile).getChunk(oceanTile.id);
check('deep ocean chunk is mostly water', olm.cells.filter((c) => c.water).length / olm.cells.length > 0.8);

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
