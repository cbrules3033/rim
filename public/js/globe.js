// Three.js globe renderer: stylized low-poly planet with extruded tiles.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const R = 100;       // planet radius (scene units)
const LIFT = 7;      // max land extrusion
const RIVER_COLOR = 0x3aa7e0;

export class Globe {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070c);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
    this.camera.position.set(0, R * 0.7, R * 3.1);
    // light rides with the camera so the planet is always lit where you look
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(0.6 * R, 0.8 * R, 1.5 * R);
    this.camera.add(sun);
    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0x8a93a8, 0.85));

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = R * 1.25;
    this.controls.maxDistance = R * 4.5;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.4;
    canvas.addEventListener('pointerdown', () => { this.controls.autoRotate = false; }, { once: true });

    this.addStars();
    this.addAtmosphere();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.group = null;
    this.world = null;

    this.hoverLine = this.makeOutline(0xffffff, 0.45);
    this.selectLine = this.makeOutline(0x4cc2ff, 1);
  }

  addStars() {
    const pos = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(2000 + Math.random() * 1500);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xbac4d6, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.8,
    })));
  }

  addAtmosphere() {
    const m = new THREE.MeshBasicMaterial({
      color: 0x4cc2ff, transparent: true, opacity: 0.07, side: THREE.BackSide,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.06, 48, 32), m));
  }

  makeOutline(color, opacity) {
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
    );
    line.visible = false;
    line.renderOrder = 10;
    this.scene.add(line);
    return line;
  }

  tileLift(t) {
    return t.water ? 0 : Math.pow(t.elevAbove, 1.15) * LIFT;
  }

  setWorld(world) {
    this.world = world;
    if (this.group) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.scene.remove(this.group);
    }
    this.group = new THREE.Group();
    this.hoverLine.visible = false;
    this.selectLine.visible = false;

    const pos = [], col = [], faceTile = [];
    const rpos = [];

    const push = (p, r, c) => {
      pos.push(p[0] * r, p[1] * r, p[2] * r);
      col.push(c[0], c[1], c[2]);
    };

    for (const t of world.tiles) {
      const lift = this.tileLift(t);
      const r = R + lift;
      const cs = t.corners, n = cs.length;
      // top cap (fan)
      for (let k = 0; k < n; k++) {
        push(t.center, r, t.rgbF);
        push(cs[k], r, t.rgbF);
        push(cs[(k + 1) % n], r, t.rgbF);
        faceTile.push(t.id);
      }
      // skirt walls down to sea level
      if (lift > 0.05) {
        for (let k = 0; k < n; k++) {
          const a = cs[k], b = cs[(k + 1) % n];
          push(a, r, t.sideF); push(a, R, t.sideF); push(b, R, t.sideF);
          faceTile.push(t.id);
          push(a, r, t.sideF); push(b, R, t.sideF); push(b, r, t.sideF);
          faceTile.push(t.id);
        }
      }
      // river ribbons (each tile draws its half to the shared edge midpoint)
      for (const d of t.riverN) {
        const mid = t.edgeMid[d];
        const w = (0.22 + Math.min(t.flow, 10) * 0.05) / R;
        const dir = [mid[0] - t.center[0], mid[1] - t.center[1], mid[2] - t.center[2]];
        let side = [
          dir[1] * t.center[2] - dir[2] * t.center[1],
          dir[2] * t.center[0] - dir[0] * t.center[2],
          dir[0] * t.center[1] - dir[1] * t.center[0],
        ];
        const sl = Math.hypot(...side) || 1;
        side = side.map((x) => (x / sl) * w);
        const rr = r + 0.25;
        const quad = [
          [t.center[0] + side[0], t.center[1] + side[1], t.center[2] + side[2]],
          [t.center[0] - side[0], t.center[1] - side[1], t.center[2] - side[2]],
          [mid[0] - side[0], mid[1] - side[1], mid[2] - side[2]],
          [mid[0] + side[0], mid[1] + side[1], mid[2] + side[2]],
        ].map((p) => {
          const l = Math.hypot(...p);
          return [(p[0] / l) * rr, (p[1] / l) * rr, (p[2] / l) * rr];
        });
        rpos.push(...quad[0], ...quad[1], ...quad[2], ...quad[0], ...quad[2], ...quad[3]);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    this.tileMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.faceTile = faceTile;
    this.group.add(this.tileMesh);

    if (rpos.length) {
      const rgeo = new THREE.BufferGeometry();
      rgeo.setAttribute('position', new THREE.Float32BufferAttribute(rpos, 3));
      rgeo.computeVertexNormals();
      this.group.add(new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({ color: RIVER_COLOR })));
    }

    this.scene.add(this.group);
  }

  pick(clientX, clientY) {
    if (!this.tileMesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.tileMesh, false);
    if (!hits.length) return null;
    return this.world.tiles[this.faceTile[hits[0].faceIndex]];
  }

  outline(line, tile) {
    if (!tile) {
      line.visible = false;
      return;
    }
    const r = R + this.tileLift(tile) + 0.45;
    const pts = tile.corners.map((c) => new THREE.Vector3(c[0] * r, c[1] * r, c[2] * r));
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    line.visible = true;
  }

  setHovered(tile) { this.outline(this.hoverLine, tile); }
  setSelected(tile) { this.outline(this.selectLine, tile); }

  render() {
    const canvas = this.canvas;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * this.renderer.getPixelRatio()) ||
        canvas.height !== Math.floor(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    // slower rotation when zoomed in
    const dist = this.camera.position.length();
    this.controls.rotateSpeed = Math.max(0.06, Math.min(1, (dist - R) / R));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
