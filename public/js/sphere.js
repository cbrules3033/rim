// Goldberg polyhedron: subdivide an icosahedron, then take the dual.
// Every subdivided vertex becomes a tile (hexagon, or pentagon at the 12
// original icosahedron vertices). Tile corners are the centroids of the
// triangles around the vertex, so adjacent tiles share edges exactly.

function norm(p) {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

let cache = null;

export function buildGoldberg(freq = 24) {
  if (cache && cache.freq === freq) return cache;

  const phi = (1 + Math.sqrt(5)) / 2;
  const ico = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ].map(norm);
  const icoFaces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  // ---- subdivide, dedupe shared vertices ----
  const verts = [];
  const vmap = new Map();
  function getVert(p) {
    p = norm(p);
    const key = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
    let id = vmap.get(key);
    if (id === undefined) {
      id = verts.length;
      verts.push(p);
      vmap.set(key, id);
    }
    return id;
  }

  const tris = [];
  for (const [fa, fb, fc] of icoFaces) {
    const a = ico[fa], b = ico[fb], c = ico[fc];
    // grid of vertex ids over this face
    const grid = [];
    for (let i = 0; i <= freq; i++) {
      grid.push([]);
      for (let j = 0; j <= freq - i; j++) {
        const w = freq - i - j;
        grid[i].push(getVert([
          a[0] * w + b[0] * i + c[0] * j,
          a[1] * w + b[1] * i + c[1] * j,
          a[2] * w + b[2] * i + c[2] * j,
        ]));
      }
    }
    for (let i = 0; i < freq; i++) {
      for (let j = 0; j < freq - i; j++) {
        tris.push([grid[i][j], grid[i + 1][j], grid[i][j + 1]]);
        if (j < freq - i - 1) {
          tris.push([grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]);
        }
      }
    }
  }

  // ---- adjacency ----
  const vertTris = verts.map(() => []);
  const vertNbrs = verts.map(() => new Set());
  const centroids = tris.map(([a, b, c]) => norm([
    verts[a][0] + verts[b][0] + verts[c][0],
    verts[a][1] + verts[b][1] + verts[c][1],
    verts[a][2] + verts[b][2] + verts[c][2],
  ]));
  tris.forEach((tri, ti) => {
    for (let k = 0; k < 3; k++) {
      vertTris[tri[k]].push(ti);
      vertNbrs[tri[k]].add(tri[(k + 1) % 3]);
      vertNbrs[tri[k]].add(tri[(k + 2) % 3]);
    }
  });

  // ---- dual tiles ----
  const tiles = verts.map((p, id) => {
    // tangent basis for angular sorting
    const ref = Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(p, ref));
    const v = cross(p, u);
    const ang = (q) => Math.atan2(dot(q, v), dot(q, u));

    let corners = vertTris[id]
      .map((ti) => centroids[ti])
      .sort((a, b) => ang(a) - ang(b));
    let neighbors = [...vertNbrs[id]]
      .sort((a, b) => ang(verts[a]) - ang(verts[b]));

    // ensure counter-clockwise winding seen from outside
    if (dot(cross(sub(corners[0], p), sub(corners[1], p)), p) < 0) {
      corners = corners.slice().reverse();
      neighbors = neighbors.slice().reverse();
    }

    // edge midpoint toward each neighbor = midpoint of the two triangle
    // centroids shared with that neighbor (identical from both sides)
    const edgeMid = neighbors.map((nid) => {
      const shared = vertTris[id].filter((ti) => tris[ti].includes(nid));
      const [m1, m2] = shared.map((ti) => centroids[ti]);
      return norm([(m1[0] + m2[0]) / 2, (m1[1] + m2[1]) / 2, (m1[2] + m2[2]) / 2]);
    });

    return { id, center: p, corners, neighbors, edgeMid };
  });

  cache = { freq, tiles };
  return cache;
}
