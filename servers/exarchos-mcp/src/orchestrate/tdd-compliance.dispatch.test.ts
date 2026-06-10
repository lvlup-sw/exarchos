// ─── check_tdd_compliance: dispatch-path config resolution (FIX-2) ───────────
//
// The composite dispatch adapter injects `(args, stateDir, eventStore)` only —
// `handleTddCompliance`'s 4th positional `config` parameter is NEVER threaded
// through MCP/CLI dispatch. Before FIX-2 the severity therefore always resolved
// from built-in DEFAULTS, and a project `.exarchos.yml` review-gate override
// re-blocking `tdd-compliance` silently no-oped. These tests dispatch THROUGH
// `handleOrchestrate` against a real fixture repo so the override path is
// exercised exactly the way production reaches it.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function initRepo(prefix: string): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repoRoot, ['init', '--initial-branch=main', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

/** Base commit on main + a task branch with one impl-without-test commit. */
function writeTaskBranch(repoRoot: string, exarchosYml?: string): void {
  writeFileSync(path.join(repoRoot, 'package.json'), '{ "name": "fixture" }\n');
  if (exarchosYml !== undefined) {
    writeFileSync(path.join(repoRoot, '.exarchos.yml'), exarchosYml);
  }
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base', '-q']);
  git(repoRoot, ['checkout', '-b', 'feature/work', '-q']);
  writeFileSync(path.join(repoRoot, 'impl.ts'), 'export const x = 1;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'feat: impl without test', '-q']);
}

describe('check_tdd_compliance dispatch-path config resolution (FIX-2)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
  });

  async function dispatch(repoRoot: string) {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'tddc-dispatch-state-'));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const ctx = { stateDir, eventStore, enableTelemetry: false } as DispatchContext;
    return handleOrchestrate(
      {
        action: 'check_tdd_compliance',
        featureId: 'feat-tddc',
        taskId: 'T-tddc',
        branch: 'feature/work',
        baseBranch: 'main',
        repoRoot,
      },
      ctx,
    );
  }

  it(
    'CheckTddCompliance_DispatchPath_ProjectBlockingOverride_ReBlocks',
    async () => {
      const repoRoot = initRepo('tddc-blocking-');
      cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
      writeTaskBranch(
        repoRoot,
        ['review:', '  gates:', '    tdd-compliance:', '      blocking: true', ''].join('\n'),
      );

      const result = await dispatch(repoRoot);
      expect(result.success).toBe(true);
      const data = result.data as { severity?: string };
      // The project override must reach the handler THROUGH dispatch — before
      // FIX-2 the 4th positional config param was unreachable and this stayed
      // the advisory default.
      expect(data.severity).toBe('blocking');
    },
    60_000,
  );

  it(
    'CheckTddCompliance_DispatchPath_NoOverride_AdvisoryDefault',
    async () => {
      const repoRoot = initRepo('tddc-advisory-');
      cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
      writeTaskBranch(repoRoot); // no .exarchos.yml

      const result = await dispatch(repoRoot);
      expect(result.success).toBe(true);
      const data = result.data as { severity?: string };
      expect(data.severity).toBe('warning');
    },
    60_000,
  );
});
