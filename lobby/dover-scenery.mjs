const TILE = 128;
const COLS = 5;
const kinds = [
  'lane', 'road', 'highway', 'rail', 'quay', 'pier', 'cottage', 'terrace',
  'hangar', 'warehouse', 'grove', 'windmill', 'lighthouse', 'ferry', 'freighter',
  'tug', 'wake',
];

const ROOFS = {
  cottage: ['#c9b19b', '#a36348', '#774d41', '#d9a88a'],
  terrace: ['#cbbea9', '#7d8385', '#565b64', '#acaca5'],
  hangar: ['#7c8174', '#8d9c9d', '#637075', '#b8c6c4'],
  warehouse: ['#a29e91', '#a1b4b3', '#667d81', '#c6d2ce'],
};

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function box(ctx, color, x, z, width, length) {
  ctx.fillStyle = color;
  ctx.fillRect(x, z, width, length);
}

function ellipse(ctx, color, x, z, rx, rz = rx) {
  ctx.beginPath();
  ctx.ellipse(x, z, rx, rz, 0, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
}

function polygons(ctx, color, points) {
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(...points[i]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function paintRoof(ctx, kind) {
  const [walls, lit, dark, trim] = ROOFS[kind];
  const industrial = kind === 'warehouse' || kind === 'hangar';
  const x = industrial ? 10 : 17;
  const right = industrial ? 105 : 103;
  const front = industrial ? 14 : 19;
  const back = industrial ? 102 : 99;
  polygons(ctx, '#111b1b57', [[x, back], [right, front], [right + 19, front + 15], [right + 19, back + 21], [x + 12, back + 18]]);
  box(ctx, '#000a0c45', x + 3, front + 4, right - x + 7, back - front + 7);
  box(ctx, walls, x + 5, front + 5, right - x, back - front + 6);
  box(ctx, '#252d2c52', right - 2, front + 8, 7, back - front + 2);
  box(ctx, lit, x, front, (right - x) / 2, back - front);
  box(ctx, dark, (right + x) / 2, front, (right - x) / 2, back - front);
  box(ctx, trim, (right + x) / 2 - 1, front, 2.5, back - front);
  if (kind === 'cottage' || kind === 'terrace') {
    for (let row = front + 5; row < back; row += 7) {
      box(ctx, '#231d1988', x + 1, row, right - x - 2, 0.7);
      for (let tile = x + 4 + (row % 2) * 3; tile < right - 2; tile += 8) {
        box(ctx, '#f7e5b42e', tile, row + 1, 0.62, 4);
      }
    }
    for (let z = front + 12; z < back - 11; z += kind === 'terrace' ? 25 : 68) {
      box(ctx, '#362e29a6', 57, z + 2, 11, 10);
      box(ctx, trim, 53, z, 10, 9);
      box(ctx, '#373432', 55, z + 1, 5, 4);
    }
  } else {
    for (let line = x + 4; line < right; line += 6) box(ctx, '#2739364d', line, front + 1, 0.85, back - front - 2);
    for (let z = front + 10; z < back - 13; z += 18) {
      if (industrial) box(ctx, '#8db0b6', x + 20, z, right - x - 39, 3.4);
      box(ctx, '#c8ccc935', x, z, right - x, 0.7);
    }
    box(ctx, trim, x, back - 3, right - x, 2);
  }
}

function paintRoad(ctx, kind) {
  if (kind === 'rail') {
    box(ctx, '#2d3434b3', 9, 0, 110, TILE);
    for (let row = 0; row < TILE; row += 18) box(ctx, '#716857', 18, row, 92, 7);
    for (const x of [42, 80]) box(ctx, '#b1b1a4', x, 0, 5, TILE);
    return;
  }
  if (kind === 'pier') {
    box(ctx, '#858880', 0, 0, TILE, TILE);
    const rng = randomFrom(17527);
    for (let i = 0; i < 260; i++) box(ctx, '#b7b2a42a', TILE * rng(), TILE * rng(), 4, 2);
    return;
  }

  const paved = kind !== 'lane';
  box(ctx, paved ? '#111e2180' : '#38413470', 4, 0, 120, 128);
  box(ctx, paved ? '#737b78' : '#a79c76', 14, 0, 100, 128);
  box(ctx, paved ? '#4f595b' : '#8a8164', 21, 0, 86, 128);
  const rng = randomFrom(234052);
  for (let i = 0; i < 230; i++) {
    box(ctx, i % 2 ? '#bbbca124' : '#272d252e', 21 + 83 * rng(), TILE * rng(), 1 + 3 * rng(), 1 + 2 * rng());
  }
  if (kind === 'highway') box(ctx, '#aaa593', 62, 0, 4, TILE);
  if (kind === 'quay') {
    box(ctx, '#aeb9ad', 17, 0, 6, 128);
    box(ctx, '#8c9691', 104, 0, 7, 128);
    for (let y = 9; y < TILE; y += 14) box(ctx, '#354444', 16, y, 9, 3);
  }
}

function paintGrove(ctx) {
  const random = randomFrom(989342);
  const centers = [[38, 39, 26], [77, 43, 23], [56, 76, 29]];
  for (const [x, z, radius] of centers) ellipse(ctx, '#1023225c', x + 13, z + 13, radius + 5, radius * 0.88);
  for (const [x, z, radius] of centers) {
    ellipse(ctx, '#273f2b', x, z, radius, radius * 0.86);
    for (let i = 0; i < 45; i++) {
      const angle = TAU * random(), distance = Math.sqrt(random()) * radius * 0.87;
      const cx = x + Math.cos(angle) * distance;
      const cz = z + Math.sin(angle) * distance * 0.85;
      const light = clamp(29 + (x - cx + z - cz) * 0.38 + random() * 27, 18, 75);
      ellipse(ctx, `hsl(${100 + random() * 29} 28% ${light}%)`, cx, cz, 4 + random() * 8, 3 + random() * 7);
    }
  }
}

function paintShip(ctx, type) {
  const cargo = type === 'freighter';
  const small = type === 'tug';
  const hull = [[64, 5], [79, 16], [94, 36], [100, 61], [97, 110], [89, 122], [39, 122], [31, 110], [28, 61], [34, 36], [49, 16]];
  polygons(ctx, '#07121b7a', hull.map(([x, z]) => [x + 4, z + 3]));
  polygons(ctx, cargo ? '#283e4a' : '#374f63', hull);
  polygons(ctx, cargo ? '#90796a' : '#d0d7d1', [[64, 10], [84, 26], [94, 45], [94, 104], [86, 117], [42, 117], [34, 104], [34, 45], [44, 26]]);
  for (let z = 33; z < 113; z += 8) {
    box(ctx, '#263943', 36, z, 4, 1.5);
    box(ctx, '#263943', 88, z, 4, 1.5);
  }
  if (cargo) {
    const colors = ['#9d6953', '#718a99', '#c0a46d', '#7c8271', '#a4a6a0'];
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 3; column++) {
        const x = 42 + column * 15, z = 25 + row * 9;
        box(ctx, '#15262c91', x + 1, z + 1, 14, 8);
        box(ctx, colors[(row * 2 + column * 3) % colors.length], x, z, 12.5, 6.4);
        box(ctx, '#f7ebc158', x, z, 12.5, 1.1);
        for (let j = 2; j < 11; j += 2.3) box(ctx, '#172f3445', x + j, z + 2, 0.6, 3.3);
      }
    }
    box(ctx, '#4d6263', 39, 83, 51, 18);
    box(ctx, '#cdd9d5', 41, 83, 45, 13);
    box(ctx, '#34535d', 44, 85, 39, 2.7);
    box(ctx, '#ad694e', 69, 100, 9, 7);
  } else {
    const start = small ? 39 : 37;
    box(ctx, '#46576296', 43, start + 3, 45, small ? 24 : 61);
    box(ctx, small ? '#c2ae81' : '#eef0e4', 41, start, 44, small ? 23 : 59);
    box(ctx, '#2f4c5f', 43, start + 4, 39, 4);
    box(ctx, '#8ea8ab', 45, start + 3, 30, 1);
    for (let z = start + 11; z < start + (small ? 20 : 52); z += 7) {
      box(ctx, '#578391', 43, z, 3, 3);
      box(ctx, '#578391', 80, z, 3, 3);
    }
    box(ctx, '#b98a63', 51, small ? 71 : 104, 25, 9);
    for (const x of small ? [65] : [53, 71]) {
      box(ctx, '#46565a', x + 2, 62, 9, 10);
      box(ctx, '#ba684a', x, 60, 8, 10);
      box(ctx, '#293837', x, 60, 8, 3.6);
    }
  }
  box(ctx, '#e3d3a1', 61, 18, 6, 2.5);
  ellipse(ctx, '#f4eee2', 62, 14, 1.8, 3);
}

function paintWake(ctx) {
  const foam = ctx.createLinearGradient(0, 0, 0, TILE);
  foam.addColorStop(0, '#f0f8ea8f');
  foam.addColorStop(0.19, '#e9f6e85c');
  foam.addColorStop(0.57, '#d4f2eb28');
  foam.addColorStop(1, '#d4f2eb00');
  polygons(ctx, foam, [[58, 0], [70, 0], [102, 108], [71, 85], [62, 67], [50, 83], [22, 114]]);
  ctx.strokeStyle = foam;
  for (const side of [-1, 1]) {
    for (let band = 0; band < 3; band++) {
      ctx.beginPath();
      ctx.moveTo(64 + side * (2 + band * 3), 4);
      ctx.bezierCurveTo(64 + side * (6 + band * 4), 34, 64 + side * 6, 71, 64 + side * (27 + band * 11), 122);
      ctx.lineWidth = 1.7 - band * 0.21;
      ctx.stroke();
    }
  }
  const rng = randomFrom(368722);
  for (let i = 0; i < 330; i++) {
    const distance = rng();
    const y = distance * 121;
    const x = 64 + (rng() - 0.5) * (9 + 72 * distance);
    ellipse(ctx, `rgba(223,245,236,${0.28 * (1 - distance) * rng()})`, x, y, 0.3 + rng() * 2, 0.6 + rng() * 2.2);
  }
}

function paintStructure(ctx, kind) {
  if (kind === 'windmill') {
    ellipse(ctx, '#18292663', 71, 73, 24);
    ellipse(ctx, '#a08971', 61, 64, 23);
    ellipse(ctx, '#605854', 62, 63, 18);
    for (let blade = 0; blade < 4; blade++) {
      ctx.save();
      ctx.translate(62, 62);
      ctx.rotate(0.3 + blade * Math.PI / 2);
      box(ctx, '#dbd4bb', -3, -55, 6, 55);
      box(ctx, '#b1a68b', -9, -51, 9, 31);
      ctx.restore();
    }
    ellipse(ctx, '#e0d5b0', 62, 62, 7);
  } else {
    ellipse(ctx, '#152b3166', 71, 73, 34);
    ellipse(ctx, '#aaa897', 57, 59, 32);
    ellipse(ctx, '#ece6ce', 56, 56, 21);
    ellipse(ctx, '#9a6850', 56, 56, 14);
    ellipse(ctx, '#d9d1a9', 54, 54, 5);
  }
}

function createAtlas(regions) {
  const canvas = document.createElement('canvas');
  canvas.width = TILE * COLS;
  canvas.height = TILE * Math.ceil(kinds.length / COLS);
  const ctx = canvas.getContext('2d');
  for (const [i, kind] of kinds.entries()) {
    const x = (i % COLS) * TILE;
    const z = Math.floor(i / COLS) * TILE;
    ctx.save();
    ctx.translate(x, z);
    ctx.beginPath();
    ctx.rect(0, 0, TILE, TILE);
    ctx.clip();
    if (kind in ROOFS) paintRoof(ctx, kind);
    else if (kind === 'grove') paintGrove(ctx);
    else if (kind === 'ferry' || kind === 'freighter' || kind === 'tug') paintShip(ctx, kind);
    else if (kind === 'wake') paintWake(ctx);
    else if (['road', 'highway', 'lane', 'rail', 'quay', 'pier'].includes(kind)) paintRoad(ctx, kind);
    else paintStructure(ctx, kind);
    ctx.restore();
    regions.set(kind, [(x + 0.5) / canvas.width, (z + 0.5) / canvas.height,
      (x + TILE - 0.5) / canvas.width, (z + TILE - 0.5) / canvas.height]);
  }
  return canvas;
}

function makeScenery(data, sampleShore, meters, airfields, runway, factory, isWoodland) {
  const cellSize = meters * 500;
  const cells = new Map();
  const fields = airfields.map(({ x, z, heading }) => ({ x, z, sin: Math.sin(heading), cos: Math.cos(heading),
    limits: [-(runway.lengthM / 2 + 25) * meters, -52 * meters, (runway.lengthM / 2 + 25) * meters, 275 * meters] }));
  const reserved = factory ? [...fields, { x: factory.x, z: factory.z, sin: 1, cos: 0,
    limits: [-165 * meters, -115 * meters, 165 * meters, 115 * meters] }] : fields;

  function localPoint({ x, z, sin, cos }, px, pz) {
    return [(px - x) * sin - (pz - z) * cos, (px - x) * cos + (pz - z) * sin];
  }

  function protectedGround(x, z, reach) {
    return reserved.some(site => {
      const [along, across] = localPoint(site, x, z);
      const [a0, b0, a1, b1] = site.limits;
      return along + reach >= a0 && along - reach <= a1 && across + reach >= b0 && across - reach <= b1;
    });
  }

  function register(layer, object) {
    object.layer = layer;
    const { x, z, reach } = object;
    for (let row = Math.floor((z - reach) / cellSize); row <= Math.floor((z + reach) / cellSize); row++) {
      for (let col = Math.floor((x - reach) / cellSize); col <= Math.floor((x + reach) / cellSize); col++) {
        const key = col + ':' + row;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(object);
      }
    }
  }

  function place(layer, kind, x, z, width, length, heading = 0) {
    register(layer, { kind, x, z, width: width * meters, length: length * meters, heading,
      reach: Math.hypot(width, length) * meters / 2 });
  }

  function road(kind, width, x1, z1, x2, z2) {
    const length = Math.hypot(x2 - x1, z2 - z1);
    if (length < meters * 0.25) return;
    place(1, kind, (x1 + x2) / 2, (z1 + z2) / 2, width, length / meters + width * 0.62,
      Math.atan2(x2 - x1, z1 - z2));
  }

  function roadOutsideSites(kind, width, x1, z1, x2, z2) {
    const reach = (Math.hypot(x2 - x1, z2 - z1) + width * meters) / 2;
    if (!protectedGround((x1 + x2) / 2, (z1 + z2) / 2, reach)) {
      road(kind, width, x1, z1, x2, z2);
      return;
    }
    let spans = [[0, 1]];
    const margin = width * meters / 2;
    for (const site of reserved) {
      const start = localPoint(site, x1, z1), end = localPoint(site, x2, z2);
      let enter = 0, exit = 1;
      for (let axis = 0; axis < 2; axis++) {
        const min = site.limits[axis] - margin, max = site.limits[axis + 2] + margin;
        const delta = end[axis] - start[axis];
        if (!delta) {
          if (start[axis] < min || start[axis] > max) exit = -1;
          continue;
        }
        const a = (min - start[axis]) / delta, b = (max - start[axis]) / delta;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
      }
      if (enter >= exit) continue;
      const remaining = [];
      for (const [a, b] of spans) {
        if (a < enter) remaining.push([a, Math.min(b, enter)]);
        if (b > exit) remaining.push([Math.max(a, exit), b]);
      }
      spans = remaining;
    }
    for (const [a, b] of spans) {
      road(kind, width, x1 + (x2 - x1) * a, z1 + (z2 - z1) * a,
        x1 + (x2 - x1) * b, z1 + (z2 - z1) * b);
    }
  }

  const roads = [['highway', 16], ['road', 10], ['road', 7], ['lane', 4], ['rail', 6], ['quay', 9]];
  for (const [style, x, z, dx, dz] of data.roads) {
    const [kind, width] = roads[style];
    roadOutsideSites(kind, width, x * meters, z * meters, (x + dx) * meters, (z + dz) * meters);
  }

  const surfaceKinds = ['cottage', 'terrace', 'warehouse', 'pier'];
  for (const mesh of data.surfaces) {
    const [style, angle, x, z] = mesh;
    const cos = Math.cos(angle / 1000), sin = Math.sin(angle / 1000);
    let left = 0, right = 0, top = 0, bottom = 0, farX = 0, farZ = 0, nearX = 0, nearZ = 0;
    for (let i = 4; i < mesh.length; i += 2) {
      const dx = mesh[i], dz = mesh[i + 1];
      const u = dx * cos + dz * sin, v = dz * cos - dx * sin;
      left = Math.min(left, u);
      right = Math.max(right, u);
      top = Math.min(top, v);
      bottom = Math.max(bottom, v);
      nearX = Math.min(nearX, dx);
      nearZ = Math.min(nearZ, dz);
      farX = Math.max(farX, dx);
      farZ = Math.max(farZ, dz);
    }
    const centerX = (x + (nearX + farX) / 2) * meters;
    const centerZ = (z + (nearZ + farZ) / 2) * meters;
    const reach = Math.hypot(farX - nearX, farZ - nearZ) * meters / 2;
    if (protectedGround(centerX, centerZ, reach)) continue;
    register(style === 3 ? 0 : 2, { kind: surfaceKinds[style], x: centerX, z: centerZ, reach, mesh,
      cos, sin, left, top, width: right - left, length: bottom - top });
  }

  for (const [style, x, z] of data.props) {
    const px = x * meters, pz = z * meters;
    if (protectedGround(px, pz, 16 * meters)) continue;
    if (style !== 0) {
      place(2, style === 1 ? 'lighthouse' : 'windmill', px, pz, 22, 22);
    } else if (sampleShore(px, pz) > 10 && isWoodland(px, pz)) {
      const rng = randomFrom(Math.imul(x, 73856093) ^ Math.imul(z, 19349663));
      const size = 27 + rng() * 16;
      place(0, 'grove', px, pz, size, size * 0.85, rng() * TAU);
    }
  }

  for (const field of airfields) {
    const fieldPoint = (along, across) => [
      field.x + (Math.sin(field.heading) * along + Math.cos(field.heading) * across) * meters,
      field.z + (-Math.cos(field.heading) * along + Math.sin(field.heading) * across) * meters,
    ];
    const access = [fieldPoint(-385, 104), fieldPoint(-386, 265), fieldPoint(-210, 265), fieldPoint(-90, 211)];
    for (let i = 1; i < access.length; i++) road('road', 14, ...access[i - 1], ...access[i]);
    for (const along of [-217, -160, -98, -34]) {
      place(2, 'hangar', ...fieldPoint(along, 172), 28, 48, field.heading + Math.PI / 2);
    }
    place(2, 'lighthouse', ...fieldPoint(113, 151), 21, 21);
    for (const along of [-421, -391]) {
      place(2, 'warehouse', ...fieldPoint(along, 241), 21, 40, field.heading);
    }
  }

  const routes = [
    { kind: 'ferry', from: [-1581, -11], to: [3390, 3810], width: 60, length: 171, speed: 10.3, offset: 99 },
    { kind: 'freighter', from: [5600, 2680], to: [-4200, 1540], width: 58, length: 213, speed: 8.1, offset: 2390 },
    { kind: 'ferry', from: [4220, 4991], to: [-1120, 888], width: 59, length: 159, speed: 10.0, offset: 235 },
    { kind: 'tug', from: [-1900, 214], to: [-1110, -41], width: 23, length: 53, speed: 5.4, offset: 451 },
    { kind: 'freighter', from: [-4250, 2290], to: [5220, 3450], width: 53, length: 184, speed: 7.5, offset: 5900 },
    { kind: 'tug', from: [4290, 4985], to: [3610, 4520], width: 24, length: 52, speed: 6.0, offset: 11 },
  ].map(route => {
    const [x, z] = route.from;
    const dx = route.to[0] - x, dz = route.to[1] - z;
    const distance = Math.hypot(dx, dz);
    return { ...route, x, z, dx, dz, distance, heading: Math.atan2(dx, -dz) };
  });

  return {
    collect(camera, width, height, time) {
      const layers = [[], [], []], waterLayer = [], ships = [];
      const halfWidth = width / 2 + 3, halfHeight = height / 2 + 3;
      function visible({ x, z, reach }) {
        return Math.abs(x - camera.x) <= halfWidth + reach && Math.abs(z - camera.z) <= halfHeight + reach;
      }
      const seen = new Set();
      for (let row = Math.floor((camera.z - halfHeight) / cellSize); row <= Math.floor((camera.z + halfHeight) / cellSize); row++) {
        for (let col = Math.floor((camera.x - halfWidth) / cellSize); col <= Math.floor((camera.x + halfWidth) / cellSize); col++) {
          for (const object of cells.get(col + ':' + row) ?? []) {
            if (!seen.has(object) && visible(object)) {
              seen.add(object);
              layers[object.layer].push(object);
            }
          }
        }
      }

      for (const route of routes) {
        const along = ((time * route.speed * meters + route.offset) % route.distance) / route.distance;
        const ship = { kind: route.kind, x: route.x + route.dx * along, z: route.z + route.dz * along,
          width: route.width * meters, length: route.length * meters, heading: route.heading };
        if (sampleShore(ship.x, ship.z) > -18) continue;
        const wakeLength = ship.length * 2.6;
        const trail = (ship.length * 0.44 + wakeLength * 0.5) / route.distance;
        const wake = { kind: 'wake', x: ship.x - route.dx * trail, z: ship.z - route.dz * trail,
          width: ship.length * 1.05, length: wakeLength, heading: route.heading };
        wake.reach = Math.hypot(wake.width, wake.length) / 2;
        ship.reach = Math.hypot(ship.width, ship.length) / 2;
        if (visible(wake) && sampleShore(wake.x, wake.z) < -15) waterLayer.push(wake);
        if (visible(ship)) ships.push(ship);
      }
      return [waterLayer, ...layers, ships];
    },
  };
}

const VERTEX = `#version 300 es
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aTexel;
uniform vec4 uView;
out vec2 uv;
void main() {
  gl_Position = vec4((aPosition - uView.xy) * vec2(2.0, -2.0) / uView.zw, 0.0, 1.0);
  uv = aTexel;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D uAtlas;
in vec2 uv;
out vec4 pixel;
void main() {
  pixel = texture(uAtlas, uv);
}`;

export function createDoverScenery(gl, linkProgram, compile, terrainData, gridSize, bounds, unitsPerMeter,
  airfields, runway, factory, mapData, isWoodland) {
  const regions = new Map();
  const canvas = createAtlas(regions);
  const atlas = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.activeTexture(gl.TEXTURE0);
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const program = linkProgram(vertex, FRAGMENT);
  gl.deleteShader(vertex);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'uAtlas'), 1);
  const view = gl.getUniformLocation(program, 'uView');
  const array = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(array);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

  const { minX, minZ, maxX, maxZ } = bounds;
  function sampleShore(x, z) {
    const row = clamp(Math.floor((z - minZ) / (maxZ - minZ) * gridSize), 0, gridSize - 1);
    const col = clamp(Math.floor((x - minX) / (maxX - minX) * gridSize), 0, gridSize - 1);
    return (terrainData[(row * gridSize + col) * 2 + 1] - 127.5) * 4;
  }
  const scenery = makeScenery(mapData, sampleShore, unitsPerMeter, airfields, runway, factory, isWoodland);
  const surfaceRegions = new Map();
  for (const kind of ['cottage', 'terrace', 'warehouse', 'pier']) {
    const [u0, v0, u1, v1] = regions.get(kind);
    const [left, top, right, bottom] = kind === 'pier' ? [0, 0, 1, 1] : kind === 'warehouse'
      ? [10 / TILE, 14 / TILE, 105 / TILE, 102 / TILE] : [17 / TILE, 19 / TILE, 103 / TILE, 99 / TILE];
    surfaceRegions.set(kind, [
      u0 + (u1 - u0) * left, v0 + (v1 - v0) * top, u0 + (u1 - u0) * right, v0 + (v1 - v0) * bottom,
    ]);
  }
  const corners = [[-1,-1], [1,-1], [1,1], [-1,-1], [1,1], [-1,1]];
  let vertices = new Float32Array(24 * 180);

  return (camera, width, height, time) => {
    const layers = scenery.collect(camera, width, height, time);
    let size = 0;
    for (const layer of layers) {
      for (const object of layer) size += object.mesh ? (object.mesh.length - 2) * 2 : 24;
    }
    if (!size) return;
    if (vertices.length < size) vertices = new Float32Array(size * 2);
    let cursor = 0;
    for (const objects of layers) {
      for (const object of objects) {
        if (object.mesh) {
          const [left, top, right, bottom] = surfaceRegions.get(object.kind);
          const [,, x, z] = object.mesh;
          for (let i = 2; i < object.mesh.length; i += 2) {
            const dx = i === 2 ? 0 : object.mesh[i];
            const dz = i === 2 ? 0 : object.mesh[i + 1];
            vertices[cursor++] = (x + dx) * unitsPerMeter;
            vertices[cursor++] = (z + dz) * unitsPerMeter;
            vertices[cursor++] = left + (right - left) * (dx * object.cos + dz * object.sin - object.left) / object.width;
            vertices[cursor++] = top + (bottom - top) * (dz * object.cos - dx * object.sin - object.top) / object.length;
          }
          continue;
        }

        const [u0, v0, u1, v1] = regions.get(object.kind);
        const cos = Math.cos(object.heading), sin = Math.sin(object.heading);
        for (const [side, end] of corners) {
          const x = side * object.width * 0.5;
          const z = end * object.length * 0.5;
          vertices[cursor++] = object.x + x * cos - z * sin;
          vertices[cursor++] = object.z + x * sin + z * cos;
          vertices[cursor++] = side < 0 ? u0 : u1;
          vertices[cursor++] = end < 0 ? v0 : v1;
        }
      }
    }
    gl.useProgram(program);
    gl.uniform4f(view, camera.x, camera.z, width, height);
    gl.bindVertexArray(array);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices.subarray(0, cursor), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, cursor / 4);
  };
}
