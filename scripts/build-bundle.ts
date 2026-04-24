#!/usr/bin/env bun
/**
 * Unified build script for the Exarchos bundle.
 *
 * Produces a single `dist/exarchos.js` that serves as both CLI and MCP server:
 *   - `exarchos mcp`          → MCP server (stdio)
 *   - `exarchos workflow ...`  → CLI mode
 *
 * Playwright / Electron remain external because they are optional runtime
 * deps that callers bring themselves; bundling them would bloat the output
 * and break dynamic resolution. Native SQLite is no longer external —
 * persistence moved to `bun:sqlite` in v29, so no native addon copy step
 * is required.
 *
 * DEPRECATED (task 3.6): After PR2 rewired plugin.json and hooks.json to
 * invoke the bare `exarchos` PATH-resolved binary from
 * `scripts/build-binary.ts`, nothing in the shipping repo consumes
 * `dist/exarchos.js`. This script (and the output it emits) are slated for
 * deletion in task 3.6. NoLegacy_BuildBundleScriptAbsent in
 * `scripts/validate-no-legacy.test.sh` is the pinning assertion.
 */
import { $ } from 'bun';

const ENTRY = 'servers/exarchos-mcp/src/index.ts';
const OUTFILE = 'dist/exarchos.js';

// Browser automation / desktop runtimes — callers bring these; bundling
// them would both bloat the output and break dynamic resolution.
const EXTERNALS = [
  'playwright',
  'playwright-core',
  '@playwright/browser-chromium',
  'electron',
];

async function buildBundle(): Promise<void> {
  const externalFlags = EXTERNALS.flatMap((p) => ['--external', p]);
  await $`bun build ${ENTRY} --outfile ${OUTFILE} --target node --minify ${externalFlags}`;
}

await buildBundle();
