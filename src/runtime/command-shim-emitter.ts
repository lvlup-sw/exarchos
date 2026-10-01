/**
 * Maps the Exarchos slash commands to the invocation syntax of each runtime.
 * Copilot gets a mapping table in `.github/copilot-instructions.md`, and Cursor gets one in `.cursor/rules/exarchos-commands.md`.
 * Claude Code, Codex, and OpenCode are skipped. Claude Code reads `commands/*.md` directly.
 */

// RESERVED(issue: #1590, owner: exarchos, expires: 2027-01-31) — a dead stub. The module-intent gate requires
// its deletion at expiry if no caller adopts it. See also #1609.
// SHIM(runtimes: copilot+cursor, capability: slash-command-native) — a per-runtime command-discovery adapter.
// Cursor has no native slash-command loader, and Copilot reads its commands from `.github/copilot-instructions.md`.
// `SHIM_REGISTRY` in `src/install/shim-registry.ts` lists this adapter with an expiry.

import { join } from 'node:path';
import { toPosix } from '../utils/paths.js';
import { promises as nodeFs } from 'node:fs';
import type { AgentRuntimeName } from './agent-environment-detector.js';

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

/**
 * Canonical command name to description. `CANONICAL_COMMANDS` derives from this map, so each `skill` slug matches its command name.
 * The key set must equal `canonicalCommandSet()` in `src/install/config/canonical-skills.ts`. A test in `command-shim-emitter.test.ts` enforces this.
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

export const CANONICAL_COMMANDS: readonly CommandMapping[] = Object.entries(
  COMMAND_DESCRIPTIONS,
).map(([name, description]) => ({
  name,
  skill: `exarchos:${name}`,
  description,
}));

const DEFAULT_FS: ShimEmitterFs = {
  writeFile: (p, data) => nodeFs.writeFile(p, data, 'utf8'),
  mkdir: (p, opts) => nodeFs.mkdir(p, opts).then(() => undefined),
};

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
