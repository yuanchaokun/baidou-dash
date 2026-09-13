#!/usr/bin/env node
// Inline app/ui.css into vlog/index.html and vlog/app/index.html.
// Both HTML files must stay byte-identical; run this after editing ui.css.
//   node vlog-infra/inline-css.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'vlog');
const css = readFileSync(join(root, 'app/ui.css'), 'utf8').trim();
const open = '<style data-source="ui.css">';
const close = '</style>';

for (const rel of ['index.html', 'app/index.html']) {
  const path = join(root, rel);
  const html = readFileSync(path, 'utf8');
  const start = html.indexOf(open);
  if (start < 0) throw new Error(`${rel}: missing ${open}`);
  const end = html.indexOf(close, start);
  const next = html.slice(0, start + open.length) + '\n' + css + '\n' + html.slice(end);
  writeFileSync(path, next);
  console.log(`${rel}: inlined ${css.length} bytes`);
}
