// Resource and biome definitions + color helpers.

export const RESOURCES = {
  // Crops & food
  wheat:     { n: 'Wheat', i: '🌾', c: 'Crop' },
  barley:    { n: 'Barley', i: '🍺', c: 'Crop' },
  corn:      { n: 'Corn', i: '🌽', c: 'Crop' },
  rice:      { n: 'Rice', i: '🍚', c: 'Crop' },
  potatoes:  { n: 'Potatoes', i: '🥔', c: 'Crop' },
  bananas:   { n: 'Bananas', i: '🍌', c: 'Crop' },
  citrus:    { n: 'Citrus', i: '🍊', c: 'Crop' },
  grapes:    { n: 'Grapes', i: '🍇', c: 'Crop' },
  olives:    { n: 'Olives', i: '🫒', c: 'Crop' },
  dates:     { n: 'Dates', i: '🌴', c: 'Crop' },
  coconuts:  { n: 'Coconuts', i: '🥥', c: 'Crop' },
  sugar:     { n: 'Sugar', i: '🍬', c: 'Crop' },
  cocoa:     { n: 'Cocoa', i: '🍫', c: 'Luxury' },
  coffee:    { n: 'Coffee', i: '☕', c: 'Luxury' },
  tea:       { n: 'Tea', i: '🍵', c: 'Luxury' },
  spices:    { n: 'Spices', i: '🌶️', c: 'Luxury' },
  honey:     { n: 'Honey', i: '🍯', c: 'Food' },
  mushrooms: { n: 'Mushrooms', i: '🍄', c: 'Food' },
  salt:      { n: 'Salt', i: '🧂', c: 'Mineral' },
  // Animals
  cattle:    { n: 'Cattle', i: '🐄', c: 'Livestock' },
  sheep:     { n: 'Sheep', i: '🐑', c: 'Livestock' },
  goats:     { n: 'Goats', i: '🐐', c: 'Livestock' },
  pigs:      { n: 'Pigs', i: '🐖', c: 'Livestock' },
  horses:    { n: 'Horses', i: '🐎', c: 'Livestock' },
  camels:    { n: 'Camels', i: '🐪', c: 'Livestock' },
  deer:      { n: 'Deer', i: '🦌', c: 'Game' },
  bison:     { n: 'Bison', i: '🦬', c: 'Game' },
  furs:      { n: 'Furs', i: '🦊', c: 'Game' },
  ivory:     { n: 'Ivory', i: '🐘', c: 'Luxury' },
  silk:      { n: 'Silk', i: '🐛', c: 'Luxury' },
  fish:      { n: 'Fish', i: '🐟', c: 'Food' },
  crabs:     { n: 'Crabs', i: '🦀', c: 'Food' },
  whales:    { n: 'Whales', i: '🐋', c: 'Food' },
  pearls:    { n: 'Pearls', i: '🦪', c: 'Luxury' },
  kelp:      { n: 'Kelp', i: '🌿', c: 'Food' },
  // Materials
  timber:    { n: 'Timber', i: '🪵', c: 'Material' },
  hardwood:  { n: 'Hardwood', i: '🌳', c: 'Material' },
  clay:      { n: 'Clay', i: '🏺', c: 'Material' },
  stone:     { n: 'Stone', i: '🪨', c: 'Material' },
  marble:    { n: 'Marble', i: '🏛️', c: 'Material' },
  obsidian:  { n: 'Obsidian', i: '⬛', c: 'Material' },
  flint:     { n: 'Flint', i: '⚒️', c: 'Material' },
  sand:      { n: 'Glass Sand', i: '⏳', c: 'Material' },
  cotton:    { n: 'Cotton', i: '🧵', c: 'Material' },
  flax:      { n: 'Flax', i: '🧶', c: 'Material' },
  amber:     { n: 'Amber', i: '🟠', c: 'Luxury' },
  jade:      { n: 'Jade', i: '🟢', c: 'Luxury' },
  reeds:     { n: 'Reeds', i: '🎋', c: 'Material' },
  ice:       { n: 'Ice', i: '❄️', c: 'Material' },
  // Metals & minerals
  copper:    { n: 'Copper', i: '🥉', c: 'Metal' },
  tin:       { n: 'Tin', i: '🔧', c: 'Metal' },
  iron:      { n: 'Iron', i: '⛓️', c: 'Metal' },
  coal:      { n: 'Coal', i: '⚫', c: 'Energy' },
  gold:      { n: 'Gold', i: '🥇', c: 'Metal' },
  silver:    { n: 'Silver', i: '🥈', c: 'Metal' },
  gems:      { n: 'Gems', i: '💎', c: 'Luxury' },
  lapis:     { n: 'Lapis', i: '🔵', c: 'Luxury' },
  lead:      { n: 'Lead', i: '🔩', c: 'Metal' },
  nickel:    { n: 'Nickel', i: '🪙', c: 'Metal' },
  bauxite:   { n: 'Bauxite', i: '⚪', c: 'Metal' },
  platinum:  { n: 'Platinum', i: '💍', c: 'Metal' },
  uranium:   { n: 'Uranium', i: '☢️', c: 'Energy' },
  sulfur:    { n: 'Sulfur', i: '🟡', c: 'Mineral' },
  saltpeter: { n: 'Saltpeter', i: '🧨', c: 'Mineral' },
  // Energy
  oil:       { n: 'Oil', i: '🛢️', c: 'Energy' },
  gas:       { n: 'Natural Gas', i: '💨', c: 'Energy' },
  geothermal:{ n: 'Geothermal', i: '♨️', c: 'Energy' },
  peat:      { n: 'Peat', i: '🟤', c: 'Energy' },
};

