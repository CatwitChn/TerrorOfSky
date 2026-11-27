import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const nodeVersion = '24.22.3';
const runtime = `node-v${nodeVersion}-win-x64`;
const runtimeZip = `${runtime}.zip`;
const distributionUrl = `https://nodejs.org/dist/v${nodeVersion}/`;
const source = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

async function download(file) {
  const response = await fetch(new URL(file, distributionUrl), { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Node.js download failed for ${file} (HTTP ${response.status}).`);
  return response;
}

if (process.platform !== 'win32') throw new Error('Run this packaging script on Windows with tar.exe available.');

const { version } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const dependency = await realpath(join(source, 'node_modules', 'ws'));
const destination = join(source, '..', 'dist');
await mkdir(destination, { recursive: true });
const dist = await realpath(destination);
const build = await mkdtemp(join(dist, 'windows-build-'));

try {
  const packageName = `terror-of-sky-server-${version}-windows-x64`;
  const contents = join(build, packageName);
  await mkdir(join(contents, 'node_modules'), { recursive: true });

  const manifest = await (await download('SHASUMS256.txt')).text();
  const expected = manifest.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(([, file]) => file === runtimeZip)?.[0];
  if (!expected) throw new Error(`Missing Node.js checksum for ${runtimeZip}.`);

  const downloaded = join(build, runtimeZip);
  const response = await download(runtimeZip);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(downloaded));
  const digest = createHash('sha256').update(await readFile(downloaded)).digest('hex');
  if (digest !== expected) throw new Error('The Node.js distribution failed SHA-256 verification.');

  await run('tar.exe', ['-xf', downloaded, '-C', build, `${runtime}/node.exe`, `${runtime}/LICENSE`]);
  await Promise.all([
    copyFile(join(build, runtime, 'node.exe'), join(contents, 'node.exe')),
    copyFile(join(build, runtime, 'LICENSE'), join(contents, 'NODE-LICENSE.txt')),
    cp(dependency, join(contents, 'node_modules', 'ws'), { recursive: true }),
    ...['server.mjs', 'match.mjs', 'simulation.mjs', 'flight-model.mjs', 'missions.mjs', 'airfields.mjs', 'combat.mjs', 'tutorial.mjs', 'package.json', 'start-server.cmd', 'README.md'].map(file =>
      copyFile(join(source, file), join(contents, file))),
  ]);

  const archive = `${packageName}.zip`;
  const output = join(dist, archive);
  await run('tar.exe', ['-acf', join(build, archive), '-C', build, packageName]);
  await rename(join(build, archive), output);
  console.log(output);
} finally {
  const staging = await realpath(build);
  if (dirname(staging) === dist && basename(staging).startsWith('windows-build-')) {
    await rm(staging, { recursive: true, force: true });
  }
}
