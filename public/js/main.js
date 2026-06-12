import { generateWorld } from './worldgen.js';
import { createRegion } from './localmap.js';
import { Globe } from './globe.js';
import { TerrainView } from './terrain3d.js';
import { showTile, showCell, showSettlement, showStats } from './ui.js';
import { randomSeed } from './rng.js';

import { BIOMES, RESOURCES } from './defs.js';

const canvas = document.getElementById('map');
const mapCanvas = document.getElementById('localmap');
const overlay = document.getElementById('overlay');
const seedInput = document.getElementById('seed');
const backBtn = document.getElementById('back');
const locEl = document.getElementById('loc');
const hintEl = document.getElementById('hint');

const globe = new Globe(canvas);
const mapView = new TerrainView(mapCanvas);

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
  let region = mapCache.get(tile.id);
  if (!region) {
    region = createRegion(world, tile);
    region.getChunk(tile.id);
    mapCache.set(tile.id, region);
  }
  mapView.setMap(region);
  mode = 'map';
  document.body.classList.add('map-mode');
  locEl.textContent = `${BIOMES[tile.biome].name} · tile #${tile.id}`;
  hintEl.textContent = 'drag to orbit · right-drag to pan · ⛺ to settle · click a villager, then ground, to send them';
  showCell(null);
}

function exitMap() {
  mode = 'globe';
  mapView.togglePlacement(false);
  mapView.deselectCiv();
  document.getElementById('tooltip').classList.add('hidden');
  document.body.classList.remove('map-mode');
  locEl.textContent = '';
  hintEl.textContent = 'drag to spin · scroll to zoom · click a tile · double-click to explore';
  showTile(null);
}

backBtn.onclick = exitMap;
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || mode !== 'map') return;
  if (mapView.placementMode) mapView.togglePlacement(false);
  else if (mapView.selectedCiv) mapView.deselectCiv();
  else exitMap();
});

// ---- seed controls ----
document.getElementById('gen').onclick = () => generate(seedInput.value.trim() || randomSeed());
document.getElementById('rand').onclick = () => generate(randomSeed());
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generate(seedInput.value.trim() || randomSeed());
});

// ---- local map interactions (TerrainView handles its own clicks) ----
mapView.onInfo = (cell) => showCell(cell);
mapView.onSettlement = (s) => {
  const pop = mapView.region.civs.filter((c) => c.home === s.name).length;
  showSettlement(s, pop);
};
mapView.onDiscover = (tile) => {
  const toast = document.getElementById('toast');
  toast.textContent = `🌄 Discovered: ${BIOMES[tile.biome].name}`;
  toast.classList.remove('hidden');
  toast.classList.remove('show');
  void toast.offsetWidth; // restart animation
  toast.classList.add('show');
};
const settleBtn = document.getElementById('settle');
mapView.onPlacement = (active) => settleBtn.classList.toggle('active', active);
settleBtn.onclick = () => mapView.togglePlacement();

// terrain hover tooltip (mouse only)
const tooltip = document.getElementById('tooltip');
let tipTimer = 0;
mapCanvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons || mapView.placementMode) {
    tooltip.classList.add('hidden');
    return;
  }
  const now = performance.now();
  if (now - tipTimer < 60) return;
  tipTimer = now;
  const cell = mapView.probe(e.clientX, e.clientY);
  if (!cell) {
    tooltip.classList.add('hidden');
    return;
  }
  const res = cell.resource ? ` · ${RESOURCES[cell.resource].i} ${RESOURCES[cell.resource].n}` : '';
  tooltip.innerHTML = `<b>${BIOMES[cell.biome].name}</b><span class="dim">${cell.elevM} m · fert ${cell.fertility}${res}</span>`;
  tooltip.style.left = e.clientX + 16 + 'px';
  tooltip.style.top = e.clientY + 18 + 'px';
  tooltip.classList.remove('hidden');
});
mapCanvas.addEventListener('pointerleave', () => tooltip.classList.add('hidden'));

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