// Extra minerals rolled on hills & rough terrain.
export const HILL_MINERALS = [
  ['stone', 4], ['copper', 3], ['iron', 3], ['tin', 2], ['coal', 2],
  ['clay', 1], ['marble', 1], ['lead', 1], ['lapis', 1], ['saltpeter', 1],
  ['nickel', 1], ['bauxite', 1], ['silver', 1], ['gold', 1], ['jade', 1],
  ['platinum', 0.4], ['uranium', 0.4],
];

// name, top color, base fertility, resource table [id, weight]
export const BIOMES = {
  deep_ocean: { name: 'Deep Ocean', color: '#11304f', fert: 5,
    res: [['fish', 5], ['whales', 3], ['oil', 1], ['gas', 1]] },
  ocean: { name: 'Ocean', color: '#1a4570', fert: 10,
    res: [['fish', 6], ['whales', 1], ['kelp', 1], ['oil', 1]] },
  shallows: { name: 'Coastal Waters', color: '#2e7ba6', fert: 35,
    res: [['fish', 6], ['crabs', 3], ['kelp', 2], ['pearls', 1], ['salt', 1], ['sand', 1]] },
  lake: { name: 'Lake', color: '#2f86b5', fert: 45,
    res: [['fish', 5], ['clay', 2], ['reeds', 2], ['salt', 1]] },
  beach: { name: 'Beach', color: '#e6d49e', fert: 15,
    res: [['coconuts', 3], ['crabs', 3], ['sand', 3], ['salt', 2], ['fish', 2]] },
  desert: { name: 'Desert', color: '#dec47e', fert: 6,
    res: [['salt', 3], ['sand', 3], ['camels', 3], ['oil', 2], ['flint', 1], ['sulfur', 1], ['gold', 1], ['gems', 1]] },
  steppe: { name: 'Steppe', color: '#b3a96a', fert: 32,
    res: [['horses', 4], ['sheep', 3], ['goats', 2], ['bison', 2], ['flint', 1], ['saltpeter', 1]] },
  savanna: { name: 'Savanna', color: '#c2af58', fert: 45,
    res: [['cattle', 3], ['goats', 2], ['coffee', 2], ['cotton', 2], ['ivory', 2], ['honey', 1], ['spices', 1]] },
  grassland: { name: 'Grassland', color: '#8fb45a', fert: 70,
    res: [['wheat', 4], ['barley', 3], ['cattle', 3], ['horses', 2], ['sheep', 2], ['honey', 1], ['flax', 1]] },
  plains: { name: 'Plains', color: '#a3bd62', fert: 75,
    res: [['wheat', 5], ['corn', 4], ['cattle', 3], ['potatoes', 2], ['pigs', 2], ['cotton', 1], ['grapes', 1], ['olives', 1], ['citrus', 1]] },
  shrubland: { name: 'Shrubland', color: '#9aa566', fert: 35,
    res: [['goats', 3], ['olives', 2], ['grapes', 2], ['honey', 1], ['flint', 1], ['sheep', 1]] },
  forest: { name: 'Temperate Forest', color: '#55904f', fert: 60,
    res: [['timber', 6], ['deer', 3], ['furs', 2], ['mushrooms', 2], ['honey', 2], ['hardwood', 1]] },
  seasonal_forest: { name: 'Seasonal Forest', color: '#4c8a55', fert: 65,
    res: [['timber', 4], ['hardwood', 3], ['deer', 2], ['tea', 2], ['silk', 1], ['mushrooms', 1]] },
  jungle: { name: 'Rainforest', color: '#2f6f3e', fert: 70,
    res: [['hardwood', 4], ['bananas', 3], ['cocoa', 2], ['coffee', 2], ['spices', 2], ['sugar', 2], ['rice', 1], ['ivory', 1]] },
  taiga: { name: 'Taiga', color: '#4b7561', fert: 30,
    res: [['timber', 5], ['furs', 4], ['deer', 2], ['amber', 1], ['peat', 1]] },
  tundra: { name: 'Tundra', color: '#9ba58d', fert: 12,
    res: [['furs', 3], ['deer', 3], ['peat', 1], ['ice', 1]] },
  snow: { name: 'Snowfield', color: '#e6ebf1', fert: 3,
    res: [['furs', 2], ['ice', 2], ['fish', 1]] },
  glacier: { name: 'Glacier', color: '#c9dce8', fert: 0,
    res: [['ice', 3]] },
  swamp: { name: 'Swamp', color: '#4f6d4a', fert: 55,
    res: [['reeds', 3], ['peat', 3], ['rice', 2], ['clay', 2], ['mushrooms', 1], ['gas', 1]] },
  marsh: { name: 'Marsh', color: '#5d7d52', fert: 60,
    res: [['rice', 3], ['reeds', 3], ['clay', 2], ['fish', 2], ['peat', 1]] },
  mountain: { name: 'Mountains', color: '#8d8d92', fert: 10,
    res: [['stone', 4], ['iron', 3], ['copper', 3], ['coal', 2], ['silver', 2], ['goats', 1], ['gold', 1], ['gems', 1]] },
  peak: { name: 'Peaks', color: '#c7cbd3', fert: 2,
    res: [['stone', 2], ['gems', 1], ['silver', 1], ['ice', 1]] },
};

