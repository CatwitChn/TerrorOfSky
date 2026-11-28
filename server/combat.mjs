// Planar collision envelopes and subsystem centers in the game's model coordinates.
function airframe(length, width, wingX, wingZ, wingSpan, wingChord, engineCenters, tailZ) {
  return {
    shapes: [[0, 0, width, length], [-wingX, wingZ, wingSpan, wingChord], [wingX, wingZ, wingSpan, wingChord],
      [0, tailZ, wingX * .78, wingChord * .53]].map(ellipse => ({ ellipse })),
    engines: engineCenters,
    wings: [[-wingX, wingZ], [wingX, wingZ]],
    tailZ
  };
}

const bomberPods = [[10.17, -10.64], [17.43, -5.14]];
// Number the eight nacelles across the model from the left wingtip to the right.
const bomberEngines = [-1, 1].flatMap(side => {
  const pods = side < 0 ? [...bomberPods].reverse() : bomberPods;
  return pods.flatMap(([span, lead]) => [[side * span - .62, lead], [side * span + .62, lead]]);
});
export const bomberExhausts = bomberEngines.map(([x, lead]) => [x, lead + 4.15]);

function sweptZones(stations, sides) {
  return [-1, 1].flatMap((side, index) => stations.slice(1).map(([span, lead, trail], i) => {
    const [inner, innerLead, innerTrail] = stations[i];
    const polygon = [[side * inner, innerLead], [side * span, lead], [side * span, trail], [side * inner, innerTrail]];
    if (side < 0) polygon.reverse();
    const lower = Math.min(lead, innerLead);
    const upper = Math.max(trail, innerTrail);
    return { zone: sides[index], polygon, ellipse: [side * (inner + span) / 2, (lower + upper) / 2,
      (span - inner) / 2, (upper - lower) / 2] };
  }));
}

const engineCenters = bomberEngines.map(([x, lead]) => [x, lead + 2.08]);
const bomber = {
  engines: engineCenters,
  wings: [[-14.1, .8], [14.1, .8]],
  wingExposure: [-1, 1].map(side => [[5, -6], [11, -2.5], [17, 1.5], [22, 5.6], [27, 9]]
    .map(([x, z]) => [side * x, z])),
  tailExposure: [[-5, 20.5], [0, 19.7], [5, 20.5]],
  bodyExposure: [-21, -12, 0, 10, 19].map(z => [0, z]),
  shapes: [
    ...engineCenters.map(([x, z], engineIndex) => ({ zone: 'engine', engineIndex, ellipse: [x, z, .62, 2.08] })),
    { zone: 'structure', ellipse: [0, 0, 1.52, 24.2] },
    ...sweptZones([[1.38, -13.18, -3.12], [4.90, -10.42, -1.52], [9.95, -6.44, 1.45],
      [14.55, -2.93, 3.92], [19.96, 1.55, 6.94], [26.30, 6.31, 10.46], [28.19, 7.95, 11.52]],
    ['leftWing', 'rightWing']),
    ...sweptZones([[.65, 14.38, 22.63], [2.60, 16.27, 22.74], [5.07, 18.62, 22.9], [7.92, 21.14, 22.99]], ['tail', 'tail']),
    { zone: 'leftWing', ellipse: [-25.1, 10.44, .51, 3.82] },
    { zone: 'rightWing', ellipse: [25.1, 10.44, .51, 3.82] },
  ],
};

const AIRFRAMES = [
  airframe(9.35, 2.05, 4.25, 1.55, 2.9, 2.95, [[-1.28, 5.6], [1.28, 5.6]], 6.65),
  airframe(10.7, 2, 4.65, 2.65, 2.90, 2.90, [[-1.60, 5.9], [1.60, 5.9]], 7.65),
  airframe(9.45, 2.27, 5.15, 2.86, 3.75, 2.35, [[-1.44, 5.6], [1.44, 5.6]], 7.55),
  bomber,
];

export function freshDamage(model) {
  return { structure: 1, engines: AIRFRAMES[model].engines.map(() => 1), leftWing: 1, rightWing: 1, tail: 1,
    power: 1, control: 1 };
}

const saturate = value => Math.max(0, Math.min(1, value));

function localPoint(x, z, position, cos, sin) {
  const dx = x - position.x;
  const dz = z - position.z;
  return { x: dx * cos + dz * sin, z: -dx * sin + dz * cos };
}

function ellipseContact(x, z, dx, dz, halfWidth, halfLength) {
  const u = x / halfWidth, v = z / halfLength;
  const du = dx / halfWidth, dv = dz / halfLength;
  const a = du * du + dv * dv;
  const b = u * du + v * dv;
  const c = u * u + v * v - 1;
  const discriminant = b * b - a * c;
  if (c <= 0) return 0;
  return a && b < 0 && discriminant >= 0 ? (-b - Math.sqrt(discriminant)) / a : Infinity;
}

function polygonContact({ x, z }, dx, dz, vertices) {
  let enters = 0, leaves = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const [a, b] = vertices[i];
    const [c, d] = vertices[(i + 1) % vertices.length];
    const edgeX = c - a, edgeZ = d - b;
    const offset = edgeX * (z - b) - edgeZ * (x - a);
    const approach = edgeX * dz - edgeZ * dx;
    if (approach > 0) enters = Math.max(enters, -offset / approach);
    else if (approach < 0) leaves = Math.min(leaves, -offset / approach);
    else if (offset < 0) return Infinity;
    if (enters > leaves) return Infinity;
  }
  return enters;
}

