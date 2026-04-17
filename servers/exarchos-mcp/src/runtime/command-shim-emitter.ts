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

export const CANONICAL_COMMANDS: readonly CommandMapping[] = [
  { name: 'ideate', skill: 'exarchos:ideate', description: 'Start collaborative design exploration for a feature or problem' },
  { name: 'plan', skill: 'exarchos:plan', description: 'Create TDD implementation plan from design document' },
  { name: 'tdd', skill: 'exarchos:tdd', description: 'Plan implementation following strict TDD (Red-Green-Refactor)' },
  { name: 'review', skill: 'exarchos:review', description: 'Run two-stage review (spec compliance + code quality)' },
  { name: 'synthesize', skill: 'exarchos:synthesize', description: 'Create pull request from feature branch' },
  { name: 'shepherd', skill: 'exarchos:shepherd', description: 'Shepherd PRs through CI and reviews to merge readiness' },
  { name: 'debug', skill: 'exarchos:debug', description: 'Start debug workflow for bugs and regressions' },
  { name: 'refactor', skill: 'exarchos:refactor', description: 'Start refactor workflow for code improvement' },
  { name: 'oneshot', skill: 'exarchos:oneshot', description: 'Run a lightweight oneshot workflow — plan + TDD implement + optional PR' },
  { name: 'delegate', skill: 'exarchos:delegate', description: 'Dispatch tasks to Claude Code subagents' },
  { name: 'rehydrate', skill: 'exarchos:rehydrate', description: 'Re-inject workflow state and behavioral guidance into current context' },
  { name: 'checkpoint', skill: 'exarchos:checkpoint', description: 'Save workflow state and prepare for session handoff' },
  { name: 'cleanup', skill: 'exarchos:cleanup', description: 'Resolve merged workflow to completed state' },
  { name: 'prune', skill: 'exarchos:prune', description: 'Prune stale workflows from the pipeline' },
  { name: 'autocompact', skill: 'exarchos:autocompact', description: 'Toggle autocompact on/off or set threshold percentage' },
  { name: 'dogfood', skill: 'exarchos:dogfood', description: 'Review failed tool calls, diagnose root causes, and triage' },
  { name: 'reload', skill: 'exarchos:reload', description: 'Manually trigger context reload to recover from context degradation' },
  { name: 'tag', skill: 'exarchos:tag', description: 'Retroactively attribute the current session to a feature, project, or concern' },
] as const;

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
  const dir = join(projectRoot, '.github');
  const filePath = join(dir, 'copilot-instructions.md');

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
  const dir = join(projectRoot, '.cursor', 'rules');
  const filePath = join(dir, 'exarchos-commands.md');

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
