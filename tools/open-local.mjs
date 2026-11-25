import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION } from '../server/missions.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const entryPoint = fileURLToPath(new URL('./local.mjs', import.meta.url));
const localDirectory = new URL('../.local/', import.meta.url);
const serverLog = fileURLToPath(new URL('server.log', localDirectory));
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const run = promisify(execFile);

async function lobbyStatus(origin) {
  try {
    const options = { signal: AbortSignal.timeout(700), redirect: 'error' };
    const health = await fetch(`${origin}/healthz`, options);
    if (!health.ok) return 'occupied';
    const { status, protocol } = await health.json();
    if (status !== 'ok' || protocol !== PROTOCOL_VERSION) return 'occupied';
    const page = await fetch(`${origin}/lobby/`, options);
    return page.ok && (await page.text()).includes('id="battle-screen"') ? 'ready' : 'occupied';
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED' ? 'free' : 'occupied';
  }
}

async function startLocalServer(origin) {
  try {
    serverRequire.resolve('ws');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error('缺少服务端依赖。请在项目目录运行 npm ci --prefix server，然后双击本地测试.cmd。');
  }

  await mkdir(localDirectory, { recursive: true });
  const log = await open(serverLog, 'a');
  let server;
  try {
    server = spawn(process.execPath, [entryPoint, '--port', new URL(origin).port], {
      cwd: workspace, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
    await once(server, 'spawn');
  } finally {
    await log.close();
  }
  server.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await lobbyStatus(origin) === 'ready') return;
    if (server.exitCode !== null || server.signalCode !== null) break;
    await setTimeout(200);
  }
  if (server.exitCode === null && server.signalCode === null) server.kill();
  throw new Error(`本地大厅未能启动。请查看服务端日志 ${serverLog}`);
}

async function openLobby() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('本地测试需要 Node.js 22 或更高版本。');
  }
  let lobby;
  for (const port of [8081, 8082, 8083]) {
    const origin = `http://127.0.0.1:${port}`;
    const status = await lobbyStatus(origin);
    if (status === 'occupied') continue;
    if (status === 'free') await startLocalServer(origin);
    lobby = `${origin}/lobby/`;
    break;
  }
  if (!lobby) throw new Error('8081–8083 端口均已被占用，请关闭旧的本地服务后重试。');
  await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:TOS_LAUNCH_URL -ErrorAction Stop',
  ], {
    cwd: workspace,
    windowsHide: true,
    env: { ...process.env, TOS_LAUNCH_URL: lobby },
  });
}

try {
  await openLobby();
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
}
