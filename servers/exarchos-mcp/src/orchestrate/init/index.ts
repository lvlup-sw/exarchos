/**
 * Canonical runtime-writer list (the GENERATE-stage source of truth).
 *
 * The legacy `init` action/handler (`handleInit` / `handleInitWithWriters` and
 * its `init.executed` event) were removed in DR-5 (task 018). What survives here
 * is the single canonical writer list that `onboard` (and `doctor --fix`) reuse
 * through the reconciler's GENERATE stage — so config-writing behavior is
 * single-sourced (INV-2 / DR-1), never a duplicated list.
 *
 * `buildWriterDeps` (the real-fs `WriterDeps` factory) lives in `./probes.js`;
 * `seedExarchosConfig` (the `.exarchos.yml` seeder reused by CONFIG/apply) lives
 * in `./seed-exarchos-config.js`. Both are imported directly by their consumers,
 * not re-exported here.
 */

import type { RuntimeConfigWriter } from './writers/writer.js';

import { ClaudeCodeWriter } from './writers/claude-code.js';
import { CopilotWriter } from './writers/copilot.js';
import { CursorWriter } from './writers/cursor.js';
import { CodexWriter } from './writers/codex.js';
import { OpenCodeWriter } from './writers/opencode.js';

/**
 * All production runtime-config writers. Order is preserved in output.
 *
 * Exported so the `onboard` pipeline (DR-2 GENERATE stage) and `doctor --fix`
 * reuse the EXACT same writer list — one canonical source, never a duplicate
 * list (INV-2 / DR-1: behavior is single-sourced).
 */
export function getAllWriters(): ReadonlyArray<RuntimeConfigWriter> {
  return [
    new ClaudeCodeWriter(),
    new CopilotWriter(),
    new CursorWriter(),
    new CodexWriter(),
    new OpenCodeWriter(),
  ];
}
