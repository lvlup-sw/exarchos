import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  run,
  deriveTouchedPairIds,
  EXIT_OK,
  EXIT_FINDING,
  EXIT_USAGE,
} from '../../../tools/audit/manifest-gate-ci.mjs';
import { spawnAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const SRC = 'src';

describe('deriveTouchedPairIds', () => {
  /**
   * The input holds a legacy copy, a canonical copy and a relocated sibling.
   * The function ignores the last three paths: a file that is not a test, a
   * test with no area directory, and an unrelated file.
   */
  it('maps legacy, canonical, and relocated-sibling paths to the same (area, base) pair', () => {
    expect(
      deriveTouchedPairIds(
        [
          `${SRC}/__tests__/workflow/guards.test.ts`,
          `${SRC}/workflow/state-store.test.ts`,
          `${SRC}/workflow/compensation.legacy.test.ts`,
          `${SRC}/workflow/guards.ts`,
          `${SRC}/foo.test.ts`,
          'README.md',
        ],
        SRC,
      ),
    ).toEqual(['workflow/compensation', 'workflow/guards', 'workflow/state-store']);
  });

  it('keys on (area, basename): same basename in two areas → two distinct pairs', () => {
    expect(
      deriveTouchedPairIds(
        [`${SRC}/__tests__/workflow/schemas.test.ts`, `${SRC}/event-store/schemas.test.ts`],
        SRC,
      ),
    ).toEqual(['event-store/schemas', 'workflow/schemas']);
  });
});

/**
 * Each case runs the gate against a temp git repository, not the live tree.
 * `LEGACY_MERGE` and `CANON_MERGE` have identical preambles modulo the import
 * path, so the pair is a valid merge target. `rawGit` is the git runner of the
 * two fail-closed cases. It is synchronous, because `run` takes a synchronous
 * runner. The gate must not accept an unexpected git error as an absent case
 * or as "no pair touched".
 */
describe('manifest-gate-ci (temp-git fixtures)', () => {
  let dir: string;

  const git = async (...args: string[]) => {
    const res = await spawnAsync('git', args, { cwd: dir });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
    }
    return res.stdout.trim();
  };

  const write = (rel: string, content: string) => {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const del = (rel: string) => rmSync(path.join(dir, rel), { force: true });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'manifest-gate-'));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'gate@test');
    await git('config', 'user.name', 'gate');
    await git('config', 'commit.gpgsign', 'false');
  });
  afterEach(() => rmrf(dir));

  const runGate = (base: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = run({
      base,
      head: 'HEAD',
      repoRoot: dir,
      srcRootRel: SRC,
      log: (m) => out.push(m),
      errlog: (m) => err.push(m),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  const LEGACY_MERGE = `import { describe, it, expect } from 'vitest';
import { guards } from '../../workflow/guards.js';
describe('guards', () => {
  it('shared_case', () => { expect(guards()).toBe(1); });
  it('legacy_only', () => { expect(guards()).toBe(3); });
});
`;
  const CANON_MERGE = `import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
describe('guards', () => {
  it('shared_case', () => { expect(guards()).toBe(1); });
  it('canonical_only', () => { expect(guards()).toBe(2); });
});
`;

  const seedMergeBase = async () => {
    write(`${SRC}/__tests__/workflow/guards.test.ts`, LEGACY_MERGE);
    write(`${SRC}/workflow/guards.test.ts`, CANON_MERGE);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base: legacy + canonical guards pair');
    const baseSha = await git('rev-parse', 'HEAD');
    await git('checkout', '-q', '-b', 'pr');
    return baseSha;
  };

  /** The canonical copy gains `legacy_only`, and the commit removes the legacy copy. */
  it('clean merge (every pre-image case carried into the canonical) → PASSES', async () => {
    const base = await seedMergeBase();
    write(
      `${SRC}/workflow/guards.test.ts`,
      `import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
describe('guards', () => {
  it('shared_case', () => { expect(guards()).toBe(1); });
  it('canonical_only', () => { expect(guards()).toBe(2); });
  it('legacy_only', () => { expect(guards()).toBe(3); });
});
`,
    );
    del(`${SRC}/__tests__/workflow/guards.test.ts`);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'consolidate workflow/guards (merge)');

    const { code, out } = runGate(base);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('workflow/guards: OK');
  });

  /** The merge result omits `legacy_only`. */
  it('dropping a LEGACY case (no surviving twin) → FAILS', async () => {
    const base = await seedMergeBase();
    write(
      `${SRC}/workflow/guards.test.ts`,
      `import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
describe('guards', () => {
  it('shared_case', () => { expect(guards()).toBe(1); });
  it('canonical_only', () => { expect(guards()).toBe(2); });
});
`,
    );
    del(`${SRC}/__tests__/workflow/guards.test.ts`);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'consolidate workflow/guards (drops legacy_only)');

    const { code, err } = runGate(base);
    expect(code).toBe(EXIT_FINDING);
    expect(err).toContain('legacy_only');
    expect(err).toMatch(/\(legacy\)/);
  });

  /** The merge result omits `canonical_only`. The gate must catch a loss on the canonical side also. */
  it('dropping a pre-existing CANONICAL case → FAILS (bidirectional)', async () => {
    const base = await seedMergeBase();
    write(
      `${SRC}/workflow/guards.test.ts`,
      `import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
describe('guards', () => {
  it('shared_case', () => { expect(guards()).toBe(1); });
  it('legacy_only', () => { expect(guards()).toBe(3); });
});
`,
    );
    del(`${SRC}/__tests__/workflow/guards.test.ts`);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'consolidate workflow/guards (drops canonical_only)');

    const { code, err } = runGate(base);
    expect(code).toBe(EXIT_FINDING);
    expect(err).toContain('canonical_only');
    expect(err).toMatch(/\(canonical\)/);
  });

  /**
   * The legacy copy at the base has an extra `vi.mock`, so the pair is a
   * relocate target. The commit moves the legacy content to
   * `guards.legacy.test.ts` with rewritten imports and removes the legacy copy.
   * It does not change the canonical copy.
   */
  it('clean relocate (legacy moved to a rewritten sibling) → PASSES', async () => {
    const legacyDivergent = `import { describe, it, expect, vi } from 'vitest';
import { guards } from '../../workflow/guards.js';
vi.mock('../../workflow/guards.js', () => ({ guards: () => 9 }));
describe('guards', () => {
  it('legacy_mock_case', () => { expect(guards()).toBe(9); });
});
`;
    write(`${SRC}/__tests__/workflow/guards.test.ts`, legacyDivergent);
    write(`${SRC}/workflow/guards.test.ts`, CANON_MERGE);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base: divergent legacy + canonical');
    const base = await git('rev-parse', 'HEAD');
    await git('checkout', '-q', '-b', 'pr');

    write(
      `${SRC}/workflow/guards.legacy.test.ts`,
      `import { describe, it, expect, vi } from 'vitest';
import { guards } from './guards.js';
vi.mock('./guards.js', () => ({ guards: () => 9 }));
describe('guards', () => {
  it('legacy_mock_case', () => { expect(guards()).toBe(9); });
});
`,
    );
    del(`${SRC}/__tests__/workflow/guards.test.ts`);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'consolidate workflow/guards (relocate)');

    const { code, out } = runGate(base);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('workflow/guards: OK');
  });

  it('a PR touching no consolidation pair → PASSES trivially', async () => {
    const base = await seedMergeBase();
    write(`${SRC}/workflow/unrelated.ts`, 'export const x = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'unrelated change');

    const { code, out } = runGate(base);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('no consolidation pair touched');
  });

  /**
   * The base holds only a co-located file, so no pair exists. The commit
   * removes a case from that file, and the gate must not fail.
   */
  it('a lone co-located test with NO legacy twin is SKIPPED (not false-blocked)', async () => {
    write(`${SRC}/workflow/solo.test.ts`, CANON_MERGE);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base: solo co-located test (no legacy twin)');
    const base = await git('rev-parse', 'HEAD');
    await git('checkout', '-q', '-b', 'pr');
    write(
      `${SRC}/workflow/solo.test.ts`,
      `import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
describe('guards', () => {
  it('shared_case', () => { expect(guards()).toBe(1); });
});
`,
    );
    await git('add', '-A');
    await git('commit', '-q', '-m', 'edit solo test (drops a case, but it is not a pair)');

    const { code } = runGate(base);
    expect(code).toBe(EXIT_OK);
  });

  it('returns a usage exit code when the merge-base cannot be resolved', async () => {
    await seedMergeBase();
    const { code, err } = runGate('does-not-exist-ref');
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('merge-base');
  });

  const rawGit = (args: string[], cwd: string) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };

  it('fails CLOSED when `git diff` errors — not silently treated as an empty diff', async () => {
    const base = await seedMergeBase();
    const failingDiff = (args: string[], cwd: string) =>
      args[0] === 'diff'
        ? { status: 128, stdout: '', stderr: 'fatal: bad revision (simulated transient failure)' }
        : rawGit(args, cwd);
    const out: string[] = [];
    const err: string[] = [];
    const code = run({
      base, head: 'HEAD', repoRoot: dir, srcRootRel: SRC,
      git: failingDiff, log: (m) => out.push(m), errlog: (m) => err.push(m),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toMatch(/fail-closed/);
    expect(out.join('\n')).not.toContain('no consolidation pair touched');
  });

  /** The commit touches a pair, so the gate calls `git show`. */
  it('fails CLOSED when `git show` errors for a reason other than an absent path', async () => {
    const base = await seedMergeBase();
    write(`${SRC}/workflow/guards.test.ts`, CANON_MERGE);
    del(`${SRC}/__tests__/workflow/guards.test.ts`);
    await git('add', '-A');
    await git('commit', '-q', '-m', 'touch guards pair');
    const failingShow = (args: string[], cwd: string) =>
      args[0] === 'show'
        ? { status: 128, stdout: '', stderr: 'fatal: unable to read tree object (simulated corruption)' }
        : rawGit(args, cwd);
    const out: string[] = [];
    const err: string[] = [];
    const code = run({
      base, head: 'HEAD', repoRoot: dir, srcRootRel: SRC,
      git: failingShow, log: (m) => out.push(m), errlog: (m) => err.push(m),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(err.join('\n')).toMatch(/fail-closed/);
  });
});
