#!/usr/bin/env bun
// task 1.3: platform-variant logic to be removed in this task
/**
 * Unified build script for the Exarchos bundle.
 *
 * Produces a single `dist/exarchos.js` that serves as both CLI and MCP server:
 *   - `exarchos mcp`          → MCP server (stdio)
 *   - `exarchos workflow ...`  → CLI mode
 *
 * Uses --external for better-sqlite3 and its transitive deps so the native
 * binary isn't inlined, then copies real packages to dist/node_modules/.
 */
import { $ } from 'bun';
import { cpSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Resolve from the MCP server directory where better-sqlite3 is installed
const mcpServerDir = resolve('servers/exarchos-mcp');
const require = createRequire(join(mcpServerDir, 'package.json'));

// Step 1: Bundle with externals
await $`bun build servers/exarchos-mcp/src/index.ts --outfile dist/exarchos.js --target node --minify --external better-sqlite3 --external bindings --external file-uri-to-path --external playwright --external playwright-core --external @playwright/browser-chromium --external electron`;

// Step 2: Copy real packages to dist/node_modules/
const destModules = join('dist', 'node_modules');

const packages = [
  {
    name: 'better-sqlite3',
    // Copy only what's needed: package.json, lib/, build/Release/
    files: ['package.json', 'lib', 'build'],
  },
  {
    name: 'bindings',
    files: ['package.json', 'bindings.js'],
  },
  {
    name: 'file-uri-to-path',
    files: ['package.json', 'index.js'],
  },
];

for (const pkg of packages) {
  const srcDir = dirname(require.resolve(`${pkg.name}/package.json`));
  const destDir = join(destModules, pkg.name);
  mkdirSync(destDir, { recursive: true });

  for (const file of pkg.files) {
    const src = join(srcDir, file);
    const dest = join(destDir, file);
    cpSync(src, dest, { recursive: true });
  }

  console.log(`  Copied ${pkg.name}`);
}
