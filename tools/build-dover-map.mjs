// Build lobby/dover-map.json.gz from z14 Shortbread vector tiles for the game extent.
// Input directory contains tiles.json (a list of [column, row]) and column-row.pbf files.
// Run with Node after installing @mapbox/vector-tile, pbf and earcut in your tooling directory.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';

const [tileDir, output = 'lobby/dover-map.json.gz'] = process.argv.slice(2);
const bounds = [-25000, -19350, 35000, 40650];
const latitude = 51.13, longitude = 1.45;
const metersPerDegree = 111320;
const eastScale = metersPerDegree * Math.cos(latitude * Math.PI / 180);
const tileCount = 2 ** 14;
const streetStyles = new Map([
  ...['motorway', 'trunk'].map(kind => [kind, 0]),
  ...['primary', 'secondary', 'tertiary'].map(kind => [kind, 1]),
  ...['unclassified', 'residential', 'living_street', 'busway'].map(kind => [kind, 2]),
  ...['service', 'pedestrian', 'track', 'footway', 'cycleway'].map(kind => [kind, 3]),
  ...['rail', 'narrow_gauge'].map(kind => [kind, 4]),
]);
const scenery = {
  source: '© OpenStreetMap contributors, via VersaTiles (Shortbread z14)',
  copyright: 'https://www.openstreetmap.org/copyright',
  license: 'https://opendatacommons.org/licenses/odbl/1-0/',
  roads: [], surfaces: [], props: [],
};

// The first position in a record is absolute. Remaining positions are offsets from it.
function offsets(values, start) {
  const x = values[start], z = values[start + 1];
  for (let i = start + 2; i < values.length; i += 2) {
    values[i] -= x;
    values[i + 1] -= z;
  }
  return values;
}

function world(x, y) {
  return [(x / tileCount * 360 - 180 - longitude) * eastScale,
    (latitude - Math.atan(Math.sinh(Math.PI * (1 - 2 * y / tileCount))) * 180 / Math.PI) * metersPerDegree];
}

function clipPolygon(points, [west, north, east, south]) {
  for (const [axis, edge, sign] of [[0, west, 1], [0, east, -1], [1, north, 1], [1, south, -1]]) {
    const clipped = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i ? i - 1 : points.length - 1], b = points[i];
      const outsideA = (a[axis] - edge) * sign < 0;
      const outsideB = (b[axis] - edge) * sign < 0;
      if (outsideA !== outsideB) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
      if (!outsideB) clipped.push(b);
    }
    points = clipped;
  }
  return points;
}

function clipLine(a, b, box) {
  let start = 0, end = 1;
  for (let axis = 0; axis < 2; axis++) {
    const delta = b[axis] - a[axis];
    if (!delta) {
      if (a[axis] < box[axis] || a[axis] >= box[axis + 2]) return null;
      continue;
    }
    const t0 = (box[axis] - a[axis]) / delta, t1 = (box[axis + 2] - a[axis]) / delta;
    start = Math.max(start, Math.min(t0, t1));
    end = Math.min(end, Math.max(t0, t1));
  }
  return start < end ? [start, end].flatMap(t => a.map((value, axis) => Math.round(value + t * (b[axis] - value)))) : null;
}

function insideRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < ax + (bx - ax) * (z - az) / (bz - az)) inside = !inside;
  }
  return inside;
}

function addForest(rings, box) {
  const outer = rings[0];
  const xs = outer.map(([x]) => x), zs = outer.map(([, z]) => z);
  const holes = rings.slice(1);
  const step = 44;
  for (let row = Math.ceil(Math.max(box[1], Math.min(...zs)) / step); row * step < Math.min(box[3], Math.max(...zs)); row++) {
    for (let col = Math.ceil(Math.max(box[0], Math.min(...xs)) / step); col * step < Math.min(box[2], Math.max(...xs)); col++) {
      const seed = Math.imul(col, 73856093) ^ Math.imul(row, 19349663);
      const x = col * step + ((seed >>> 3) % 23) - 11;
      const z = row * step + ((seed >>> 11) % 23) - 11;
      if (x >= box[0] && x < box[2] && z >= box[1] && z < box[3] &&
          insideRing(x, z, outer) && !holes.some(ring => insideRing(x, z, ring))) {
        scenery.props.push([0, x, z]);
      }
    }
  }
}

