import { generateWorld } from './worldgen.js';
import { Globe } from './globe.js';
import { showTile, showStats } from './ui.js';
import { randomSeed } from './rng.js';

const canvas = document.getElementById('map');
const overlay = document.getElementById('overlay');
const seedInput = document.getElementById('seed');

const globe = new Globe(canvas);

function generate(seed) {
  overlay.classList.remove('hidden');
  seedInput.value = seed;
  // let the overlay paint before blocking on generation
  setTimeout(() => {
    const world = generateWorld(seed);
    globe.setWorld(world);
    showTile(null);
    showStats(world.stats);
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);
    overlay.classList.add('hidden');
  }, 30);
}

// ---- controls ----
document.getElementById('gen').onclick = () => generate(seedInput.value.trim() || randomSeed());
document.getElementById('rand').onclick = () => generate(randomSeed());
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generate(seedInput.value.trim() || randomSeed());
});

// ---- picking (OrbitControls handles rotate/zoom) ----
let downX = 0, downY = 0;

canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // it was a drag
  const t = globe.pick(e.clientX, e.clientY);
  globe.setSelected(t);
  showTile(t);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons) return;
  globe.setHovered(globe.pick(e.clientX, e.clientY));
});

document.getElementById('panel').addEventListener('deselect', () => {
  globe.setSelected(null);
});

function frame() {
  globe.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const urlSeed = new URLSearchParams(location.search).get('seed');
generate(urlSeed || randomSeed());
