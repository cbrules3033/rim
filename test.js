// Invariant tests for the sphere geometry and world generation.
// Run with: npm test  (plain node, no test framework needed)

import { buildGoldberg } from './public/js/sphere.js';
import { generateWorld } from './public/js/worldgen.js';
import { generateLocalMap } from './public/js/localmap.js';

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

// ---- local tile maps ----
const riverTile = w.tiles.find((t) => t.riverN.length >= 1 && !t.water);
const lm = generateLocalMap(w, riverTile);

check('local map has cells', lm.cells.length > 1000);
check('local map deterministic', (() => {
  const lm2 = generateLocalMap(w, riverTile);
  return lm.cells.every((c, i) =>
    c.biome === lm2.cells[i].biome &&
    c.elev === lm2.cells[i].elev &&
    c.resource === lm2.cells[i].resource);
})());
check('local map has a river path', lm.rivers.length > 0 && lm.rivers[0].length > 2);
check('river crossings sit on shared edge midpoints', lm.crossings.every((cr, i) => {
  const mid = riverTile.edgeMid[riverTile.riverN[i]];
  return Math.hypot(cr.p3[0] - mid[0], cr.p3[1] - mid[1], cr.p3[2] - mid[2]) < 1e-12;
}));
check('river path starts near its entry crossing', (() => {
  const entry = lm.rivers[0][0];
  const cr = lm.crossings[0];
  return Math.hypot(entry.x - cr.x, entry.y - cr.y) < 25; // within ~1.5 cells
})());
check('all tile resources placed as deposits', riverTile.resources.every((id) =>
  lm.cells.some((c) => c.resource === id)));

const coastTile = w.tiles.find((t) => !t.water &&
  t.neighbors.some((nid) => w.tiles[nid].water && w.tiles[nid].biome !== 'lake'));
const clm = generateLocalMap(w, coastTile);
check('coastal tile map contains ocean cells', clm.cells.some((c) => c.water));
check('coastal tile map contains land cells', clm.cells.some((c) => !c.water));

const oceanTile = w.tiles.find((t) => t.biome === 'deep_ocean');
const olm = generateLocalMap(w, oceanTile);
check('deep ocean tile map is mostly water', olm.cells.filter((c) => c.water).length / olm.cells.length > 0.8);

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
