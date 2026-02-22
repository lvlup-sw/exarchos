#!/usr/bin/env bun
/**
 * Build script for the Exarchos CLI bundle.
 *
 * 1. Bundles with --external for playwright-core and electron (large, unused)
 * 2. Creates stub node_modules so the external imports resolve at runtime
 *
 * playwright-core and electron are transitive Azure SDK deps, never used.
 */
import { $ } from 'bun';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Step 1: Bundle with externals
await $`bun build servers/exarchos-mcp/src/cli.ts --outfile dist/exarchos-cli.js --target node --external playwright-core --external electron`;

// Step 2: Create stub node_modules for the externals
const stubs = ['playwright-core', 'electron'];
const stubDir = join('dist', 'node_modules');

for (const pkg of stubs) {
  const dir = join(stubDir, pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), 'module.exports = {};');
}

console.log('  Stubs created for:', stubs.join(', '));
