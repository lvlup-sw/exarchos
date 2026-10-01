/**
 * The canonical list of runtime-config writers for the GENERATE stage. The
 * `buildWriterDeps` factory is in `./probes.js`, and the `.exarchos.yml`
 * seeder is in `./seed-exarchos-config.js`.
 */

import type { RuntimeConfigWriter } from './writers/writer.js';

import { ClaudeCodeWriter } from './writers/claude-code.js';
import { CopilotWriter } from './writers/copilot.js';
import { CursorWriter } from './writers/cursor.js';
import { CodexWriter } from './writers/codex.js';
import { OpenCodeWriter } from './writers/opencode.js';

/**
 * All production runtime-config writers, in output order. `onboard` and
 * `doctor --fix` use this list through the reconciler GENERATE stage, so the
 * config-writing behavior has one source.
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
