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
} from './manifest-gate-ci.mjs';

const SRC = 'servers/exarchos-mcp/src';

// ── pure pair-derivation (no git) ────────────────────────────────────────────
describe('deriveTouchedPairIds', () => {
  it('maps legacy, canonical, and relocated-sibling paths to the same (area, base) pair', () => {
    expect(
      deriveTouchedPairIds(
        [
          `${SRC}/__tests__/workflow/guards.test.ts`, // legacy copy
          `${SRC}/workflow/state-store.test.ts`, // canonical copy
          `${SRC}/workflow/compensation.legacy.test.ts`, // relocated sibling
          `${SRC}/workflow/guards.ts`, // not a .test.ts — ignored
          `${SRC}/foo.test.ts`, // bare (no area subdir) — ignored
          'README.md', // unrelated — ignored
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

// ── the gate against a real temp git repo (fixture-based, NOT the live tree) ──
describe('manifest-gate-ci (temp-git fixtures)', () => {
  let dir: string;

  const git = (...args: string[]) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
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

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'manifest-gate-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'gate@test');
    git('config', 'user.name', 'gate');
    git('config', 'commit.gpgsign', 'false');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  // Base state for the merge scenarios: legacy + canonical with IDENTICAL
  // preambles (modulo import path), so the pair is a legitimate merge target.
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

  const seedMergeBase = () => {
    write(`${SRC}/__tests__/workflow/guards.test.ts`, LEGACY_MERGE);
    write(`${SRC}/workflow/guards.test.ts`, CANON_MERGE);
    git('add', '-A');
    git('commit', '-q', '-m', 'base: legacy + canonical guards pair');
    const baseSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'pr');
    return baseSha;
  };

  it('clean merge (every pre-image case carried into the canonical) → PASSES', () => {
    const base = seedMergeBase();
    // Merge: canonical gains legacy_only; legacy copy removed.
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
    git('add', '-A');
    git('commit', '-q', '-m', 'consolidate workflow/guards (merge)');

    const { code, out } = runGate(base);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('workflow/guards: OK');
  });

  it('dropping a LEGACY case (no surviving twin) → FAILS', () => {
    const base = seedMergeBase();
    // legacy_only is silently dropped from the merge result.
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
    git('add', '-A');
    git('commit', '-q', '-m', 'consolidate workflow/guards (drops legacy_only)');

    const { code, err } = runGate(base);
    expect(code).toBe(EXIT_FINDING);
    expect(err).toContain('legacy_only');
    expect(err).toMatch(/\(legacy\)/);
  });

  it('dropping a pre-existing CANONICAL case → FAILS (bidirectional)', () => {
    const base = seedMergeBase();
    // canonical_only is dropped — the gate must catch loss on the canonical
    // side too, not only the legacy side.
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
    git('add', '-A');
    git('commit', '-q', '-m', 'consolidate workflow/guards (drops canonical_only)');

    const { code, err } = runGate(base);
    expect(code).toBe(EXIT_FINDING);
    expect(err).toContain('canonical_only');
    expect(err).toMatch(/\(canonical\)/);
  });

  it('clean relocate (legacy moved to a rewritten sibling) → PASSES', () => {
    // Base with a DIVERGENT legacy preamble (extra vi.mock) → relocate, not merge.
    const legacyDivergent = `import { describe, it, expect, vi } from 'vitest';
import { guards } from '../../workflow/guards.js';
vi.mock('../../workflow/guards.js', () => ({ guards: () => 9 }));
describe('guards', () => {
  it('legacy_mock_case', () => { expect(guards()).toBe(9); });
});
`;
    write(`${SRC}/__tests__/workflow/guards.test.ts`, legacyDivergent);
    write(`${SRC}/workflow/guards.test.ts`, CANON_MERGE);
    git('add', '-A');
    git('commit', '-q', '-m', 'base: divergent legacy + canonical');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'pr');

    // Relocate: legacy content moved to <base>.legacy.test.ts with imports
    // rewritten from ../../workflow/ to ./ ; legacy __tests__ copy removed;
    // canonical untouched.
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
    git('add', '-A');
    git('commit', '-q', '-m', 'consolidate workflow/guards (relocate)');

    const { code, out } = runGate(base);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('workflow/guards: OK');
  });

  it('a PR touching no consolidation pair → PASSES trivially', () => {
    const base = seedMergeBase();
    write(`${SRC}/workflow/unrelated.ts`, 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'unrelated change');

    const { code, out } = runGate(base);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('no consolidation pair touched');
  });

  it('a lone co-located test with NO legacy twin is SKIPPED (not false-blocked)', () => {
    // Only a canonical file at base — never a two-directory pair.
    write(`${SRC}/workflow/solo.test.ts`, CANON_MERGE);
    git('add', '-A');
    git('commit', '-q', '-m', 'base: solo co-located test (no legacy twin)');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'pr');
    // Legitimately delete a case from this non-pair file — must NOT fail the gate.
    write(
      `${SRC}/workflow/solo.test.ts`,
      `import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
describe('guards', () => {
  it('shared_case', () => { expect(guards()).toBe(1); });
});
`,
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'edit solo test (drops a case, but it is not a pair)');

    const { code } = runGate(base);
    expect(code).toBe(EXIT_OK);
  });

  it('returns a usage exit code when the merge-base cannot be resolved', () => {
    seedMergeBase();
    const { code, err } = runGate('does-not-exist-ref');
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('merge-base');
  });
});
