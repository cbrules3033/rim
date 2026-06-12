// Tile info panel + world stats.

import { RESOURCES, BIOMES } from './defs.js';

const FEATURE_LABELS = {
  river: '💧 River',
  forest: '🌲 Forested',
  oasis: '🏝️ Oasis',
  reef: '🪸 Coral Reef',
  volcano: '🌋 Volcano',
  snowcap: '🏔️ Snowcapped',
  sea_ice: '🧊 Sea Ice',
};

export function showTile(t) {
  const panel = document.getElementById('panel');
  if (!t) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const B = BIOMES[t.biome];

  const rows = [
    ['Location', `${Math.abs(t.lat)}°${t.lat >= 0 ? 'N' : 'S'}, ${Math.abs(t.lon)}°${t.lon >= 0 ? 'E' : 'W'} · #${t.id}`],
    ['Elevation', `${t.elevLevel} · ${t.elevM} m`],
    ['Temperature', `${t.temp}°C`],
    ['Moisture', `${Math.round(t.moist * 100)}%`],
    ['Fertility', `${t.fertLevel} (${t.fertility}/100)`],
  ];
  if (t.riverN.length) {
    rows.push(['River', `${t.riverN.length} edge${t.riverN.length > 1 ? 's' : ''} · flow ${t.flow}`]);
  }
  if (t.pentagon) {
    rows.push(['Shape', 'Pentagon — 1 of 12 on the planet']);
  }

  const features = t.features
    .map((f) => FEATURE_LABELS[f] || f)
    .map((f) => `<span class="chip">${f}</span>`)
    .join('');

  const resources = t.resources.length
    ? t.resources.map((id) => {
        const r = RESOURCES[id];
        return `<div class="res"><span class="res-icon">${r.i}</span><span>${r.n}</span><span class="res-cat">${r.c}</span></div>`;
      }).join('')
    : '<div class="dim">None</div>';

  panel.innerHTML = `
    <div class="panel-head">
      <span class="swatch" style="background:${t.color}"></span>
      <h2>${B.name}</h2>
      <button id="panel-close" title="Close">✕</button>
    </div>
    ${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('')}
    ${features ? `<div class="section">Features</div><div class="chips">${features}</div>` : ''}
    <div class="section">Resources</div>
    ${resources}
    <button id="explore" class="explore-btn">Explore this tile →</button>
    <div class="tile-seed dim">tile seed ${t.seed.toString(16)}</div>
  `;
  document.getElementById('panel-close').onclick = () => {
    panel.classList.add('hidden');
    panel.dispatchEvent(new CustomEvent('deselect', { bubbles: true }));
  };
  document.getElementById('explore').onclick = () => {
    panel.dispatchEvent(new CustomEvent('explore', { bubbles: true, detail: t.id }));
  };
}

// Info panel for a single cell of a local tile map.
export function showCell(c) {
  const panel = document.getElementById('panel');
  if (!c) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const B = BIOMES[c.biome];
  const rows = [
    ['Cell', `${c.q}, ${c.r}`],
    ['Elevation', `${c.elevM} m`],
    ['Temperature', `${c.temp}°C`],
    ['Moisture', `${Math.round(c.moist * 100)}%`],
    ['Fertility', `${c.fertility}/100`],
  ];
  const featLabels = { ...FEATURE_LABELS, tree: '🌳 Trees', cactus: '🌵 Cacti', rocks: '🪨 Boulders' };
  const features = [...(c.river ? ['river'] : []), ...c.features]
    .map((f) => `<span class="chip">${featLabels[f] || f}</span>`)
    .join('');
  const res = c.resource
    ? `<div class="res"><span class="res-icon">${RESOURCES[c.resource].i}</span><span>${RESOURCES[c.resource].n}</span><span class="res-cat">${RESOURCES[c.resource].c}</span></div>`
    : '<div class="dim">None</div>';
  panel.innerHTML = `
    <div class="panel-head">
      <span class="swatch" style="background:${c.color}"></span>
      <h2>${B.name}</h2>
      <button id="panel-close" title="Close">✕</button>
    </div>
    ${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('')}
    ${features ? `<div class="section">Features</div><div class="chips">${features}</div>` : ''}
    <div class="section">Resource Deposit</div>
    ${res}
  `;
  document.getElementById('panel-close').onclick = () => {
    panel.classList.add('hidden');
    panel.dispatchEvent(new CustomEvent('deselect', { bubbles: true }));
  };
}

export function showStats(stats) {
  const el = document.getElementById('stats');
  const land = 100 - stats.waterPct;
  const topBiomes = Object.entries(stats.biomes)
    .filter(([b]) => !['deep_ocean', 'ocean', 'shallows'].includes(b))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([b]) => BIOMES[b].name)
    .join(', ');
  el.textContent = `${stats.N} tiles · ${stats.waterPct}% ocean / ${land}% land · ${stats.rivers} river tiles · mostly ${topBiomes} · generated in ${stats.genMs}ms`;
}
