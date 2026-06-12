// Canvas renderer for local tile maps: stylized isometric hex cells with
// elevation extrusion, pan/zoom, hover + click picking.

import { CELL, HEXW, ROWH, cellIcon } from './localmap.js';

const SQ = 0.58;          // isometric vertical squash
const LIFT = 26;          // max elevation extrusion (screen units at zoom 1)
const RIVER_COLOR = '#3aa7e0';

// pointy-top corner offsets, squashed (same order as the old globe-flat view)
const CORNERS = [];
for (let i = 0; i < 6; i++) {
  const a = ((60 * i - 30) * Math.PI) / 180;
  CORNERS.push({ x: CELL * Math.cos(a), y: CELL * Math.sin(a) * SQ });
}

export class MapView {
  constructor(canvas, onPick) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.map = null;
    this.hovered = null;
    this.selected = null;
    this.dirty = true;
    this.bindInput();
  }

  setMap(map) {
    this.map = map;
    this.hovered = this.selected = null;
    // draw order: back to front
    this.sorted = [...map.cells].sort((a, b) => a.r - b.r || a.q - b.q);
    this.byKey = new Map(map.cells.map((c) => [c.q + ',' + c.r, c]));
    this.cam.x = 0;
    this.cam.y = 0;
    const cw = this.canvas.clientWidth || 800, ch = this.canvas.clientHeight || 600;
    const extent = Math.max(...map.poly.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y) * SQ)));
    this.cam.zoom = Math.min(cw, ch / SQ) / (extent * 2.35);
    this.dirty = true;
  }

  lift(c) {
    return c.water ? 0 : Math.pow(c.elevAbove, 1.1) * LIFT;
  }

  // cell center in screen-space world coords (squash applied)
  pos(c) {
    return { x: c.x, y: c.y * SQ };
  }

  draw() {
    if (!this.map) return;
    const { ctx, canvas, cam } = this;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#070a10';
    ctx.fillRect(0, 0, cw, ch);
    const z = cam.zoom;
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (cw / 2 - cam.x * z) * dpr, (ch / 2 - cam.y * z) * dpr);

    // tile boundary glow (the hex/pentagon outline of the globe tile)
    ctx.beginPath();
    this.map.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y * SQ) : ctx.moveTo(x, y * SQ)));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(76,194,255,0.25)';
    ctx.lineWidth = 3 / z;
    ctx.stroke();

    const showIcons = z * CELL >= 7;
    for (const c of this.sorted) this.drawCell(c, showIcons, z);
    this.drawRivers(z);
    this.drawOutline(this.hovered, 'rgba(255,255,255,0.6)', 1.5 / z);
    this.drawOutline(this.selected, '#4cc2ff', 2.5 / z);
    if (showIcons) this.drawIcons();
    this.dirty = false;
  }

  drawCell(c, showIcons, z) {
    const { ctx } = this;
    const { x, y } = this.pos(c);
    const lift = this.lift(c);
    const ty = y - lift;
    if (lift > 0.5) {
      ctx.fillStyle = c.sideColor1;
      ctx.beginPath();
      ctx.moveTo(x + CORNERS[1].x, ty + CORNERS[1].y);
      ctx.lineTo(x + CORNERS[2].x, ty + CORNERS[2].y);
      ctx.lineTo(x + CORNERS[2].x, y + CORNERS[2].y + 1);
      ctx.lineTo(x + CORNERS[1].x, y + CORNERS[1].y + 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = c.sideColor2;
      ctx.beginPath();
      ctx.moveTo(x + CORNERS[2].x, ty + CORNERS[2].y);
      ctx.lineTo(x + CORNERS[3].x, ty + CORNERS[3].y);
      ctx.lineTo(x + CORNERS[3].x, y + CORNERS[3].y + 1);
      ctx.lineTo(x + CORNERS[2].x, y + CORNERS[2].y + 1);
      ctx.closePath();
      ctx.fill();
    }
    this.cellPath(c, ty);
    ctx.fillStyle = c.color;
    ctx.fill();
    if (z >= 1.6) {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }

  cellPath(c, ty) {
    const { ctx } = this;
    const x = c.x;
    ctx.beginPath();
    ctx.moveTo(x + CORNERS[0].x, ty + CORNERS[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(x + CORNERS[i].x, ty + CORNERS[i].y);
    ctx.closePath();
  }

  drawRivers(z) {
    const { ctx } = this;
    ctx.strokeStyle = RIVER_COLOR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.2 + Math.min(this.map.tile.flow, 10) * 0.3;
    for (const path of this.map.rivers) {
      if (path.length < 2) continue;
      ctx.beginPath();
      path.forEach((c, i) => {
        const { x, y } = this.pos(c);
        const ty = y - this.lift(c) + 1;
        if (i) ctx.lineTo(x, ty);
        else ctx.moveTo(x, ty);
      });
      ctx.stroke();
    }
  }

  drawIcons() {
    const { ctx } = this;
    ctx.font = '9px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of this.sorted) {
      const icon = cellIcon(c);
      if (!icon) continue;
      const { x, y } = this.pos(c);
      ctx.fillText(icon, x, y - this.lift(c) + 0.5);
    }
  }

  drawOutline(c, color, width) {
    if (!c) return;
    const { ctx } = this;
    this.cellPath(c, this.pos(c).y - this.lift(c));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  pick(mx, my) {
    if (!this.map) return null;
    const { cam, canvas } = this;
    const wx = (mx - canvas.clientWidth / 2) / cam.zoom + cam.x;
    const wy = (my - canvas.clientHeight / 2) / cam.zoom + cam.y;
    let best = null, bd = Infinity;
    // cells are drawn lifted (up-screen), so the real row may be below the guess
    const rGuess = Math.round(wy / SQ / ROWH);
    for (let r = rGuess - 1; r <= rGuess + 3; r++) {
      const qGuess = Math.round(wx / HEXW - r / 2);
      for (let q = qGuess - 1; q <= qGuess + 1; q++) {
        const c = this.byKey.get(q + ',' + r);
        if (!c) continue;
        const p = this.pos(c);
        const dx = wx - p.x, dy = wy - (p.y - this.lift(c));
        const d = dx * dx + (dy / SQ) * (dy / SQ);
        if (d < bd) { bd = d; best = c; }
      }
    }
    return bd <= CELL * CELL * 1.5 ? best : null;
  }

  bindInput() {
    const canvas = this.canvas;
    let dragging = false, moved = false, lx = 0, ly = 0;
    let pinch = 0;
    const touches = new Map();

    canvas.addEventListener('pointerdown', (e) => {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragging = true;
      moved = false;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        pinch = d;
        moved = true;
        return;
      }
      if (dragging) {
        const dx = e.clientX - lx, dy = e.clientY - ly;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        this.cam.x -= dx / this.cam.zoom;
        this.cam.y -= dy / this.cam.zoom;
        lx = e.clientX;
        ly = e.clientY;
        this.dirty = true;
      } else if (e.pointerType === 'mouse') {
        const r = canvas.getBoundingClientRect();
        const c = this.pick(e.clientX - r.left, e.clientY - r.top);
        if (c !== this.hovered) {
          this.hovered = c;
          this.dirty = true;
        }
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = 0;
      if (dragging && !moved) {
        const r = canvas.getBoundingClientRect();
        const c = this.pick(e.clientX - r.left, e.clientY - r.top);
        this.selected = c;
        this.dirty = true;
        this.onPick(c);
      }
      if (!touches.size) dragging = false;
    });
    canvas.addEventListener('pointercancel', (e) => {
      touches.delete(e.pointerId);
      if (!touches.size) dragging = false;
      pinch = 0;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0012));
    }, { passive: false });
  }

  zoomAt(clientX, clientY, factor) {
    const r = this.canvas.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    const cam = this.cam;
    const before = {
      x: (mx - r.width / 2) / cam.zoom + cam.x,
      y: (my - r.height / 2) / cam.zoom + cam.y,
    };
    cam.zoom = Math.max(0.2, Math.min(8, cam.zoom * factor));
    const after = {
      x: (mx - r.width / 2) / cam.zoom + cam.x,
      y: (my - r.height / 2) / cam.zoom + cam.y,
    };
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    this.dirty = true;
  }
}
