// Reproject the two ESA WorldCover 2021 tiles covering Dover to the game grid.
// Run with Node 22+ and geotiff installed in the script's tooling directory.
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fromUrl } from 'geotiff';

const output = process.argv[2] ?? 'lobby/dover-landcover.bin.gz';
const size = 3072;
const map = { west: -25000, north: -19350, span: 60000 };
const origin = { lat: 51.13, lon: 1.45 };
const northScale = 111320;
const eastScale = northScale * Math.cos(origin.lat * Math.PI / 180);
const toLon = x => origin.lon + x / eastScale;
const toLat = z => origin.lat - z / northScale;
const west = toLon(map.west), east = toLon(map.west + map.span);
const north = toLat(map.north), south = toLat(map.north + map.span);
const source = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/';
const timeout = 120000;

async function readTile(tile) {
  const filename = 'ESA_WorldCover_10m_2021_v200_' + tile + '_Map.tif';
  const tiff = await fromUrl(source + filename, { blockSize: 65536, cacheSize: 256 }, AbortSignal.timeout(timeout));
  const raster = await tiff.getImage();
  const [lon, lat] = raster.getOrigin();
  const [dx, dy] = raster.getResolution();
  const col = Math.floor((west - lon) / dx);
  const row = Math.max(0, Math.floor((north - lat) / dy));
  const maxCol = Math.ceil((east - lon) / dx);
  const maxRow = Math.min(raster.getHeight(), Math.ceil((south - lat) / dy));
  const width = maxCol - col;
  const classes = await raster.readRasters({
    window: [col, row, maxCol, maxRow], samples: [0], interleave: true, signal: AbortSignal.timeout(timeout),
  });
  return { classes, lon, lat, dx, dy, col, row, width };
}

const [southern, northern] = await Promise.all([readTile('N48E000'), readTile('N51E000')]);
const step = map.span / size;
const data = new Uint8Array(size * size);
const counts = new Uint8Array(256);
const offsets = [1 / 6, 1 / 2, 5 / 6];
const samples = offsets.flatMap((_, row) => offsets.map((_, col) => [row, col]));

for (let z = 0; z < size; z++) {
  const rows = offsets.map(offset => {
    const lat = toLat(map.north + (z + offset) * step);
    const tile = lat >= southern.lat ? northern : southern;
    const row = Math.floor((lat - tile.lat) / tile.dy) - tile.row;
    return { tile, start: row * tile.width };
  });
  for (let x = 0; x < size; x++) {
    let selected = 0, center = 0, most = 0;
    for (const [rowOffset, colOffset] of samples) {
      const { tile, start } = rows[rowOffset];
      const lon = toLon(map.west + (x + offsets[colOffset]) * step);
      const col = Math.floor((lon - tile.lon) / tile.dx) - tile.col;
      const kind = tile.classes[start + col];
      if (kind === undefined) throw new Error('Incomplete WorldCover window.');
      if (rowOffset === 1 && colOffset === 1) center = kind;
      if (++counts[kind] > most) {
        selected = kind;
        most = counts[kind];
      }
    }
    data[z * size + x] = counts[center] === most ? center : selected;
    counts.fill(0);
  }
}
await writeFile(output, gzipSync(data, { level: 9 }));
console.log(`Wrote ${size} × ${size} ESA WorldCover classes to ${output}`);
