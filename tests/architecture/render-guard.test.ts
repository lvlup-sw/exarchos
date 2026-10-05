/**
 * One guard covers every generated tree. A single guard that watches nothing
 * reports one success for the whole build.
 *
 * Thus the tests seed drift and require the guard to fail, and they prove that
 * each declared scope covers real files.
 *
 * The tests seed drift in a copy of the tree and never in the repository. An
 * edit of the real tree with `git add` races the other tests for the index
 * lock and stages their files.
 */

import { appendFileSync, cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RENDER_SCOPES, findEmptyScopes, runRenderGuard } from '../../src/install/render-guard.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

/** The trees that the guard reads or writes, and no others. */
const SANDBOX_TREES = [
  'content',
  'rendered',
  'hooks',
  'binding',
  '.codex/agents',
  '.cursor/agents',
  '.opencode/agents',
  '.github/agents',
];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** A committed copy of the generated trees, isolated from the real repository. */
async function makeSandbox(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'render-guard-'));
  for (const tree of SANDBOX_TREES) {
    const from = join(REPO_ROOT, tree);
    if (existsSync(from)) cpSync(from, join(root, tree), { recursive: true });
  }
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  await execFileAsync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: GIT_ENV });
  return root;
}

/**
 * Commits an edit to a generated file. Thus the guard sees drift and not a
 * pending edit that the next build overwrites.
 */
async function seedDrift(root: string, rel: string, addition: string): Promise<void> {
  appendFileSync(join(root, rel), addition);
  await execFileAsync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  await execFileAsync('git', ['commit', '-q', '-m', 'drift'], { cwd: root, env: GIT_ENV });
}

describe('RenderGuard', () => {
  /** The liveness assertion. One guard for every tree must not match nothing. */
  it('ConfiguredScope_MatchesNonEmptyFileSet', () => {
    expect(RENDER_SCOPES.length).toBeGreaterThan(0);

    expect(
      findEmptyScopes(REPO_ROOT).map((s) => `${s.path} (${s.producer})`),
      'declared scopes covering no files',
    ).toEqual([]);
  });

  /** Nobody is accountable for a scope with no named producer. */
  it('EveryDeclaredScope_NamesItsProducer', () => {
    for (const scope of RENDER_SCOPES) {
      expect(scope.producer.length, `${scope.path} names no producer`).toBeGreaterThan(0);
      expect(existsSync(join(REPO_ROOT, scope.path)), `${scope.path} is absent`).toBe(true);
    }
  });

  it('DriftInRenderedTree_FailsClosed', async () => {
    const root = await makeSandbox();
    try {
      const clean = runRenderGuard({ cwd: root, regenerateAgents: () => {} });
      expect(clean.ok, `sandbox should start clean:\n${clean.message}`).toBe(true);

      await seedDrift(root, 'rendered/skills/standard/plan/SKILL.md', '\n<!-- seeded drift -->\n');

      const drifted = runRenderGuard({ cwd: root, regenerateAgents: () => {} });
      expect(drifted.ok, 'drift in the rendered tree must fail the guard').toBe(false);
      expect(drifted.exitCode).not.toBe(0);
      expect(drifted.message).toMatch(/stale|drift/i);
    } finally {
      rmrf(root);
    }
  }, 300_000);

  /**
   * The agent generator is a stub that restores the canonical bytes, as the real
   * generator does. Thus the committed edit shows as a diff over the harness
   * directories.
   */
  it('DriftInHarnessDotDirectory_FailsClosed', async () => {
    const root = await makeSandbox();
    try {
      await seedDrift(root, '.codex/agents/implementer.toml', '\n# seeded drift\n');

      const drifted = runRenderGuard({
        cwd: root,
        regenerateAgents: (cwd: string) => {
          cpSync(join(REPO_ROOT, '.codex/agents'), join(cwd, '.codex/agents'), {
            recursive: true,
          });
        },
      });
      expect(drifted.ok, 'drift in a harness dot-directory must fail the guard').toBe(false);
      expect(drifted.message).toMatch(/stale|drift/i);
    } finally {
      rmrf(root);
    }
  }, 300_000);
});
