// ─── The single render guard ─────────────────────────────────────────────────
//
// One guard over everything the build generates. It replaces three that each
// covered a slice: one for the rendered artifact trees, one for the hook and
// binding output, one for the embedded runtime module.
//
// Three guards meant three chances for a scope to go stale unnoticed, and no
// single place that answered "is the generated tree in sync with its sources".
// Consolidating them also consolidates the liveness question: this guard
// declares its scope as data, and a scope that matches no files on disk is
// itself a failure. A guard covering nothing passes every time, which is worse
// than the three narrow guards it replaced.
//
// The guard does not decide *how* anything is generated — it composes the
// existing generators and then diffs what they wrote against git.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runSkillsGuard, type SkillsGuardOptions } from './skills-guard.js';
import { runHooksGuard } from './hooks-guard.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';

/** A tree this guard claims to cover, and why it is generated output. */
export interface RenderScope {
  /** Repo-relative path. */
  readonly path: string;
  /** What writes it. */
  readonly producer: string;
}

/**
 * Everything the build generates. Declared as data so the liveness check has
 * something to iterate: each entry must resolve to a non-empty tree on disk.
 */
export const RENDER_SCOPES: readonly RenderScope[] = [
  { path: 'rendered/skills', producer: 'build-skills' },
  { path: 'rendered/commands', producer: 'build-authored-artifacts' },
  { path: 'rendered/rules', producer: 'build-authored-artifacts' },
  { path: 'rendered/command-aliases', producer: 'build-command-aliases' },
  { path: 'rendered/agents', producer: 'generate-agents' },
  { path: 'hooks', producer: 'build-hooks' },
  // `.claude/agents/` is deliberately absent: it holds a hand-authored agent,
  // not generator output, and diffing it here would report a human edit as
  // drift. The other harness directories are written by the adapters.
  { path: '.codex/agents', producer: 'generate-agents' },
  { path: '.cursor/agents', producer: 'generate-agents' },
  { path: '.opencode/agents', producer: 'generate-agents' },
  { path: '.github/agents', producer: 'generate-agents' },
];

export interface RenderGuardResult {
  ok: boolean;
  exitCode: number;
  message: string;
}

export interface RenderGuardOptions {
  cwd: string;
  /** Injected for tests, forwarded to the skills leg. */
  regenerateAgents?: SkillsGuardOptions['regenerateAgents'];
}

/** Files directly under `dir`, recursively. Empty when `dir` is absent. */
function fileCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    n += statSync(p).isDirectory() ? fileCount(p) : 1;
  }
  return n;
}

/**
 * Report every declared scope that covers nothing.
 *
 * This is the check the consolidation makes possible and also makes necessary.
 * A drift diff over a path that does not exist is trivially clean, so without
 * this the guard reports success precisely when it has stopped working.
 */
export function findEmptyScopes(cwd: string): RenderScope[] {
  return RENDER_SCOPES.filter((scope) => fileCount(join(cwd, scope.path)) === 0);
}

/**
 * Re-render everything and verify the generated trees match what is committed.
 *
 * Composes the skills leg (rendered artifact trees plus the per-harness agent
 * directories) and the hooks leg (plugin-root hooks and the binding block),
 * then adds the scope-liveness assertion neither of them could make alone.
 */
export function runRenderGuard(opts: RenderGuardOptions): RenderGuardResult {
  const { cwd } = opts;
  const failures: string[] = [];

  const empty = findEmptyScopes(cwd);
  if (empty.length > 0) {
    failures.push(
      `[render:guard] ${empty.length} declared scope(s) cover no files — the guard is not ` +
        `watching what it claims to:\n` +
        empty.map((s) => `  ${s.path} (written by ${s.producer})`).join('\n'),
    );
  }

  const skills = runSkillsGuard(
    opts.regenerateAgents === undefined
      ? { cwd }
      : { cwd, regenerateAgents: opts.regenerateAgents },
  );
  if (!skills.ok) failures.push(skills.message);

  const hooks = runHooksGuard({ cwd });
  if (!hooks.ok) failures.push(hooks.message);

  if (failures.length > 0) {
    return { ok: false, exitCode: 1, message: failures.join('\n\n') };
  }
  return {
    ok: true,
    exitCode: 0,
    message:
      `[render:guard] ${RENDER_SCOPES.length} generated scopes are in sync with content/ ` +
      `(rendered trees, plugin hooks, and the per-harness agent directories)`,
  };
}

/** CLI entry: `node dist/install/render-guard.js`. */
export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);
  const result = runRenderGuard({ cwd: cwd() });
  if (result.ok) {
    log(result.message);
  } else {
    errLog(result.message);
  }
  exit(result.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
