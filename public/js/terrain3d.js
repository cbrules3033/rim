// 3D landscape renderer for regions: chunked terrain (one chunk per globe
// tile) on a single shared grid so adjacent chunks meet seam-free, fog of war
// over undiscovered neighbors, settlements, and controllable villagers who
// can walk into the fog to discover new chunks.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './rng.js';
import { CELL, HEXW, ROWH, sampleColor } from './localmap.js';

const HSCALE = 62;      // land elevation scale (map units)
const DSCALE = 20;      // seabed depth scale
const WATER_Y = -0.55;
const STEP = 5.5;       // global terrain vertex grid step — shared by all chunks
const FOG_TOP = 58, FOG_BOT = -45;

const ANIMALS = {
  deer:   { c: 0x9a6a3a, s: 1.0, n: 5 },
  cattle: { c: 0x46382e, s: 1.35, n: 4 },
  sheep:  { c: 0xe9e5da, s: 0.85, n: 6 },
  goats:  { c: 0xbcae97, s: 0.85, n: 5 },
  pigs:   { c: 0xd49a96, s: 0.85, n: 4 },
  horses: { c: 0x6b4a2f, s: 1.25, n: 4 },
  bison:  { c: 0x57422d, s: 1.5, n: 4 },
  camels: { c: 0xc8a35f, s: 1.3, n: 3 },
  furs:   { c: 0xc2662e, s: 0.55, n: 4 },
  ivory:  { c: 0x9a9a9a, s: 1.9, n: 2 },
  silk:   { c: 0xd8d2bb, s: 0.4, n: 5 },
};

const CRYSTALS = {
  gold: 0xffc94a, silver: 0xd9dee6, copper: 0xd07a45, iron: 0x9a7a68,
  coal: 0x232323, gems: 0xe055c8, lapis: 0x2a5fd0, obsidian: 0x17171f,
  sulfur: 0xe6d23c, salt: 0xf2f2f2, tin: 0xb8c0c8, lead: 0x5d6470,
  nickel: 0xc0bca8, bauxite: 0xc77b5a, platinum: 0xe8eef5, uranium: 0x8aef3a,
  saltpeter: 0xe0dcc8, marble: 0xeae8e2, stone: 0x8d8d92, sand: 0xe3cf94,
  amber: 0xe09a2a, jade: 0x3fae6a, flint: 0x55504a, clay: 0xa9684a,
  oil: 0x1c1c20, gas: 0x9fb8c8, geothermal: 0xe06a3a,
  peat: 0x4f3d2a, sugar: 0xf7f7f7, spices: 0xc23b1e, cocoa: 0x5c3a26,
  coffee: 0x3e2a1d, honey: 0xe8a82a, pearls: 0xf0e8e0, ice: 0xcfe6f2,
};

const CROPS = {
  wheat: 0xd8b44a, barley: 0xcfae58, corn: 0xe2c33a, rice: 0xb9d48a,
  potatoes: 0x9aa85a, cotton: 0xeef0ea, flax: 0x9fb4d8, tea: 0x4f8a4a,
  grapes: 0x7a4a8a, olives: 0x6a7a3a, citrus: 0xe8973a, bananas: 0xe2d04a,
};

const TIMBER = new Set(['timber', 'hardwood', 'mushrooms', 'truffles']);
const FISHY = { fish: { c: 0x5a7a8a, s: 1 }, crabs: { c: 0xc05a3a, s: 0.6 }, whales: { c: 0x36506a, s: 3.2 }, kelp: { c: 0x3a7a4a, s: 1 } };

