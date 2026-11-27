import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const runtimeFiles = [
  './local.mjs', './local-build.mjs',
  '../lobby/battle-audio.mjs',
  '../server/server.mjs', '../server/match.mjs', '../server/simulation.mjs', '../server/flight-model.mjs',
  '../server/missions.mjs', '../server/airfields.mjs', '../server/combat.mjs', '../server/tutorial.mjs', '../server/package.json',
];

export async function readLocalBuild() {
  const sources = await Promise.all(runtimeFiles.map(file => readFile(new URL(file, import.meta.url))));
  const hash = createHash('sha256');
  for (const [index, source] of sources.entries()) {
    hash.update(runtimeFiles[index]).update('\0').update(source).update('\0');
  }
  return hash.digest('hex');
}
