/**
 * CommandShimEmitter — maps exarchos slash commands to runtime-appropriate
 * invocation syntax.
 *
 * Each runtime has a different mechanism for command discovery:
 * - **Copilot**: `.github/copilot-instructions.md` with a mapping table
 * - **Cursor**: `.cursor/rules/exarchos-commands.md` with a mapping table
 * - **Claude Code**: No-op (commands already work via `commands/*.md`)
 * - **Codex / OpenCode**: Currently no-op (stubs)
 *
 * The canonical command list is hardcoded from the known exarchos commands.
 */

import { join } from 'node:path';
import { toPosix } from '../utils/paths.js';
import { promises as nodeFs } from 'node:fs';
import type { AgentRuntimeName } from './agent-environment-detector.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CommandMapping {
  readonly name: string;
  readonly skill: string;
  readonly description: string;
}

export interface CommandShimResult {
  readonly runtime: string;
  readonly path: string;
  readonly status: 'written' | 'skipped';
  readonly commandCount: number;
}

/** Narrow fs surface for testability. */
export interface ShimEmitterFs {
  writeFile(p: string, data: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface ShimEmitterDeps {
  readonly fs?: ShimEmitterFs;
}

// ─── Canonical command list ─────────────────────────────────────────────────

/**
 * Canonical command name → human-readable description.
 *
 * This map is the single hand-kept structure for the shim; `CANONICAL_COMMANDS`
 * is DERIVED from it so the `skill` slug can never drift from the command name.
 * The key set MUST equal the root canonical source-of-truth
 * (`src/config/canonical-skills.ts` → `canonicalCommandSet()`); the co-located
 * coupling guard in `command-shim-emitter.test.ts` imports that accessor across
 * the package boundary and fails CI on any divergence. (The MCP package cannot
 * import the root SoT in production code — `rootDir: ./src` — so the coupling is
 * enforced test-only.)
 *
 * Drift history:
 * - `tdd` was retired in #1590 (commands/tdd.md + alias + COMMAND_TO_SKILL entry
 *   deleted); dropped here too so shim-consuming runtimes (Copilot, Cursor) stop
 *   advertising `/tdd` → a skill that no longer exists.
 * - `reload` had no commands/reload.md and no SoT entry; dropped (#1609).
 * - `discover` + `invariants` have command files + SoT entries but were missing
 *   here; added (#1609).
 */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  ideate: 'Start collaborative design exploration for a feature or problem',
  plan: 'Create TDD implementation plan from design document',
  review: 'Run two-stage review (spec compliance + code quality)',
  synthesize: 'Create pull request from feature branch',
  shepherd: 'Shepherd PRs through CI and reviews to merge readiness',
  debug: 'Start debug workflow for bugs and regressions',
  refactor: 'Start refactor workflow for code improvement',
  oneshot: 'Run a lightweight oneshot workflow — plan + TDD implement + optional PR',
  delegate: 'Dispatch tasks to Claude Code subagents',
  rehydrate: 'Re-inject workflow state and behavioral guidance into current context',
  checkpoint: 'Save workflow state and prepare for session handoff',
  cleanup: 'Resolve merged workflow to completed state',
  prune: 'Prune stale workflows from the pipeline',
  autocompact: 'Toggle autocompact on/off or set threshold percentage',
  dogfood: 'Review failed tool calls, diagnose root causes, and triage',
  discover: 'Start a discovery workflow for research and document deliverables',
  invariants: 'Author an architectural invariant catalog entry through a guided interview',
  tag: 'Retroactively attribute the current session to a feature, project, or concern',
};

export const CANONICAL_COMMANDS: readonly CommandMapping[] = Object.keys(
  COMMAND_DESCRIPTIONS,
).map((name) => ({
  name,
  skill: `exarchos:${name}`,
  description: COMMAND_DESCRIPTIONS[name],
}));

// ─── Default fs ─────────────────────────────────────────────────────────────

const DEFAULT_FS: ShimEmitterFs = {
  writeFile: (p, data) => nodeFs.writeFile(p, data, 'utf8'),
  mkdir: (p, opts) => nodeFs.mkdir(p, opts).then(() => undefined),
};

// ─── Emitter ────────────────────────────────────────────────────────────────

/**
 * Emit a command shim file for the given runtime. Returns metadata about
 * the write operation (path, status, command count).
 */
export async function emitCommandShim(
  runtime: AgentRuntimeName,
  projectRoot: string,
  deps?: ShimEmitterDeps,
): Promise<CommandShimResult> {
  const fs = deps?.fs ?? DEFAULT_FS;

  switch (runtime) {
    case 'copilot':
      return emitCopilotShim(projectRoot, fs);
    case 'cursor':
      return emitCursorShim(projectRoot, fs);
    case 'claude-code':
      return {
        runtime,
        path: '',
        status: 'skipped',
        commandCount: 0,
      };
    case 'codex':
    case 'opencode':
      return {
        runtime,
        path: '',
        status: 'skipped',
        commandCount: 0,
      };
  }
}

// ─── Per-runtime emitters ───────────────────────────────────────────────────

async function emitCopilotShim(
  projectRoot: string,
  fs: ShimEmitterFs,
): Promise<CommandShimResult> {
  const dir = toPosix(join(projectRoot, '.github'));
  const filePath = toPosix(join(dir, 'copilot-instructions.md'));

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, renderCommandTable());

  return {
    runtime: 'copilot',
    path: filePath,
    status: 'written',
    commandCount: CANONICAL_COMMANDS.length,
  };
}

async function emitCursorShim(
  projectRoot: string,
  fs: ShimEmitterFs,
): Promise<CommandShimResult> {
  const dir = toPosix(join(projectRoot, '.cursor', 'rules'));
  const filePath = toPosix(join(dir, 'exarchos-commands.md'));

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, renderCommandTable());

  return {
    runtime: 'cursor',
    path: filePath,
    status: 'written',
    commandCount: CANONICAL_COMMANDS.length,
  };
}

// ─── Shared renderer ────────────────────────────────────────────────────────

function renderCommandTable(): string {
  const lines: string[] = [
    '## Exarchos Commands',
    '',
  ];

  for (const cmd of CANONICAL_COMMANDS) {
    lines.push(
      `When the user types \`/${cmd.name}\`, invoke the ${cmd.skill} skill via exarchos_orchestrate MCP tool. ${cmd.description}.`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
