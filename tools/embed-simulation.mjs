import { readFile, writeFile } from 'node:fs/promises';

const htmlPath = new URL('../index.html', import.meta.url);
const original = await readFile(htmlPath, 'utf8');
const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
const simulation = await readFile(new URL('../server/simulation.mjs', import.meta.url), 'utf8');
const marker = '// Exports for the headless server.';
const end = simulation.indexOf(marker);
if (end < 0) throw new Error('Missing simulation export marker.');
const body = simulation.slice(0, end).trimEnd().split(/\r?\n/)
  .map(line => line ? `    ${line}` : '').join('\n');
const section = /(^    \/\/ BEGIN SHARED BATTLE SIMULATION\n)[\s\S]*?(\n    \/\/ END SHARED BATTLE SIMULATION$)/m;
const html = original.replace(/\r\n/g, '\n');
if (!section.test(html)) throw new Error('Missing simulation markers in index.html.');
const updated = html.replace(section, (_, begin, finish) => begin + body + finish).replace(/\n/g, lineEnding);
if (process.argv.includes('--check')) {
  if (updated !== original) throw new Error('Run node tools/embed-simulation.mjs to update index.html.');
} else if (updated !== original) {
  await writeFile(htmlPath, updated);
}
