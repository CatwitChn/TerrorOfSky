import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const origin = 'http://127.0.0.1:8081';
const lobby = `${origin}/lobby/`;
const workspace = fileURLToPath(new URL('../', import.meta.url));
const entryPoint = fileURLToPath(new URL('./local.mjs', import.meta.url));
const run = promisify(execFile);

async function lobbyIsReady() {
  try {
    const options = { signal: AbortSignal.timeout(700), redirect: 'error' };
    const [health, page] = await Promise.all([
      fetch(`${origin}/healthz`, options),
      fetch(lobby, options),
    ]);
    return health.ok && page.ok
      && (await health.json()).status === 'ok'
      && (await page.text()).includes('id="battle-screen"');
  } catch {
    return false;
  }
}

function runPowerShell(command, settings) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: workspace,
    windowsHide: true,
    env: { ...process.env, ...settings },
  });
}

async function openLobby() {
  if (!await lobbyIsReady()) {
    const server = spawn(process.execPath, [entryPoint], {
      cwd: workspace, detached: true, windowsHide: true, stdio: 'ignore',
    });
    await once(server, 'spawn');
    server.unref();

    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (await lobbyIsReady()) {
        ready = true;
        break;
      }
      await setTimeout(200);
    }
    if (!ready) {
      throw new Error('本地大厅未能启动。请检查 8081 端口，或在项目目录运行 node tools/local.mjs 查看错误。');
    }
  }
  await runPowerShell('Start-Process -FilePath $env:TOS_LAUNCH_URL -ErrorAction Stop', { TOS_LAUNCH_URL: lobby });
}

try {
  await openLobby();
} catch (error) {
  process.exitCode = 1;
  console.error(error.message);
  await runPowerShell(
    'Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:TOS_LAUNCH_ERROR, "Terror of Sky")',
    { TOS_LAUNCH_ERROR: error.message },
  ).catch(() => {});
}