export class TerrainView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070c);
    this.scene.fog = new THREE.Fog(0x05070c, 1400, 3200);

    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 7000);

    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x46412e, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
    sun.position.set(280, 460, 200);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -1200; sc.right = 1200; sc.top = 1200; sc.bottom = -1200;
    sc.near = 50; sc.far = 1600;
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = 1.5;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 2600;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.clock = new THREE.Clock();
    this.group = null;
    this.region = null;
    this.movers = [];
    this.chunkViews = new Map(); // tileId -> Group
    this.fogSlabs = new Map();   // tileId -> Mesh
    this.terrains = [];          // raycast list of chunk terrain meshes

    // callbacks
    this.onInfo = null;
    this.onSettlement = null;
    this.onPlacement = null;
    this.onDiscover = null;

    this.placementMode = false;
    this.selectedCiv = null;
    this.civMeshes = [];
    this.settlementMeshes = [];

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(CELL * 0.85, 0.45, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0x4cc2ff }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);

    this.ghost = this.makeGhost();
    this.scene.add(this.ghost);

    this.civRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.4, 0.35, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd84a }),
    );
    this.civRing.rotation.x = Math.PI / 2;
    this.civRing.visible = false;
    this.scene.add(this.civRing);

    this.moveMarker = new THREE.Mesh(
      new THREE.TorusGeometry(2.2, 0.3, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x5aff7a, transparent: true, opacity: 0.9 }),
    );
    this.moveMarker.rotation.x = Math.PI / 2;
    this.moveMarker.visible = false;
    this.scene.add(this.moveMarker);

    this.bindInput();
  }

  makeGhost() {
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x5aff7a, transparent: true, opacity: 0.45 });
    const g = new THREE.Group();
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(16, 17, 1.2, 8), this.ghostMat);
    const hall = new THREE.Mesh(new THREE.BoxGeometry(9, 6, 7), this.ghostMat);
    hall.position.y = 3.5;
    g.add(pad, hall);
    g.visible = false;
    return g;
  }

  // ---------- heights ----------

  baseHeight(e) {
    const sea = this.region.sea;
    if (e >= sea) return Math.pow((e - sea) / (1 - sea), 1.05) * HSCALE;
    return -Math.min(1, (sea - e) / sea) * DSCALE;
  }

  chunkHeightAt(chunk, x, z) {
    const td = chunk.terrainData;
    const fx = x / STEP - td.ixMin, fz = z / STEP - td.izMin;
    const ix = Math.max(0, Math.min(td.nx - 2, Math.floor(fx)));
    const iz = Math.max(0, Math.min(td.nz - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix)), tz = Math.max(0, Math.min(1, fz - iz));
    const g = td.hGrid;
    const h00 = g[iz * td.nx + ix], h10 = g[iz * td.nx + ix + 1];
    const h01 = g[(iz + 1) * td.nx + ix], h11 = g[(iz + 1) * td.nx + ix + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  meshHeightAt(x, z) {
    const owner = this.region.tileOf(x, z);
    const chunk = this.region.chunks.get(owner.id);
    if (chunk?.terrainData) return this.chunkHeightAt(chunk, x, z);
    return this.baseHeight(this.region.sample(x, z).e);
  }

  // is this point on an explorable region tile?
  inRegion(x, z) {
    const owner = this.region.tileOf(x, z);
    return this.region.polys.has(owner.id) ? owner : null;
  }

  // ---------- scene building ----------

  setMap(region) {
    if (this.group) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && !o.isInstancedMesh) o.material.dispose?.();
      });
      this.scene.remove(this.group);
    }
    this.region = region;
    this.movers = [];
    this.chunkViews.clear();
    this.fogSlabs.clear();
    this.terrains = [];
    this.civMeshes = [];
    this.settlementMeshes = [];
    this.ring.visible = false;
    this.civRing.visible = false;
    this.moveMarker.visible = false;
    this.ghost.visible = false;
    this.placementMode = false;
    this.selectedCiv = null;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    for (const id of region.discovered) this.buildChunkView(id);
    for (const t of region.tiles) {
      if (!region.discovered.has(t.id)) this.addFogSlab(t.id);
    }
    for (const s of region.settlements) this.addSettlementMeshes(s);
    for (const c of region.civs) this.addCivMesh(c);

    this.camera.position.set(0, 380, 500);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  discoverTile(tileId) {
    const region = this.region;
    if (region.discovered.has(tileId) || !region.polys.has(tileId)) return false;
    region.discovered.add(tileId);
    const slab = this.fogSlabs.get(tileId);
    if (slab) {
      slab.geometry.dispose();
      slab.material.dispose();
      this.group.remove(slab);
      this.fogSlabs.delete(tileId);
    }
    this.buildChunkView(tileId);
    this.onDiscover?.(region.world.tiles[tileId]);
    return true;
  }

  addFogSlab(tileId) {
    const poly = this.region.polys.get(tileId);
    // expand slightly outward so seams with terrain are hidden
    const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
    const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
    const pp = poly.map(([x, y]) => [cx + (x - cx) * 1.015, cy + (y - cy) * 1.015]);
    const verts = [];
    // top fan
    for (let i = 1; i < pp.length - 1; i++) {
      verts.push(pp[0][0], FOG_TOP, pp[0][1], pp[i][0], FOG_TOP, pp[i][1], pp[i + 1][0], FOG_TOP, pp[i + 1][1]);
    }
    // walls
    for (let i = 0; i < pp.length; i++) {
      const a = pp[i], b = pp[(i + 1) % pp.length];
      verts.push(a[0], FOG_BOT, a[1], b[0], FOG_BOT, b[1], b[0], FOG_TOP, b[1]);
      verts.push(a[0], FOG_BOT, a[1], b[0], FOG_TOP, b[1], a[0], FOG_TOP, a[1]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      color: 0x10141d, transparent: true, opacity: 0.96, side: THREE.DoubleSide,
    }));
    mesh.userData.fogTile = tileId;
    this.group.add(mesh);
    this.fogSlabs.set(tileId, mesh);
  }

  buildChunkView(tileId) {
    const region = this.region;
    const chunk = region.getChunk(tileId);
    if (!chunk.terrainData) this.buildTerrainData(chunk);
    const g = new THREE.Group();

    // terrain
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(chunk.terrainData.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(chunk.terrainData.col, 3));
    geo.setIndex(chunk.terrainData.idx);
    geo = geo.toNonIndexed();
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    terrain.receiveShadow = true;
    terrain.userData.chunkTile = tileId;
    g.add(terrain);
    this.terrains.push(terrain);

    // water (flat fan over the tile polygon)
    const poly = chunk.poly;
    const wverts = [];
    for (let i = 1; i < poly.length - 1; i++) {
      wverts.push(poly[0][0], WATER_Y, poly[0][1], poly[i][0], WATER_Y, poly[i][1], poly[i + 1][0], WATER_Y, poly[i + 1][1]);
    }
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.Float32BufferAttribute(wverts, 3));
    wgeo.computeVertexNormals();
    const water = new THREE.Mesh(wgeo, new THREE.MeshPhongMaterial({
      color: 0x2486b8, transparent: true, opacity: 0.72,
      shininess: 90, specular: 0x6699bb, side: THREE.DoubleSide,
    }));
    water.renderOrder = 1;
    g.add(water);

    this.buildChunkRivers(chunk, g);
    this.buildChunkProps(chunk, g);

    this.group.add(g);
    this.chunkViews.set(tileId, g);
  }

  buildTerrainData(chunk) {
    const region = this.region;
    // river segments from this chunk + adjacent region chunks, so heights at
    // shared boundary vertices are identical no matter which chunk computes them
    const segs = [];
    const addSegs = (ch) => {
      for (const pts of ch.rivers) {
        for (let i = 0; i < pts.length - 1; i++) {
          segs.push([pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y]);
        }
      }
    };
    addSegs(chunk);
    for (const nid of chunk.tile.neighbors) {
      if (region.polys.has(nid)) addSegs(region.getChunk(nid));
    }
    const riverW = 3 + Math.min(chunk.flow, 10) * 0.35;
    const depress = (x, z) => {
      let d2 = Infinity;
      for (const [ax, az, bx, bz] of segs) {
        const dx = bx - ax, dz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
        const px = ax + dx * t - x, pz = az + dz * t - z;
        const dd = px * px + pz * pz;
        if (dd < d2) d2 = dd;
      }
      const d = Math.sqrt(d2);
      const R = riverW + 7;
      if (d >= R) return 0;
      return Math.pow(1 - d / R, 1.5) * 4.4;
    };

    const xs = chunk.poly.map((p) => p[0]), ys = chunk.poly.map((p) => p[1]);
    const ixMin = Math.floor((Math.min(...xs) - 10) / STEP), ixMax = Math.ceil((Math.max(...xs) + 10) / STEP);
    const izMin = Math.floor((Math.min(...ys) - 10) / STEP), izMax = Math.ceil((Math.max(...ys) + 10) / STEP);
    const nx = ixMax - ixMin + 1, nz = izMax - izMin + 1;
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    const hGrid = new Float32Array(nx * nz);
    const lin = (c) => Math.pow(c / 255, 2.2);

    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        const x = (ixMin + ix) * STEP, z = (izMin + iz) * STEP;
        const s = region.sample(x, z);
        let h = this.baseHeight(s.e);
        if (segs.length && h > -2) h -= depress(x, z);
        const jit = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453 % 1) * 0.08 - 0.04;
        const rgb = sampleColor(s, jit);
        hGrid[i] = h;
        pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
        col[i * 3] = lin(rgb[0]); col[i * 3 + 1] = lin(rgb[1]); col[i * 3 + 2] = lin(rgb[2]);
      }
    }

    // quads belong to exactly one chunk: the tile owning their center
    const idx = [];
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const cx = (ixMin + ix + 0.5) * STEP, cz = (izMin + iz + 0.5) * STEP;
        if (region.tileOf(cx, cz).id !== chunk.tileId) continue;
        const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    chunk.terrainData = { ixMin, izMin, nx, nz, pos, col, idx, hGrid };
  }

  buildChunkRivers(chunk, g) {
    if (!chunk.rivers.length) return;
    const verts = [];
    const up = new THREE.Vector3(0, 1, 0);
    const riverW = 3 + Math.min(chunk.flow, 10) * 0.35;
    for (const path of chunk.rivers) {
      if (path.length < 2) continue;
      const pts = path.map((p) => new THREE.Vector3(p.x, 0, p.y));
      const curve = new THREE.CatmullRomCurve3(pts);
      const n = path.length * 4;
      const w = riverW / 2 + 2;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = curve.getPoint(t);
        const tan = curve.getTangent(t);
        const side = new THREE.Vector3().crossVectors(tan, up).setY(0).normalize().multiplyScalar(w);
        const y = Math.max(this.chunkHeightAt(chunk, p.x, p.z) + 0.45, WATER_Y - 0.1);
        const L = [p.x + side.x, y, p.z + side.z];
        const R = [p.x - side.x, y, p.z - side.z];
        if (prev) verts.push(...prev.L, ...prev.R, ...L, ...L, ...prev.R, ...R);
        prev = { L, R };
      }
    }
    if (!verts.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color: 0x2e9bd0, transparent: true, opacity: 0.85, shininess: 90,
      specular: 0x88bbdd, side: THREE.DoubleSide,
    }));
    mesh.renderOrder = 2;
    g.add(mesh);
  }

  // ---------- props ----------

  buildChunkProps(chunk, g) {
    const region = this.region;
    const rng = mulberry32(chunk.tile.seed ^ 0x51ab73c1);
    const trunks = [], cones = [], leafs = [], palms = [], cacti = [], rocks = [];
    const crystals = [], crops = [], corals = [];
    const animalSpots = [], fishSpots = [];

    const groundOk = (x, z) => {
      if (region.tileOf(x, z).id !== chunk.tileId) return -999; // stay in chunk
      return this.chunkHeightAt(chunk, x, z);
    };

    for (const c of chunk.cells) {
      if (c.features.includes('tree')) {
        const isJungle = c.biome === 'jungle' || c.features.includes('oasis');
        const isConifer = c.biome === 'taiga' || (c.biome === 'forest' && rng() < 0.65) ||
          (c.biome === 'seasonal_forest' && rng() < 0.3);
        const count = isJungle ? 4 + Math.floor(rng() * 4) : 2 + Math.floor(rng() * 4);
        for (let i = 0; i < count; i++) {
          const x = c.x + (rng() - 0.5) * HEXW * 1.15;
          const z = c.y + (rng() - 0.5) * HEXW * 1.15;
          const h = groundOk(x, z);
          if (h < 0.7) continue;
          const s = 0.75 + rng() * 0.7;
          if (isJungle) palms.push({ x, z, h, s, t: rng() });
          else if (isConifer) cones.push({ x, z, h, s, t: rng() });
          else leafs.push({ x, z, h, s, t: rng() });
          trunks.push({ x, z, h, s, palm: isJungle });
        }
      }
      if (c.features.includes('cactus')) {
        const h = groundOk(c.x, c.y);
        if (h > 0.5) cacti.push({ x: c.x + (rng() - 0.5) * 6, z: c.y + (rng() - 0.5) * 6, h, s: 0.7 + rng() * 0.8 });
      }
      if (c.features.includes('rocks')) {
        const n = 2 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const x = c.x + (rng() - 0.5) * HEXW, z = c.y + (rng() - 0.5) * HEXW;
          const h = groundOk(x, z);
          if (h > 0.3) rocks.push({ x, z, h, s: 0.8 + rng() * 1.6, t: rng() });
        }
      }
      if (c.features.includes('reef')) {
        const n = 2 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const x = c.x + (rng() - 0.5) * HEXW, z = c.y + (rng() - 0.5) * HEXW;
          const h = this.chunkHeightAt(chunk, x, z);
          if (h < WATER_Y - 0.8) corals.push({ x, z, h, s: 0.6 + rng(), t: rng() });
        }
      }

      const res = c.resource;
      if (!res) continue;
      if (ANIMALS[res]) {
        animalSpots.push({ c, res });
      } else if (FISHY[res]) {
        fishSpots.push({ c, res });
      } else if (CROPS[res] !== undefined && !c.water) {
        crops.push({ x: c.x, z: c.y, color: CROPS[res], rot: rng() * Math.PI });
      } else if (TIMBER.has(res) && !c.water) {
        for (let i = 0; i < 5; i++) {
          const x = c.x + (rng() - 0.5) * HEXW, z = c.y + (rng() - 0.5) * HEXW;
          const h = groundOk(x, z);
          if (h < 0.7) continue;
          const s = 0.9 + rng() * 0.7;
          leafs.push({ x, z, h, s, t: rng() });
          trunks.push({ x, z, h, s, palm: false });
        }
      } else if (!c.water) {
        const color = CRYSTALS[res] ?? 0x8d8d92;
        const h0 = groundOk(c.x, c.y);
        if (h0 > 0.2) {
          for (let i = 0; i < 3; i++) {
            const x = c.x + (rng() - 0.5) * 8, z = c.y + (rng() - 0.5) * 8;
            const h = groundOk(x, z);
            if (h > 0.2) rocks.push({ x, z, h, s: 1 + rng() * 1.4, t: rng() });
          }
          const n = 4 + Math.floor(rng() * 3);
          for (let i = 0; i < n; i++) {
            crystals.push({
              x: c.x + (rng() - 0.5) * 9, z: c.y + (rng() - 0.5) * 9,
              h: h0, s: 0.8 + rng() * 1.2, color, rot: rng() * Math.PI,
            });
          }
        }
      }
    }

    const dummy = new THREE.Object3D();
    const colorObj = new THREE.Color();
    const addInstanced = (geom, mat, items, place) => {
      if (!items.length) return null;
      const mesh = new THREE.InstancedMesh(geom, mat, items.length);
      mesh.castShadow = true;
      items.forEach((it, i) => {
        place(it, dummy, colorObj);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, colorObj);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      g.add(mesh);
      return mesh;
    };
    const stdMat = () => new THREE.MeshLambertMaterial({ color: 0xffffff });

    addInstanced(new THREE.CylinderGeometry(0.45, 0.7, 4, 5), stdMat(), trunks, (it, d, c) => {
      const th = it.palm ? 7 * it.s : 4 * it.s;
      d.position.set(it.x, it.h + th / 2 - 0.3, it.z);
      d.scale.set(it.s, it.palm ? 1.75 * it.s : it.s, it.s);
      d.rotation.set(0, 0, it.palm ? 0.1 : 0);
      c.setHex(0x6b4a30);
    });
    addInstanced(new THREE.ConeGeometry(3, 8.5, 6), stdMat(), cones, (it, d, c) => {
      d.position.set(it.x, it.h + 4 * it.s + 3.5 * it.s, it.z);
      d.scale.setScalar(it.s);
      d.rotation.set(0, it.t * 6, 0);
      c.setHex(0x2d6643).offsetHSL(0, 0, (it.t - 0.5) * 0.08);
    });
    addInstanced(new THREE.IcosahedronGeometry(3.4, 0), stdMat(), leafs, (it, d, c) => {
      d.position.set(it.x, it.h + 4 * it.s + 2 * it.s, it.z);
      d.scale.set(it.s, it.s * 1.05, it.s);
      d.rotation.set(it.t, it.t * 6, 0);
      c.setHex(0x3f8a46).offsetHSL(0, 0, (it.t - 0.5) * 0.1);
    });
    addInstanced(new THREE.IcosahedronGeometry(3.2, 0), stdMat(), palms, (it, d, c) => {
      d.position.set(it.x + 0.7, it.h + 7 * it.s + 0.8, it.z);
      d.scale.set(it.s * 1.25, it.s * 0.5, it.s * 1.25);
      d.rotation.set(0, it.t * 6, 0);
      c.setHex(0x2f8a3c).offsetHSL(0, 0, (it.t - 0.5) * 0.1);
    });
    addInstanced(new THREE.CylinderGeometry(0.9, 1.1, 5, 7), stdMat(), cacti, (it, d, c) => {
      d.position.set(it.x, it.h + 2.5 * it.s, it.z);
      d.scale.setScalar(it.s);
      c.setHex(0x4a8a3a);
    });
    addInstanced(new THREE.IcosahedronGeometry(1.6, 0), stdMat(), rocks, (it, d, c) => {
      d.position.set(it.x, it.h + 0.7 * it.s, it.z);
      d.scale.set(it.s, it.s * (0.7 + it.t * 0.5), it.s);
      d.rotation.set(it.t * 3, it.t * 7, it.t);
      c.setHex(0x8d8d92).offsetHSL(0, 0, (it.t - 0.5) * 0.12);
    });
    addInstanced(new THREE.OctahedronGeometry(1.1, 0), stdMat(), crystals, (it, d, c) => {
      d.position.set(it.x, it.h + 1 * it.s, it.z);
      d.scale.set(it.s * 0.7, it.s * 1.4, it.s * 0.7);
      d.rotation.set(0.3, it.rot, 0.2);
      c.setHex(it.color);
    });
    addInstanced(new THREE.BoxGeometry(9, 0.8, 2), stdMat(), cropRows(crops), (it, d, c) => {
      d.position.set(it.x, this.chunkHeightAt(chunk, it.x, it.z) + 0.5, it.z);
      d.rotation.set(0, it.rot, 0);
      c.setHex(it.color);
    });
    addInstanced(new THREE.ConeGeometry(2, 3.5, 5), stdMat(), corals, (it, d, c) => {
      d.position.set(it.x, it.h + 1.4 * it.s, it.z);
      d.scale.setScalar(it.s);
      d.rotation.set(0, it.t * 6, 0);
      c.setHex(it.t < 0.5 ? 0xd06a8a : 0x4ab8a8);
    });

    this.buildAnimals(animalSpots, fishSpots, rng, g);
  }

  buildAnimals(animalSpots, fishSpots, rng, g) {
    const parts = [];
    const box = (w, h, d, x, y, z) => {
      const geom = new THREE.BoxGeometry(w, h, d);
      geom.translate(x, y, z);
      return geom;
    };
    parts.push(box(3.2, 1.7, 1.5, 0, 2.1, 0));
    parts.push(box(1.1, 1.1, 1.1, 1.9, 3, 0));
    parts.push(box(0.4, 1.5, 0.4, 1.2, 0.75, 0.5));
    parts.push(box(0.4, 1.5, 0.4, 1.2, 0.75, -0.5));
    parts.push(box(0.4, 1.5, 0.4, -1.2, 0.75, 0.5));
    parts.push(box(0.4, 1.5, 0.4, -1.2, 0.75, -0.5));
    const quad = mergeGeometries(parts);

    const herd = [];
    for (const { c, res } of animalSpots) {
      const kind = ANIMALS[res];
      for (let i = 0; i < kind.n; i++) {
        herd.push({
          x: c.x + (rng() - 0.5) * HEXW * 2, z: c.y + (rng() - 0.5) * HEXW * 2,
          home: [c.x, c.y], ang: rng() * 6.28,
          speed: 2.5 + rng() * 2.5, s: kind.s, color: kind.c, water: false,
        });
      }
    }
    const school = [];
    for (const { c, res } of fishSpots) {
      const kind = FISHY[res];
      const cnt = res === 'whales' ? 2 : 5;
      const inRiver = !c.water && c.river;
      for (let i = 0; i < cnt; i++) {
        school.push({
          x: c.x, z: c.y, home: [c.x, c.y], ang: rng() * 6.28,
          phase: rng() * 6.28, radius: inRiver ? 2.5 : 6 + rng() * 8,
          baseY: inRiver ? null : WATER_Y - 0.9,
          speed: 0.5 + rng() * 0.6, s: kind.s, color: kind.c, water: true,
        });
      }
    }

    const colorObj = new THREE.Color();
    if (herd.length) {
      const mesh = new THREE.InstancedMesh(quad, new THREE.MeshLambertMaterial({ color: 0xffffff }), herd.length);
      mesh.castShadow = true;
      herd.forEach((a, i) => {
        colorObj.setHex(a.color);
        mesh.setColorAt(i, colorObj);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      g.add(mesh);
      this.movers.push({ mesh, items: herd });
    }
    if (school.length) {
      const fin = new THREE.ConeGeometry(0.8, 2.6, 4);
      fin.rotateX(Math.PI / 2);
      const mesh = new THREE.InstancedMesh(fin, new THREE.MeshLambertMaterial({ color: 0xffffff }), school.length);
      school.forEach((a, i) => {
        colorObj.setHex(a.color);
        mesh.setColorAt(i, colorObj);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      g.add(mesh);
      this.movers.push({ mesh, items: school });
    }
    if (!this.moverDummy) this.moverDummy = new THREE.Object3D();
  }

  animate(dt) {
    if (!this.movers.length) return;
    const d = this.moverDummy;
    for (const { mesh, items } of this.movers) {
      items.forEach((a, i) => {
        if (a.water) {
          a.ang += a.speed * dt;
          a.x = a.home[0] + Math.cos(a.ang) * a.radius;
          a.z = a.home[1] + Math.sin(a.ang) * a.radius;
          const base = a.baseY ?? this.meshHeightAt(a.x, a.z) + 0.3;
          d.position.set(a.x, base + Math.sin(a.ang * 3 + a.phase) * 0.4, a.z);
          d.rotation.set(0, -a.ang, 0);
          d.scale.setScalar(a.s);
        } else {
          a.ang += (Math.random() - 0.5) * 1.6 * dt;
          const hd = Math.hypot(a.x - a.home[0], a.z - a.home[1]);
          if (hd > HEXW * 2.5) {
            const toHome = Math.atan2(a.home[1] - a.z, a.home[0] - a.x);
            a.ang += (((toHome - a.ang + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * 1.5 * dt;
          }
          const nx = a.x + Math.cos(a.ang) * a.speed * dt;
          const nz = a.z + Math.sin(a.ang) * a.speed * dt;
          const owner = this.region.tileOf(nx, nz);
          const h = this.meshHeightAt(nx, nz);
          if (h < 0.6 || !this.region.discovered.has(owner.id)) {
            a.ang += Math.PI / 2;
          } else {
            a.x = nx; a.z = nz; a.h = h;
          }
          d.position.set(a.x, (a.h ?? this.meshHeightAt(a.x, a.z)), a.z);
          d.rotation.set(0, -a.ang, 0);
          d.scale.setScalar(a.s);
        }
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------- settlements & villagers ----------

  bindInput() {
    let downX = 0, downY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
      this.handleClick(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.placementMode || !this.region) return;
      const hit = this.groundPoint(e.clientX, e.clientY);
      if (!hit) {
        this.ghost.visible = false;
        return;
      }
      const ok = this.validSite(hit.x, hit.z);
      this.ghost.position.set(hit.x, this.meshHeightAt(hit.x, hit.z), hit.z);
      this.ghostMat.color.setHex(ok ? 0x5aff7a : 0xff5a5a);
      this.ghost.visible = true;
    });
  }

  setRay(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  groundPoint(clientX, clientY) {
    if (!this.terrains.length) return null;
    this.setRay(clientX, clientY);
    const hits = this.raycaster.intersectObjects(this.terrains, false);
    return hits.length ? hits[0].point : null;
  }

  validSite(x, z) {
    const owner = this.inRegion(x, z);
    if (!owner || !this.region.discovered.has(owner.id)) return false;
    const h = this.meshHeightAt(x, z);
    if (h < 0.8) return false;
    for (const d of [[14, 0], [-14, 0], [0, 14], [0, -14]]) {
      const hh = this.meshHeightAt(x + d[0], z + d[1]);
      if (hh < 0.8 || Math.abs(hh - h) > 6) return false;
    }
    for (const s of this.region.settlements) {
      if (Math.hypot(s.x - x, s.z - z) < 55) return false;
    }
    return true;
  }

  togglePlacement(on = !this.placementMode) {
    this.placementMode = on;
    if (!on) this.ghost.visible = false;
    if (on) this.deselectCiv();
    this.onPlacement?.(on);
  }

  handleClick(clientX, clientY) {
    if (!this.region) return;
    if (this.placementMode) {
      const hit = this.groundPoint(clientX, clientY);
      if (hit && this.validSite(hit.x, hit.z)) {
        this.foundSettlement(hit.x, hit.z);
        this.togglePlacement(false);
      }
      return;
    }
    this.setRay(clientX, clientY);
    let hits = this.raycaster.intersectObjects(this.civMeshes, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.civ) o = o.parent;
      if (o) {
        this.selectedCiv = o.userData.civ;
        this.civRing.visible = true;
        this.ring.visible = false;
        return;
      }
    }
    hits = this.raycaster.intersectObjects(this.settlementMeshes, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.settlement) o = o.parent;
      if (o) {
        this.onSettlement?.(o.userData.settlement);
        return;
      }
    }
    if (this.selectedCiv) {
      // move order: terrain or fog (villagers march into the unknown)
      const targets = [...this.terrains, ...this.fogSlabs.values()];
      const tHits = this.raycaster.intersectObjects(targets, false);
      if (tHits.length) {
        const p = tHits[0].point;
        const owner = this.inRegion(p.x, p.z);
        if (owner) {
          this.selectedCiv.target = [p.x, p.z];
          this.moveMarker.position.set(p.x, Math.max(this.meshHeightAt(p.x, p.z), 0) + 0.4, p.z);
          this.moveMarker.visible = true;
        }
      }
      return;
    }
    const hit = this.groundPoint(clientX, clientY);
    if (!hit) return;
    const cell = this.cellAtPoint(hit.x, hit.z);
    if (cell) {
      this.setSelected(cell);
      this.onInfo?.(cell);
    }
  }

  cellAtPoint(x, z) {
    const r = Math.round(z / ROWH);
    const q = Math.round(x / HEXW - r / 2);
    const cell = this.region.cells.get(q + ',' + r);
    return cell && this.region.discovered.has(cell.tid) ? cell : null;
  }

  deselectCiv() {
    this.selectedCiv = null;
    this.civRing.visible = false;
    this.moveMarker.visible = false;
  }

  foundSettlement(x, z) {
    const rng = mulberry32((Math.round(x) * 31 + Math.round(z) * 7) ^ this.region.anchor.seed);
    const SYL = ['ka', 'zor', 'rim', 'tha', 'vel', 'un', 'dra', 'mo', 'qui', 'lex',
      'ar', 'ten', 'bel', 'os', 'nia', 'gul', 'fer', 'wyn', 'ash', 'tor'];
    let name = '';
    const sylCount = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < sylCount; i++) name += SYL[Math.floor(rng() * SYL.length)];
    name = name[0].toUpperCase() + name.slice(1);

    const s = { x, z, name, founded: Date.now() };
    this.region.settlements.push(s);
    this.addSettlementMeshes(s);

    const CLOTHES = [0x4a7ab5, 0xb55a4a, 0x5ab55a, 0xb5a04a, 0x8a5ab5, 0x4ab5a8];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rng();
      const civ = {
        x: x + Math.cos(a) * 22, z: z + Math.sin(a) * 22,
        color: CLOTHES[Math.floor(rng() * CLOTHES.length)],
        home: name, target: null, speed: 9, phase: rng() * 6.28,
      };
      this.region.civs.push(civ);
      this.addCivMesh(civ);
    }
    this.onSettlement?.(s);
  }

  addSettlementMeshes(s) {
    const rng = mulberry32((Math.round(s.x) * 31 + Math.round(s.z) * 7) ^ this.region.anchor.seed);
    const g = new THREE.Group();
    const h = this.meshHeightAt(s.x, s.z);
    const wall = new THREE.MeshLambertMaterial({ color: 0xc9a876 });
    const wallHall = new THREE.MeshLambertMaterial({ color: 0xb5906a });
    const roofM = new THREE.MeshLambertMaterial({ color: 0x8a4a3a });
    const padM = new THREE.MeshLambertMaterial({ color: 0x8a7a62 });

    const pad = new THREE.Mesh(new THREE.CylinderGeometry(16, 18, 2.4, 8), padM);
    g.add(pad);

    const house = (w, hh, d, mat) => {
      const hg = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
      body.position.y = hh / 2;
      const r = d * 0.72;
      const roofGeo = new THREE.CylinderGeometry(r, r, w * 1.08, 3, 1);
      roofGeo.rotateZ(Math.PI / 2);
      roofGeo.scale(1, 0.62, 1);
      const roof = new THREE.Mesh(roofGeo, roofM);
      roof.position.y = hh + r * 0.31;
      hg.add(body, roof);
      hg.traverse((o) => { o.castShadow = true; });
      return hg;
    };

    const hall = house(9, 6, 7, wallHall);
    hall.position.set(0, 1.1, 0);
    g.add(hall);
    for (let i = 0; i < 4; i++) {
      const a = rng() * Math.PI * 2;
      const hut = house(4.5, 3.2, 4, wall);
      hut.position.set(Math.cos(a) * 11.5, 1.1, Math.sin(a) * 11.5);
      hut.rotation.y = rng() * Math.PI;
      g.add(hut);
    }
    g.position.set(s.x, h - 0.8, s.z);
    g.userData.settlement = s;
    this.group.add(g);
    this.settlementMeshes.push(g);
  }

  addCivMesh(civ) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.75, 1.5, 3, 8),
      new THREE.MeshLambertMaterial({ color: civ.color }),
    );
    body.position.y = 1.6;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 10, 8),
      new THREE.MeshLambertMaterial({ color: 0xd9a878 }),
    );
    head.position.y = 3.2;
    g.add(body, head);
    g.traverse((o) => { o.castShadow = true; });
    g.position.set(civ.x, this.meshHeightAt(civ.x, civ.z), civ.z);
    g.userData.civ = civ;
    civ.mesh = g;
    this.group.add(g);
    this.civMeshes.push(g);
  }

  updateCivs(dt, t) {
    for (const civ of this.region.civs) {
      const g = civ.mesh;
      if (!g) continue;
      let bob = 0;
      if (civ.target) {
        const dx = civ.target[0] - civ.x, dz = civ.target[1] - civ.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1.2) {
          civ.target = null;
          if (this.selectedCiv === civ) this.moveMarker.visible = false;
        } else {
          const step = Math.min(dist, civ.speed * dt);
          const nx = civ.x + (dx / dist) * step;
          const nz = civ.z + (dz / dist) * step;
          const owner = this.inRegion(nx, nz);
          let blocked = !owner;
          if (owner && !this.region.discovered.has(owner.id)) {
            this.discoverTile(owner.id); // a settler walks into the fog
          }
          // villagers ford carved river channels but refuse real water
          if (!blocked && this.region.sample(nx, nz).water) blocked = true;
          if (blocked) {
            civ.target = null;
            if (this.selectedCiv === civ) this.moveMarker.visible = false;
          } else {
            civ.x = nx;
            civ.z = nz;
            g.rotation.y = -Math.atan2(dz, dx) + Math.PI / 2;
            bob = Math.abs(Math.sin(t * 11 + civ.phase)) * 0.5;
          }
        }
      }
      g.position.set(civ.x, this.meshHeightAt(civ.x, civ.z) + bob, civ.z);
    }
    if (this.selectedCiv?.mesh) {
      const m = this.selectedCiv.mesh;
      this.civRing.position.set(m.position.x, m.position.y + 0.5, m.position.z);
    }
    if (this.moveMarker.visible) {
      const p = 1 + Math.sin(t * 6) * 0.15;
      this.moveMarker.scale.set(p, p, 1);
    }
  }

  // hover probe for the terrain tooltip
  probe(clientX, clientY) {
    const hit = this.groundPoint(clientX, clientY);
    if (!hit) return null;
    return this.cellAtPoint(hit.x, hit.z);
  }

  setSelected(cell) {
    if (!cell) {
      this.ring.visible = false;
      return;
    }
    this.ring.position.set(cell.x, this.meshHeightAt(cell.x, cell.y) + 0.8, cell.y);
    this.ring.visible = true;
  }

  render() {
    const canvas = this.canvas;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const pr = this.renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.animate(dt);
    if (this.region) this.updateCivs(dt, this.clock.elapsedTime);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

function cropRows(crops) {
  const rows = [];
  for (const f of crops) {
    for (let i = -1; i <= 1; i++) {
      rows.push({
        x: f.x + Math.sin(f.rot) * i * 3.2,
        z: f.z + Math.cos(f.rot) * i * 3.2,
        rot: f.rot,
        color: f.color,
      });
    }
  }
  return rows;
}
