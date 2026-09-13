#!/usr/bin/env node
// Build www/ from ../vlog (the deployed website) plus the native bridge.
//   node scripts/sync-web.mjs        then: npx cap sync ios
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vlog = join(root, '..', 'vlog');
const www = join(root, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(join(www, 'app'), { recursive: true });

// index.html: load the native bridge before any app script.
const marker = '<script src="/app/coach.js"></script>';
const html = readFileSync(join(vlog, 'index.html'), 'utf8');
if (!html.includes(marker)) throw new Error('vlog/index.html: coach.js script tag not found');
writeFileSync(join(www, 'index.html'), html.replace(marker, '<script src="/native.js"></script>\n' + marker));

// App scripts and static assets. _worker.js, landing.css and the duplicate app/index.html are not needed.
for (const file of readdirSync(join(vlog, 'app'))) {
  if (file.endsWith('.js')) cpSync(join(vlog, 'app', file), join(www, 'app', file));
}
cpSync(join(vlog, 'assets'), join(www, 'assets'), { recursive: true });

buildSync({
  entryPoints: [join(root, 'src', 'native.js')],
  bundle: true, minify: true, format: 'iife', target: ['safari15'],
  outfile: join(www, 'native.js'), logLevel: 'warning'
});

console.log('www/ ready:', readdirSync(www).join(', '));