export const FERTILITY_LEVELS = [
  [10, 'Barren'], [25, 'Poor'], [45, 'Modest'], [65, 'Fertile'], [85, 'Rich'], [101, 'Lush'],
];

export function fertilityLevel(f) {
  for (const [max, name] of FERTILITY_LEVELS) if (f < max) return name;
  return 'Lush';
}

export function elevationLevel(t) {
  if (t.water) {
    if (t.biome === 'lake') return 'Lake';
    const d = t.depth;
    if (d > 0.65) return 'Abyssal';
    if (d > 0.35) return 'Deep Ocean';
    if (d > 0.12) return 'Ocean';
    return 'Coastal Shelf';
  }
  const a = t.elevAbove;
  if (a > 0.82) return 'Peaks';
  if (a > 0.62) return 'Mountains';
  if (a > 0.48) return 'Highlands';
  if (a > 0.30) return 'Hills';
  if (a > 0.12) return 'Uplands';
  return 'Lowlands';
}

// ---- color helpers ----

export function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbStr([r, g, b]) {
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// amt > 0 lightens toward white, amt < 0 darkens toward black
export function shade(rgb, amt) {
  if (amt >= 0) return rgb.map((c) => c + (255 - c) * amt);
  return rgb.map((c) => c * (1 + amt));
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
