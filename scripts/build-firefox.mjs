#!/usr/bin/env node
// Regenerates firefox/ from src/, icons/ and manifest.json so the Gecko package
// can't drift from the Chromium one. Run after any change: node scripts/build-firefox.mjs
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'firefox');

for (const dir of ['src', 'icons']) {
  rmSync(join(out, dir), { recursive: true, force: true });
  cpSync(join(root, dir), join(out, dir), { recursive: true });
}
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
// Gecko has no MV3 service workers; it runs the same file as an event page.
manifest.background = { scripts: [manifest.background.service_worker] };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`firefox/ rebuilt (v${manifest.version})`);
