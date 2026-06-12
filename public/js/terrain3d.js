// 3D landscape renderer for local tile maps: smooth low-poly terrain, real
// water, carved meandering rivers, dense instanced forests, rock piles, ore
// crystals, crop fields, and animals that wander around.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './rng.js';
import { CELL, HEXW, ROWH, sampleColor } from './localmap.js';

const HSCALE = 62;      // land elevation scale (map units)
const DSCALE = 20;      // seabed depth scale
const WATER_Y = -0.55;
const GRID_RES = 168;   // terrain vertices per side

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
  obsidian2: 0x111118, oil: 0x1c1c20, gas: 0x9fb8c8, geothermal: 0xe06a3a,
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
  constructor(canvas, onPick) {
    this.canvas = canvas;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070c);
    this.scene.fog = new THREE.Fog(0x05070c, 1000, 2400);

    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);

    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x46412e, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
    sun.position.set(280, 460, 200);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -560; sc.right = 560; sc.top = 560; sc.bottom = -560;
    sc.near = 50; sc.far = 1400;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = 1.5;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 1600;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.clock = new THREE.Clock();
    this.group = null;
    this.map = null;
    this.movers = [];

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(CELL * 0.85, 0.45, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0x4cc2ff }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.scene.add(this.ring);
  }

  // ---------- terrain field helpers ----------

  baseHeight(e) {
    const sea = this.map.sea;
    if (e >= sea) return Math.pow((e - sea) / (1 - sea), 1.05) * HSCALE;
    return -Math.min(1, (sea - e) / sea) * DSCALE;
  }

  riverDepress(x, z) {
    let d2 = Infinity;
    for (const [ax, az, bx, bz] of this.riverSegs) {
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      const px = ax + dx * t - x, pz = az + dz * t - z;
      const dd = px * px + pz * pz;
      if (dd < d2) d2 = dd;
    }
    const d = Math.sqrt(d2);
    const R = this.riverW + 7;
    if (d >= R) return 0;
    return Math.pow(1 - d / R, 1.5) * 4.4;
  }

  // height of the *rendered* terrain surface (bilinear over the height grid) —
  // use this for placing anything on the ground so nothing floats or sinks
  meshHeightAt(x, z) {
    const { hGrid, hExt, hStep } = this;
    const fx = (x + hExt) / hStep, fz = (z + hExt) / hStep;
    const ix = Math.max(0, Math.min(GRID_RES - 2, Math.floor(fx)));
    const iz = Math.max(0, Math.min(GRID_RES - 2, Math.floor(fz)));
    const tx = fx - ix, tz = fz - iz;
    const h00 = hGrid[iz * GRID_RES + ix], h10 = hGrid[iz * GRID_RES + ix + 1];
    const h01 = hGrid[(iz + 1) * GRID_RES + ix], h11 = hGrid[(iz + 1) * GRID_RES + ix + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  heightAt(x, z) {
    let h = this.baseHeight(this.map.sample(x, z).e);
    if (this.riverSegs.length && h > -2) h -= this.riverDepress(x, z);
    return h;
  }

  // ---------- scene building ----------

  setMap(map) {
    if (this.group) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.scene.remove(this.group);
    }
    this.map = map;
    this.movers = [];
    this.ring.visible = false;
    this.group = new THREE.Group();

    this.riverW = 3 + Math.min(map.tile.flow, 10) * 0.35;
    this.riverSegs = [];
    for (const path of map.rivers) {
      for (let i = 0; i < path.length - 1; i++) {
        this.riverSegs.push([path[i].x, path[i].y, path[i + 1].x, path[i + 1].y]);
      }
    }

    this.buildTerrain();
    this.buildWater();
    this.buildRivers();
    this.buildProps();
    this.scene.add(this.group);

    this.camera.position.set(0, 380, 500);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  distOutside(x, y) {
    const poly = this.map.poly;
    let inside = false, min = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      const dx = xj - xi, dy = yj - yi;
      const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy)));
      const px = xi + dx * t - x, py = yi + dy * t - y;
      min = Math.min(min, px * px + py * py);
    }
    return inside ? 0 : Math.sqrt(min);
  }

  buildTerrain() {
    const map = this.map;
    const ext = Math.max(...map.poly.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) + 26;
    const step = (2 * ext) / (GRID_RES - 1);
    this.hExt = ext;
    this.hStep = step;
    this.hGrid = new Float32Array(GRID_RES * GRID_RES);
    const N = GRID_RES;
    const pos = new Float32Array(N * N * 3);
    const col = new Float32Array(N * N * 3);
    const out = new Float32Array(N * N);
    const lin = (c) => Math.pow(c / 255, 2.2);

    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const x = -ext + ix * step, z = -ext + iz * step;
        const dOut = this.distOutside(x, z);
        out[i] = dOut;
        let h, rgb;
        if (dOut > 40) {
          h = -60;
          rgb = [24, 22, 21];
        } else {
          const s = map.sample(x, z);
          h = this.baseHeight(s.e);
          if (this.riverSegs.length && h > -2) h -= this.riverDepress(x, z);
          const jit = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453 % 1) * 0.08 - 0.04;
          rgb = sampleColor(s, jit);
          if (dOut > 0) {
            const t = Math.min(1, dOut / 26);
            h = h * (1 - t) - 62 * t * t;            // cliff edge of the diorama
            rgb = [rgb[0] + (38 - rgb[0]) * t, rgb[1] + (34 - rgb[1]) * t, rgb[2] + (31 - rgb[2]) * t];
          }
        }
        this.hGrid[i] = h;
        pos[i * 3] = x; pos[i * 3 + 1] = h; pos[i * 3 + 2] = z;
        col[i * 3] = lin(rgb[0]); col[i * 3 + 1] = lin(rgb[1]); col[i * 3 + 2] = lin(rgb[2]);
      }
    }

    const indices = [];
    for (let iz = 0; iz < N - 1; iz++) {
      for (let ix = 0; ix < N - 1; ix++) {
        const a = iz * N + ix, b = a + 1, c = a + N, d = c + 1;
        if (out[a] > 38 && out[b] > 38 && out[c] > 38 && out[d] > 38) continue;
        indices.push(a, c, b, b, c, d);
      }
    }

    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(indices);
    geo = geo.toNonIndexed();               // faceted low-poly shading
    geo.computeVertexNormals();
    this.terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  buildWater() {
    const poly = this.map.poly;
    const verts = [];
    for (let i = 1; i < poly.length - 1; i++) {
      verts.push(poly[0][0], WATER_Y, poly[0][1]);
      verts.push(poly[i][0], WATER_Y, poly[i][1]);
      verts.push(poly[i + 1][0], WATER_Y, poly[i + 1][1]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhongMaterial({
      color: 0x2486b8, transparent: true, opacity: 0.72,
      shininess: 90, specular: 0x6699bb, side: THREE.DoubleSide,
    });
    const water = new THREE.Mesh(geo, mat);
    water.renderOrder = 1;
    this.group.add(water);
  }

  buildRivers() {
    if (!this.map.rivers.length) return;
    const verts = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const path of this.map.rivers) {
      if (path.length < 2) continue;
      // smooth the course in the horizontal plane, then drape it over the
      // rendered terrain surface so it always sits in its carved channel
      const pts = path.map((c) => new THREE.Vector3(c.x, 0, c.y));
      const curve = new THREE.CatmullRomCurve3(pts);
      const n = path.length * 4;
      const w = this.riverW / 2 + 2;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = curve.getPoint(t);
        const tan = curve.getTangent(t);
        const side = new THREE.Vector3().crossVectors(tan, up).setY(0).normalize().multiplyScalar(w);
        const y = Math.max(this.meshHeightAt(p.x, p.z) + 0.45, WATER_Y - 0.1);
        const L = [p.x + side.x, y, p.z + side.z];
        const R = [p.x - side.x, y, p.z - side.z];
        if (prev) {
          verts.push(...prev.L, ...prev.R, ...L, ...L, ...prev.R, ...R);
        }
        prev = { L, R };
      }
    }
    if (!verts.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshPhongMaterial({
      color: 0x2e9bd0, transparent: true, opacity: 0.85, shininess: 90,
      specular: 0x88bbdd, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 2;
    this.group.add(mesh);
  }

  // ---------- props ----------

  buildProps() {
    const map = this.map;
    const rng = mulberry32(map.tile.seed ^ 0x51ab73c1);
    const trunks = [], cones = [], leafs = [], palms = [], cacti = [], rocks = [];
    const crystals = [], crops = [], corals = [];
    const animalSpots = [], fishSpots = [];

    const groundOk = (x, z) => {
      if (this.distOutside(x, z) > 0) return -999;
      return this.meshHeightAt(x, z);
    };

    for (const c of map.cells) {
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
          const h = this.meshHeightAt(x, z);
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
        // mineral / material deposit: rock pile + colored crystals
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

    // ---- instanced meshes ----
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
      this.group.add(mesh);
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
    addInstanced(new THREE.BoxGeometry(9, 0.8, 2), stdMat(), cropsRows(crops), (it, d, c) => {
      d.position.set(it.x, this.meshHeightAt(it.x, it.z) + 0.5, it.z);
      d.rotation.set(0, it.rot, 0);
      c.setHex(it.color);
    });
    addInstanced(new THREE.ConeGeometry(2, 3.5, 5), stdMat(), corals, (it, d, c) => {
      d.position.set(it.x, it.h + 1.4 * it.s, it.z);
      d.scale.setScalar(it.s);
      d.rotation.set(0, it.t * 6, 0);
      c.setHex(it.t < 0.5 ? 0xd06a8a : 0x4ab8a8);
    });

    this.buildAnimals(animalSpots, fishSpots, rng);
  }

  buildAnimals(animalSpots, fishSpots, rng) {
    // generic low-poly quadruped: body + head + 4 legs
    const parts = [];
    const box = (w, h, d, x, y, z) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      return g;
    };
    parts.push(box(3.2, 1.7, 1.5, 0, 2.1, 0));         // body
    parts.push(box(1.1, 1.1, 1.1, 1.9, 3, 0));          // head
    parts.push(box(0.4, 1.5, 0.4, 1.2, 0.75, 0.5));
    parts.push(box(0.4, 1.5, 0.4, 1.2, 0.75, -0.5));
    parts.push(box(0.4, 1.5, 0.4, -1.2, 0.75, 0.5));
    parts.push(box(0.4, 1.5, 0.4, -1.2, 0.75, -0.5));
    const quad = mergeGeometries(parts);

    const herd = [];
    for (const { c, res } of animalSpots) {
      const kind = ANIMALS[res];
      for (let i = 0; i < kind.n; i++) {
        const x = c.x + (rng() - 0.5) * HEXW * 2;
        const z = c.y + (rng() - 0.5) * HEXW * 2;
        herd.push({
          x, z, home: [c.x, c.y], ang: rng() * 6.28,
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

    const dummy = new THREE.Object3D();
    const colorObj = new THREE.Color();
    if (herd.length) {
      const mesh = new THREE.InstancedMesh(quad, new THREE.MeshLambertMaterial({ color: 0xffffff }), herd.length);
      mesh.castShadow = true;
      herd.forEach((a, i) => {
        colorObj.setHex(a.color);
        mesh.setColorAt(i, colorObj);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.movers.push({ mesh, items: herd });
    }
    if (school.length) {
      const fin = new THREE.ConeGeometry(0.8, 2.6, 4);
      fin.rotateX(Math.PI / 2); // point forward
      const mesh = new THREE.InstancedMesh(fin, new THREE.MeshLambertMaterial({ color: 0xffffff }), school.length);
      school.forEach((a, i) => {
        colorObj.setHex(a.color);
        mesh.setColorAt(i, colorObj);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.group.add(mesh);
      this.movers.push({ mesh, items: school });
    }
    this.moverDummy = dummy;
  }

  animate(dt) {
    if (!this.movers.length) return;
    const d = this.moverDummy;
    for (const { mesh, items } of this.movers) {
      items.forEach((a, i) => {
        if (a.water) {
          // swim in lazy circles around home
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
          const h = this.meshHeightAt(nx, nz);
          if (h < 0.6 || this.distOutside(nx, nz) > 0) {
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

  // ---------- picking ----------

  pick(clientX, clientY) {
    if (!this.terrain) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain, false);
    if (!hits.length) return null;
    const { x, z } = hits[0].point;
    const r = Math.round(z / ROWH);
    const q = Math.round(x / HEXW - r / 2);
    return this.map.byKey.get(q + ',' + r) || null;
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

// each crop deposit becomes a few field rows
function cropsRows(crops) {
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
