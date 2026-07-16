#!/usr/bin/env node
// Minimal smoke test: syntax-check every project .js file with `node --check`.
// There is no real test suite yet (see docs/roadmap.md); this at least catches
// parse errors before they hit the running bot. Run via `npm test`.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IGNORE = new Set(['node_modules', '.git']);

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const root = path.resolve(__dirname, '..');
const files = collect(root).sort();
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${path.relative(root, file)}`);
    console.error((err.stderr || err.message).toString().trim());
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed syntax check.`);
  process.exit(1);
}
console.log(`✓ ${files.length} files passed syntax check.`);
