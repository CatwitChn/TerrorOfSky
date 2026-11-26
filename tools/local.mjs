import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { startServer } from '../server/server.mjs';
import { readLocalBuild } from './local-build.mjs';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '8081' } },
});
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || port < 1 || port > 65535) {
  throw new Error('Use --port with a port number from 1 to 65535.');
}
const build = await readLocalBuild();

const routes = new Map([
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/lobby/', ['lobby/index.html', 'text/html; charset=utf-8']],
  ['/lobby/index.html', ['lobby/index.html', 'text/html; charset=utf-8']],
  ['/lobby/config.js', ['lobby/config.js', 'text/javascript; charset=utf-8']],
  ['/lobby/lobby.js', ['lobby/lobby.js', 'text/javascript; charset=utf-8']],
  ['/lobby/missile-art.js', ['lobby/missile-art.js', 'text/javascript; charset=utf-8']],
  ['/lobby/lobby.css', ['lobby/lobby.css', 'text/css; charset=utf-8']],
  ['/lobby/dover.webp', ['lobby/dover.webp', 'image/webp']],
]);

async function servePage(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const path = request.url.split('?')[0];
  if (path === '/local-build') {
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': build.length, 'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : build);
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

startServer({
  host: '127.0.0.1',
  port,
  origins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
}, servePage);
