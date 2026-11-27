import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION } from '../server/missions.mjs';
import { readLocalBuild } from './local-build.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const entryPoint = fileURLToPath(new URL('./local.mjs', import.meta.url));
const localDirectory = new URL('../.local/', import.meta.url);
const localNode = fileURLToPath(new URL('node/node.exe', localDirectory));
const serverLog = fileURLToPath(new URL('server.log', localDirectory));
const serverRequire = createRequire(new URL('../server/package.json', import.meta.url));
const run = promisify(execFile);
const firstPort = 8081;
const lastPort = 8090;
const ports = Array.from({ length: lastPort - firstPort + 1 }, (_, index) => firstPort + index);
const localOrigin = port => `http://127.0.0.1:${port}`;

async function lobbyStatus(origin, build) {
  try {
    const options = { signal: AbortSignal.timeout(700), redirect: 'error' };
    const health = await fetch(`${origin}/healthz`, options);
    if (!health.ok) return 'occupied';
    const { status, protocol } = await health.json();
    if (status !== 'ok') return 'occupied';
    const page = await fetch(`${origin}/lobby/`, options);
    if (!page.ok) return 'occupied';
    const html = await page.text();
    if (!html.includes('Terror of Sky') || !html.includes('id="battle-screen"')) return 'occupied';
    if (protocol === undefined || (Number.isInteger(protocol) && protocol < PROTOCOL_VERSION)) return 'outdated';
    if (protocol !== PROTOCOL_VERSION) return 'occupied';
    const revision = await fetch(`${origin}/local-build`, options);
    if (revision.status === 404) return 'outdated';
    if (!revision.ok) return 'occupied';
    const runningBuild = await revision.text();
    if (runningBuild === build) return 'ready';
    return /^[a-f0-9]{64}$/.test(runningBuild) ? 'outdated' : 'occupied';
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED' ? 'free' : 'occupied';
  }
}

async function clearOldServers(build) {
  let listeners;
  try {
    const { stdout } = await run('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true });
    listeners = new Map([...stdout.matchAll(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+LISTENING\s+(\d+)\s*$/gm)]
      .map(([, port, pid]) => [Number(port), pid]).filter(([port]) => ports.includes(port)));
  } catch {
    return;
  }
  for (const [port, pid] of listeners) {
    if (await lobbyStatus(localOrigin(port), build) !== 'outdated') continue;
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
        $serviceId = [int]$env:TOS_OLD_SERVICE_ID
        $owner = Get-Process -Id $serviceId -ErrorAction SilentlyContinue
        if (!$owner -or $owner.ProcessName -ne 'node') { exit }
        if ($owner.Path -ne $env:TOS_PROJECT_NODE) {
          $info = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $serviceId" -ErrorAction SilentlyContinue
          $entry = [regex]::Escape($env:TOS_PROJECT_ENTRY)
          if (!$info -or $info.CommandLine -notmatch ('(?:^|\s)"?' + $entry + '"?(?:\s|$)')) { exit }
        }
        $listener = '^\s*TCP\s+127\.0\.0\.1:' + $env:TOS_OLD_SERVICE_PORT + '\s+0\.0\.0\.0:0\s+LISTENING\s+' + $serviceId + '\s*$'
        if ($owner.HasExited -or !(netstat.exe -ano -p tcp | Select-String -Pattern $listener -Quiet)) { exit }
        Stop-Process -InputObject $owner -ErrorAction Stop
        Wait-Process -Id $serviceId -Timeout 2 -ErrorAction SilentlyContinue
        'stopped'
      `], {
        cwd: workspace,
        windowsHide: true,
        timeout: 5000,
        env: { ...process.env, TOS_OLD_SERVICE_ID: pid, TOS_OLD_SERVICE_PORT: String(port),
          TOS_PROJECT_NODE: localNode, TOS_PROJECT_ENTRY: entryPoint },
      });
      if (stdout.trim() === 'stopped') console.log(`已关闭旧版 Terror of Sky 本地服务（${port}，PID ${pid}）。`);
    } catch {
      console.warn(`无法关闭 ${port} 上的旧版服务，将尝试使用其他端口。`);
    }
  }
}

function checkServerDependencies() {
  try {
    serverRequire.resolve('ws');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error('缺少服务端依赖。请在项目目录运行 npm ci --prefix server，然后双击本地测试.cmd。');
  }
}

async function startLocalServer(origin, build) {
  checkServerDependencies();
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
    if (await lobbyStatus(origin, build) === 'ready') return;
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
  const origins = ports.map(localOrigin);
  const build = await readLocalBuild();
  const status = origin => lobbyStatus(origin, build);
  let statuses = await Promise.all(origins.map(status));
  if (!statuses.includes('ready')) {
    checkServerDependencies();
    await clearOldServers(build);
    statuses = await Promise.all(origins.map(status));
  }
  const ready = statuses.indexOf('ready');
  const free = statuses.indexOf('free');
  if (ready < 0 && free < 0) throw new Error(`${firstPort}–${lastPort} 端口均已被占用，请检查占用进程。`);
  const origin = origins[ready >= 0 ? ready : free];
  if (ready < 0) await startLocalServer(origin, build);
  const lobby = `${origin}/lobby/`;
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
