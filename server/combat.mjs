// Planar collision envelopes and subsystem centers in the game's model coordinates.
function airframe(length, width, wingX, wingZ, wingSpan, wingChord, engineCenters, tailZ) {
  return {
    hull: [[0, 0, width, length], [-wingX, wingZ, wingSpan, wingChord], [wingX, wingZ, wingSpan, wingChord],
      [0, tailZ, wingX * .78, wingChord * .53]],
    engines: engineCenters,
    wings: [[-wingX, wingZ], [wingX, wingZ]],
    tailZ
  };
}

const AIRFRAMES = [
  airframe(9.35, 2.05, 4.25, 1.55, 2.9, 2.95, [[-1.28, 5.6], [1.28, 5.6]], 6.65),
  airframe(10.7, 2, 4.65, 2.65, 2.90, 2.90, [[-1.60, 5.9], [1.60, 5.9]], 7.65),
  airframe(9.45, 2.27, 5.15, 2.86, 3.75, 2.35, [[-1.44, 5.6], [1.44, 5.6]], 7.55),
  airframe(24.2, 1.52, 14.1, .8, 13.4, 4.25, [
    [-18.05, -3], [-16.81, -3], [-10.79, -8.5], [-9.55, -8.5],
    [9.55, -8.5], [10.79, -8.5], [16.81, -3], [18.05, -3]
  ], 19.7)
];
AIRFRAMES[3].hull.push([-22.1, 6.5, 6.6, 3.4], [22.1, 6.5, 6.6, 3.4],
  [-7.2, -4.3, 6.2, 3.6], [7.2, -4.3, 6.2, 3.6]);

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

export function missilePass(missile, flight, previous, fuse) {
  const { hull } = AIRFRAMES[flight.airframe];
  const cos = Math.cos(flight.heading);
  const sin = Math.sin(flight.heading);
  const start = localPoint(missile.previousX, missile.previousZ, previous, cos, sin);
  const end = localPoint(missile.x, missile.z, flight, cos, sin);
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  let impact = Infinity, near = Infinity;
  for (const [centerX, centerZ, halfWidth, halfLength] of hull) {
    const x = start.x - centerX, z = start.z - centerZ;
    impact = Math.min(impact, ellipseContact(x, z, dx, dz, halfWidth, halfLength));
    if (!fuse || !length) continue;
    const closest = -(x * dx + z * dz) / length ** 2;
    if (closest < 0 || closest > 1) continue;
    const offsetX = x + dx * closest, offsetZ = z + dz * closest;
    if ((offsetX / (halfWidth + fuse)) ** 2 + (offsetZ / (halfLength + fuse)) ** 2 <= 1) near = Math.min(near, closest);
  }
  if (impact <= 1) return { along: impact, direct: true };
  // Delay a fuse pass if the projected path is about to enter the solid hull.
  if (near <= 1 && impact > 1 + fuse / length) return { along: near, direct: false };
  return null;
}

export function blastDamage(flight, point, profile) {
  const layout = AIRFRAMES[flight.airframe];
  const previous = flight.damage;
  const { x, z } = localPoint(point.x, point.z, flight, Math.cos(flight.heading), Math.sin(flight.heading));
  const exposure = (cx, cz) => profile.blastPower * saturate(1 - Math.hypot(x - cx, z - cz) / profile.blastRadius) ** 1.45;
  const engines = layout.engines.map(([cx, cz], index) => saturate(previous.engines[index] - exposure(cx, cz) * 1.04));
  const [leftWing, rightWing] = layout.wings.map(([cx, cz], side) =>
    saturate((side ? previous.rightWing : previous.leftWing) - exposure(cx, cz) * .71));
  const tail = saturate(previous.tail - exposure(0, layout.tailZ) * .69);
  const structure = saturate(previous.structure - Math.min(.72, exposure(0, 0) * (engines.length > 2 ? .25 : .45)));
  const power = engines.reduce((total, health) => total + health, 0) / engines.length;
  const control = .23 + .43 * Math.min(leftWing, rightWing) + .16 * Math.max(leftWing, rightWing) + .18 * tail;
  const engineLoss = previous.engines.reduce((loss, health, index) => Math.max(loss, health - engines[index]), 0);
  const wingLoss = Math.max(previous.leftWing - leftWing, previous.rightWing - rightWing);
  const worst = Math.max(engineLoss, wingLoss, previous.tail - tail, previous.structure - structure);
  if (worst < .018) return null;
  return { damage: { structure, engines, leftWing, rightWing, tail, power, control },
    part: worst === engineLoss ? '发动机' : worst === wingLoss ? '机翼' : worst === previous.tail - tail ? '尾翼' : '机体' };
}