function proximityPass(x, z, dx, dz, length, halfWidth, halfLength, fuse) {
  if (!fuse || !length) return Infinity;
  const closest = -(x * dx + z * dz) / length ** 2;
  if (closest < 0 || closest > 1) return Infinity;
  const offsetX = x + dx * closest, offsetZ = z + dz * closest;
  return (offsetX / (halfWidth + fuse)) ** 2 + (offsetZ / (halfLength + fuse)) ** 2 <= 1 ? closest : Infinity;
}

export function missilePass(missile, flight, previous, fuse) {
  const { shapes } = AIRFRAMES[flight.airframe];
  const cos = Math.cos(flight.heading);
  const sin = Math.sin(flight.heading);
  const start = localPoint(missile.previousX, missile.previousZ, previous, cos, sin);
  const end = localPoint(missile.x, missile.z, flight, cos, sin);
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  let impact = Infinity, near = Infinity;
  let hitZone;
  for (const part of shapes) {
    const [centerX, centerZ, halfWidth, halfLength] = part.ellipse;
    const x = start.x - centerX, z = start.z - centerZ;
    const distance = part.polygon ? polygonContact(start, dx, dz, part.polygon) : ellipseContact(x, z, dx, dz, halfWidth, halfLength);
    if (distance < impact) {
      impact = distance;
      hitZone = part;
    }
    near = Math.min(near, proximityPass(x, z, dx, dz, length, halfWidth, halfLength, fuse));
  }
  if (impact <= 1) {
    const { zone, engineIndex } = hitZone;
    return { along: impact, direct: true, ...(zone && { zone, engineIndex }) };
  }
  // Delay a fuse pass if the projected path is about to enter the solid hull.
  if (near <= 1 && impact > 1 + fuse / length) return { along: near, direct: false };
  return null;
}

function updateCondition(damage) {
  const { engines, leftWing, rightWing, tail } = damage;
  damage.power = engines.reduce((total, health) => total + health, 0) / engines.length;
  damage.control = .23 + .43 * Math.min(leftWing, rightWing) + .16 * Math.max(leftWing, rightWing) + .18 * tail;
  return damage;
}

const engineName = index => `${index + 1} 号发动机`;

export function cannonDamage(flight, hit, amount) {
  const damage = { ...flight.damage };
  const { zone, engineIndex } = hit;
  if (zone === 'engine') {
    if (damage.engines[engineIndex] <= 0) return null;
    damage.engines = [...damage.engines];
    damage.engines[engineIndex] = saturate(damage.engines[engineIndex] - amount * 4.25);
    return { damage: updateCondition(damage), part: engineName(engineIndex) };
  }
  if (zone === 'leftWing' || zone === 'rightWing' || zone === 'tail') {
    damage[zone] = saturate(damage[zone] - amount * 1.4);
    damage.structure = saturate(damage.structure - amount * .55);
    return { damage: updateCondition(damage), part: zone === 'tail' ? '尾翼' : zone === 'leftWing' ? '左机翼' : '右机翼' };
  }
  damage.structure = saturate(damage.structure - amount);
  return { damage, part: '机体' };
}

export function blastDamage(flight, point, profile, directEngine) {
  const layout = AIRFRAMES[flight.airframe];
  const previous = flight.damage;
  const { x, z } = localPoint(point.x, point.z, flight, Math.cos(flight.heading), Math.sin(flight.heading));
  const exposure = (cx, cz) => profile.blastPower * saturate(1 - Math.hypot(x - cx, z - cz) / profile.blastRadius) ** 1.45;
  const exposureAlong = points => Math.max(...points.map(([cx, cz]) => exposure(cx, cz)));
  const engines = layout.engines.map(([cx, cz], index) =>
    index === directEngine ? 0 : saturate(previous.engines[index] - exposure(cx, cz) * 1.04));
  const [leftWing, rightWing] = layout.wings.map(([cx, cz], side) => {
    const intensity = layout.wingExposure ? exposureAlong(layout.wingExposure[side]) : exposure(cx, cz);
    return saturate((side ? previous.rightWing : previous.leftWing) - intensity * .71);
  });
  const tail = saturate(previous.tail - (layout.tailExposure ? exposureAlong(layout.tailExposure) : exposure(0, layout.tailZ)) * .69);
  const bodyExposure = layout.bodyExposure ? exposureAlong(layout.bodyExposure) : exposure(0, 0);
  const structure = saturate(previous.structure - Math.min(.72, bodyExposure * (layout.bodyExposure ? .25 : .45)));
  const damage = updateCondition({ structure, engines, leftWing, rightWing, tail });
  let engineLoss = 0, worstEngine = 0;
  for (const [index, previousHealth] of previous.engines.entries()) {
    if (previousHealth - engines[index] <= engineLoss) continue;
    engineLoss = previousHealth - engines[index];
    worstEngine = index;
  }
  const wingLoss = Math.max(previous.leftWing - leftWing, previous.rightWing - rightWing);
  const worst = Math.max(engineLoss, wingLoss, previous.tail - tail, previous.structure - structure);
  if (worst < .018) return null;
  const part = directEngine !== undefined ? engineName(directEngine) : worst === engineLoss
    ? (layout.bodyExposure ? engineName(worstEngine) : '发动机')
    : worst === wingLoss ? '机翼' : worst === previous.tail - tail ? '尾翼' : '机体';
  return { damage, part };
}
