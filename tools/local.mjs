import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { cockpitVoiceFiles } from '../lobby/battle-audio.mjs';
import { parseBrowserOrigin, startServer } from '../server/server.mjs';
import { readLocalBuild } from './local-build.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8081' },
    host: { type: 'string', default: '127.0.0.1' },
    origin: { type: 'string', multiple: true },
  },
});
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
  throw new Error('Use --port with a port number from 1 to 65535.');
}
const host = values.host.trim();
const addressFamily = isIP(host);
if (!addressFamily) throw new Error('Specify an IP address with --host.');
const urlHost = addressFamily === 6 ? `[${host}]` : host;
const origins = new Set([parseBrowserOrigin(`http://${urlHost}:${port}`), ...(values.origin ?? []).map(parseBrowserOrigin)]);
if (host === '127.0.0.1' || host === '::1') origins.add(parseBrowserOrigin(`http://localhost:${port}`));

const [build, packageJson] = await Promise.all([readLocalBuild(), readFile(new URL('../server/package.json', import.meta.url), 'utf8')]);
const { version } = JSON.parse(packageJson);
const metadata = new Map([
  ['/local-build', [build, 'text/plain; charset=utf-8']],
  ['/lobby/version.json', [JSON.stringify({ version }), 'application/json; charset=utf-8']],
]);

const routes = new Map([
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/lobby/', ['lobby/index.html', 'text/html; charset=utf-8']],
  ['/lobby/index.html', ['lobby/index.html', 'text/html; charset=utf-8']],
  ['/lobby/config.js', ['lobby/config.js', 'text/javascript; charset=utf-8']],
  ['/lobby/lobby.js', ['lobby/lobby.js', 'text/javascript; charset=utf-8']],
  ['/lobby/missile-art.js', ['lobby/missile-art.js', 'text/javascript; charset=utf-8']],
  ['/lobby/flight-model.mjs', ['server/flight-model.mjs', 'text/javascript; charset=utf-8']],
  ['/lobby/battle-audio.mjs', ['lobby/battle-audio.mjs', 'text/javascript; charset=utf-8']],
  ...cockpitVoiceFiles.map(file => ['/lobby/audio/' + file, ['lobby/audio/' + file, 'audio/wav']]),
  ['/lobby/lobby.css', ['lobby/lobby.css', 'text/css; charset=utf-8']],
  ['/lobby/dover.webp', ['lobby/dover.webp', 'image/webp']],
  ['/lobby/dover-scenery.mjs', ['lobby/dover-scenery.mjs', 'text/javascript; charset=utf-8']],
  ['/lobby/dover-map.json.gz', ['lobby/dover-map.json.gz', 'application/gzip']],
  ['/lobby/dover-landcover.bin.gz', ['lobby/dover-landcover.bin.gz', 'application/gzip']],
  ['/lobby/tutorial/flight.webp', ['lobby/tutorial/flight.webp', 'image/webp']],
  ['/lobby/tutorial/radar.webp', ['lobby/tutorial/radar.webp', 'image/webp']],
  ['/lobby/tutorial/rwr.webp', ['lobby/tutorial/rwr.webp', 'image/webp']],
]);

async function servePage(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const path = request.url.split('?')[0];
  const document = metadata.get(path);
  if (document) {
    const [body, type] = document;
    response.writeHead(200, {
      'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }
  if (path === '/' || path === '/lobby') {
    response.writeHead(302, { Location: '/lobby/' + request.url.slice(path.length) }).end();
    return;
  }
  const route = routes.get(path);
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  const [file, type] = route;
  try {
    const contents = await readFile(new URL('../' + file, import.meta.url));
    response.writeHead(200, {
      'Content-Type': type, 'Content-Length': contents.length, 'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    console.error(`[local] Cannot read ${file}: ${error.message}`);
    response.writeHead(500).end();
  }
}

startServer({ host, port, origins }, servePage);
