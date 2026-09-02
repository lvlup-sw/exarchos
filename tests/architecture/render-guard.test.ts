import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RENDER_SCOPES, findEmptyScopes, runRenderGuard } from '../../src/install/render-guard.js';

/**
 * One guard now covers every generated tree. Consolidation removes two places
 * a scope could rot unnoticed, and introduces one new way to fail silently: a
 * single guard watching nothing reports one confident success for the whole
 * build rather than three narrow ones.
 *
 * So the drift legs are proven by seeding drift and watching the guard go red,
 * and the declared scope is proven to cover real files. That third assertion is
 * the one the consolidation makes necessary.
 *
 * Drift is seeded in a COPY of the tree, never in the repository itself. An
 * earlier version edited the real tree and ran `git add`, which raced the rest
 * of the suite for the index lock and staged files other tests had just
 * created — a test that corrupts the working tree it is measuring.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

/** Everything the guard reads or writes, and nothing else. */
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
function makeSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'render-guard-'));
  for (const tree of SANDBOX_TREES) {
    const from = join(REPO_ROOT, tree);
    if (existsSync(from)) cpSync(from, join(root, tree), { recursive: true });
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, env: GIT_ENV });
  return root;
}

/** Commit an edit to a generated file, so it reads as drift rather than as a
 *  pending edit the next build would overwrite. */
function seedDrift(root: string, rel: string, addition: string): void {
  appendFileSync(join(root, rel), addition);
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-q', '-m', 'drift'], { cwd: root, env: GIT_ENV });
}

describe('RenderGuard', () => {
  it('ConfiguredScope_MatchesNonEmptyFileSet', () => {
    // The liveness assertion. A consolidated guard matching nothing would be
    // strictly worse than the three it replaced.
    expect(RENDER_SCOPES.length).toBeGreaterThan(0);

    expect(
      findEmptyScopes(REPO_ROOT).map((s) => `${s.path} (${s.producer})`),
      'declared scopes covering no files',
    ).toEqual([]);
  });

  it('EveryDeclaredScope_NamesItsProducer', () => {
    // A scope with no named producer is a path nobody is accountable for.
    for (const scope of RENDER_SCOPES) {
      expect(scope.producer.length, `${scope.path} names no producer`).toBeGreaterThan(0);
      expect(existsSync(join(REPO_ROOT, scope.path)), `${scope.path} is absent`).toBe(true);
    }
  });

  it('DriftInRenderedTree_FailsClosed', () => {
    const root = makeSandbox();
    try {
      const clean = runRenderGuard({ cwd: root, regenerateAgents: () => {} });
      expect(clean.ok, `sandbox should start clean:\n${clean.message}`).toBe(true);

      seedDrift(root, 'rendered/skills/standard/plan/SKILL.md', '\n<!-- seeded drift -->\n');

      const drifted = runRenderGuard({ cwd: root, regenerateAgents: () => {} });
      expect(drifted.ok, 'drift in the rendered tree must fail the guard').toBe(false);
      expect(drifted.exitCode).not.toBe(0);
      expect(drifted.message).toMatch(/stale|drift/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);

  it('DriftInHarnessDotDirectory_FailsClosed', () => {
    const root = makeSandbox();
    try {
      // The agent generator is stubbed, so the drift has to be detected by the
      // diff over the harness directories rather than by regeneration.
      seedDrift(root, '.codex/agents/implementer.toml', '\n# seeded drift\n');

      const drifted = runRenderGuard({
        cwd: root,
        regenerateAgents: (cwd: string) => {
          // Restore the canonical bytes the way the real generator would, so
          // the committed edit shows up as a diff.
          cpSync(join(REPO_ROOT, '.codex/agents'), join(cwd, '.codex/agents'), {
            recursive: true,
          });
        },
      });
      expect(drifted.ok, 'drift in a harness dot-directory must fail the guard').toBe(false);
      expect(drifted.message).toMatch(/stale|drift/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
