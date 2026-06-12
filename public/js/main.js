import { generateWorld } from './worldgen.js';
import { generateLocalMap } from './localmap.js';
import { Globe } from './globe.js';
import { TerrainView } from './terrain3d.js';
import { showTile, showCell, showStats } from './ui.js';
import { randomSeed } from './rng.js';

import { BIOMES } from './defs.js';

const canvas = document.getElementById('map');
const mapCanvas = document.getElementById('localmap');
const overlay = document.getElementById('overlay');
const seedInput = document.getElementById('seed');
const backBtn = document.getElementById('back');
const locEl = document.getElementById('loc');
const hintEl = document.getElementById('hint');

const globe = new Globe(canvas);
const mapView = new TerrainView(mapCanvas, (cell) => showCell(cell));

let world = null;
let mode = 'globe';
const mapCache = new Map(); // tileId -> generated local map (per world)

function generate(seed) {
  overlay.classList.remove('hidden');
  seedInput.value = seed;
  setTimeout(() => {
    world = generateWorld(seed);
    mapCache.clear();
    if (mode === 'map') exitMap();
    globe.setWorld(world);
    showTile(null);
    showStats(world.stats);
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);
    overlay.classList.add('hidden');
  }, 30);
}

// ---- globe <-> local map view switching ----
function enterTile(tile) {
  if (!tile || mode === 'map') return;
  let lm = mapCache.get(tile.id);
  if (!lm) {
    lm = generateLocalMap(world, tile);
    mapCache.set(tile.id, lm);
  }
  mapView.setMap(lm);
  mode = 'map';
  document.body.classList.add('map-mode');
  locEl.textContent = `${BIOMES[tile.biome].name} · tile #${tile.id}`;
  hintEl.textContent = 'drag to orbit · right-drag to pan · scroll to zoom · click ground for info · Esc to return';
  showCell(null);
}

function exitMap() {
  mode = 'globe';
  document.body.classList.remove('map-mode');
  locEl.textContent = '';
  hintEl.textContent = 'drag to spin · scroll to zoom · click a tile · double-click to explore';
  showTile(null);
}

backBtn.onclick = exitMap;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mode === 'map') exitMap();
});

// ---- seed controls ----
document.getElementById('gen').onclick = () => generate(seedInput.value.trim() || randomSeed());
document.getElementById('rand').onclick = () => generate(randomSeed());
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generate(seedInput.value.trim() || randomSeed());
});

// ---- local map picking (OrbitControls handles camera) ----
let mDownX = 0, mDownY = 0;
mapCanvas.addEventListener('pointerdown', (e) => {
  mDownX = e.clientX;
  mDownY = e.clientY;
});
mapCanvas.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - mDownX, e.clientY - mDownY) > 5) return; // drag
  const cell = mapView.pick(e.clientX, e.clientY);
  mapView.setSelected(cell);
  showCell(cell);
});

// ---- globe picking (OrbitControls handles rotate/zoom) ----
let downX = 0, downY = 0;

canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // drag
  const t = globe.pick(e.clientX, e.clientY);
  globe.setSelected(t);
  showTile(t);
});
canvas.addEventListener('dblclick', (e) => {
  const t = globe.pick(e.clientX, e.clientY);
  if (t) enterTile(t);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons) return;
  globe.setHovered(globe.pick(e.clientX, e.clientY));
});

const panel = document.getElementById('panel');
panel.addEventListener('deselect', () => {
  if (mode === 'globe') globe.setSelected(null);
  else mapView.setSelected(null);
});
panel.addEventListener('explore', (e) => enterTile(world.tiles[e.detail]));

function frame() {
  if (mode === 'globe') globe.render();
  else mapView.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debug / scripting handle
window.RIM = {
  get world() { return world; },
  get mode() { return mode; },
  enterTile: (id) => enterTile(world.tiles[id]),
  exitMap,
  globe,
  mapView,
};

const urlSeed = new URLSearchParams(location.search).get('seed');
generate(urlSeed || randomSeed());
