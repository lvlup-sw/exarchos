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
 */
import { $ } from 'bun';

await $`bun build servers/exarchos-mcp/src/index.ts --outfile dist/exarchos.js --target node --minify --external playwright --external playwright-core --external @playwright/browser-chromium --external electron`;
