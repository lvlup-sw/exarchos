#!/usr/bin/env bun
/**
 * Build script for the Exarchos MCP server bundle.
 *
 * 1. Bundles with --external for better-sqlite3 and its transitive deps
 *    (bindings, file-uri-to-path) so the native binary isn't inlined
 * 2. Copies the real packages to dist/node_modules/ so Node resolution
 *    finds them at runtime
 *
 * The native .node binary (~2MB) is platform-specific to the build machine.
 * Mismatched platforms fall back to JSONL-only mode via existing graceful fallback.
 */
import { $ } from 'bun';
import { cpSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Resolve from the MCP server directory where better-sqlite3 is installed
const mcpServerDir = resolve('servers/exarchos-mcp');
const require = createRequire(join(mcpServerDir, 'package.json'));

// Step 1: Bundle with externals
await $`bun build servers/exarchos-mcp/src/index.ts --outfile dist/exarchos-mcp.js --target node --minify --external better-sqlite3 --external bindings --external file-uri-to-path`;

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
