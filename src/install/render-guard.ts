/**
 * The render guard: one check that the generated trees match their sources.
 *
 * It composes the skills guard and the hooks guard, which regenerate their trees and compare them with git.
 * It also declares its scopes as data and fails on a scope that holds no files, because a guard over an
 * empty path always passes. The guard generates nothing itself.
 */

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
  /**
   * `.claude/agents/` is not in this list. It holds a hand-authored agent, so a diff of it reports a human
   * edit as drift. The adapters write the other harness directories.
   */
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

/** The number of files under `dir`, recursively. Zero when `dir` is absent. */
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
 * Returns each declared scope that holds no files. A drift diff over a missing path is always clean.
 * Without this check, the guard passes exactly when it stops working.
 */
export function findEmptyScopes(cwd: string): RenderScope[] {
  return RENDER_SCOPES.filter((scope) => fileCount(join(cwd, scope.path)) === 0);
}

/**
 * Re-renders everything and checks that the generated trees match the committed trees. It runs the skills
 * guard (rendered trees and per-harness agent directories) and the hooks guard (plugin-root hooks and the
 * binding block). Then it adds the empty-scope check.
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