function addSurface(rings, box, pier) {
  const outer = rings[0];
  let area = 0, longest = 0, heading = 0;
  for (let i = 1; i < outer.length; i++) {
    const [ax, az] = outer[i - 1], [bx, bz] = outer[i];
    area += ax * bz - bx * az;
    const length = Math.hypot(bx - ax, bz - az);
    if (length <= longest) continue;
    longest = length;
    heading = Math.atan2(bx - ax, az - bz);
  }
  area = Math.abs(area) / 2;
  if (area < 12) return;
  const style = pier ? 3 : area > 750 ? 2 : (Math.floor(Math.abs(outer[0][0]) * 7) & 1);
  const points = [], holes = [];
  for (const ring of rings) {
    if (points.length) holes.push(points.length);
    points.push(...ring.slice(0, -1));
  }
  const triangles = earcut(points.flat(), holes);
  const data = [style, Math.round(heading * 1000)];
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, ...polygon] = clipPolygon(triangles.slice(i, i + 3).map(index => points[index]), box)
      .map(point => point.map(Math.round));
    for (let j = 1; j < polygon.length; j++) {
      const b = polygon[j - 1], c = polygon[j];
      if ((b[0] - a[0]) * (c[1] - a[1]) === (b[1] - a[1]) * (c[0] - a[0])) continue;
      data.push(...a, ...b, ...c);
    }
  }
  if (data.length > 2) scenery.surfaces.push(offsets(data, 2));
}

for (const [col, row] of JSON.parse(await readFile(join(tileDir, 'tiles.json'), 'utf8'))) {
  const bytes = await readFile(join(tileDir, `${col}-${row}.pbf`));
  if (!bytes.length) continue;
  const box = [...world(col, row), ...world(col + 1, row + 1)].map((edge, i) =>
    i < 2 ? Math.max(edge, bounds[i]) : Math.min(edge, bounds[i]));
  if (box[0] >= box[2] || box[1] >= box[3]) continue;
  const { layers } = new VectorTile(new PbfReader(bytes));
  for (const name of ['streets', 'pier_lines', 'buildings', 'pier_polygons', 'land', 'pois']) {
    const layer = layers[name];
    if (!layer) continue;
    const project = ({ x, y }) => world(col + x / layer.extent, row + y / layer.extent);
    for (let index = 0; index < layer.length; index++) {
      const feature = layer.feature(index);
      const { kind, tunnel, part, man_made: landmark } = feature.properties;
      if (name === 'streets' || name === 'pier_lines') {
        const style = name === 'pier_lines' ? 5 : streetStyles.get(kind);
        if (style === undefined || tunnel || feature.type !== 2) continue;
        for (const line of feature.loadGeometry()) {
          const points = line.map(project);
          for (let i = 1; i < points.length; i++) {
            const segment = clipLine(points[i - 1], points[i], box);
            if (segment && (segment[0] !== segment[2] || segment[1] !== segment[3])) {
              scenery.roads.push(offsets([style, ...segment], 1));
            }
          }
        }
      } else if (name === 'pois') {
        if (!['lighthouse', 'windmill'].includes(landmark) || feature.type !== 1) continue;
        const [x, z] = project(feature.loadGeometry()[0][0]);
        if (x >= box[0] && x < box[2] && z >= box[1] && z < box[3]) {
          scenery.props.push([landmark === 'lighthouse' ? 1 : 2, Math.round(x), Math.round(z)]);
        }
      } else {
        if (part || feature.type !== 3 || (name === 'land' && kind !== 'forest')) continue;
        for (const polygon of classifyRings(feature.loadGeometry())) {
          const rings = polygon.map(ring => ring.map(project));
          if (name === 'land') addForest(rings, box);
          else addSurface(rings, box, name === 'pier_polygons');
        }
      }
    }
  }
}
const treeLocations = new Set();
scenery.props = scenery.props.filter(prop => {
  const key = prop.join(':');
  if (treeLocations.has(key)) return false;
  treeLocations.add(key);
  return true;
});
await writeFile(output, gzipSync(JSON.stringify(scenery), { level: 9 }));
console.log({ roads: scenery.roads.length, surfaces: scenery.surfaces.length, props: scenery.props.length });
