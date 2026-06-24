import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  extractCliSurface,
  findVocabViolations,
  findLiveCliViolations,
  type CliSurface,
} from './cli-vocab-guard.js';

// ─── Synthetic-surface helpers ────────────────────────────────────────────────
//
// The guard's detection logic is pure over a `CliSurface`. We drive it directly
// with planted surfaces so the FAIL path is exercised without mutating the real
// registry, and we also build a small Commander program to prove `extractCliSurface`
// walks names, aliases, and flags the way `buildCli` produces them.

function surface(
  verbs: { path: string; token: string }[],
  flags: { path: string; token: string }[] = [],
): CliSurface {
  return { verbs, flags };
}

describe('cli-vocab-guard: findVocabViolations (FAIL path)', () => {
  it('flags a banned verb alias (`info`) with its canonical replacement', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf info', token: 'info' }]),
      new Set(), // no exceptions — prove the ban bites
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'verb',
      token: 'info',
      path: 'exarchos wf info',
      canonical: 'get',
    });
  });

  it('flags a banned verb alias (`ls`) when not excepted', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos something ls', token: 'ls' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.token).toBe('ls');
    expect(violations[0]?.canonical).toBe('list');
  });

  it('flags a banned destructive verb alias (`rm`)', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf rm', token: 'rm' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('verb');
    expect(violations[0]?.token).toBe('rm');
  });

  it('flags a banned flag alias (`--format` as a JSON carrier) when not excepted', () => {
    const violations = findVocabViolations(
      surface([], [{ path: 'exarchos wf get --format', token: '--format' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'flag',
      token: '--format',
      canonical: '--json',
    });
  });

  it('flags a banned confirmation-bypass flag (`--skip-confirmations`)', () => {
    const violations = findVocabViolations(
      surface([], [{ path: 'exarchos wf cancel --skip-confirmations', token: '--skip-confirmations' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.canonical).toBe('--force');
  });

  it('reports every violation when several banned tokens are present', () => {
    const violations = findVocabViolations(
      surface(
        [
          { path: 'exarchos wf info', token: 'info' },
          { path: 'exarchos vw ls', token: 'ls' },
        ],
        [{ path: 'exarchos doctor --format', token: '--format' }],
      ),
      new Set(),
    );
    expect(violations).toHaveLength(3);
  });
});

describe('cli-vocab-guard: findVocabViolations (PASS path)', () => {
  it('passes a surface using only canonical vocabulary', () => {
    const violations = findVocabViolations(
      surface(
        [
          { path: 'exarchos wf get', token: 'get' },
          { path: 'exarchos vw list', token: 'list' },
          { path: 'exarchos wf list_prs', token: 'list_prs' },
        ],
        [
          { path: 'exarchos wf get --json', token: '--json' },
          { path: 'exarchos wf cancel --force', token: '--force' },
          // `--skip-tests` is a build-step skip, NOT a confirmation bypass — must not trip.
          { path: 'exarchos orch create_pr --skip-tests', token: '--skip-tests' },
        ],
      ),
      new Set(),
    );
    expect(violations).toEqual([]);
  });

  it('honors KNOWN_EXCEPTIONS keyed by exact command path + token', () => {
    const exceptions = new Set(['exarchos vw ls::ls']);
    const violations = findVocabViolations(
      surface([{ path: 'exarchos vw ls', token: 'ls' }]),
      exceptions,
    );
    expect(violations).toEqual([]);
  });

  it('exception is surgical: same banned token on a DIFFERENT path still fails', () => {
    const exceptions = new Set(['exarchos vw ls::ls']);
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf ls', token: 'ls' }]),
      exceptions,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('exarchos wf ls');
  });
});

describe('cli-vocab-guard: extractCliSurface', () => {
  it('walks command names, aliases, and long flags (skipping the program root)', () => {
    const program = new Command('exarchos');
    const wf = program.command('workflow').alias('wf');
    wf.command('get').option('--json', 'Output raw JSON').option('--feature-id <value>', 'id');
    const view = program.command('view').alias('vw');
    view.command('pipeline').alias('ls');

    const { verbs, flags } = extractCliSurface(program);
    const verbTokens = verbs.map((v) => v.token);

    // Program root `exarchos` is not a verb.
    expect(verbTokens).not.toContain('exarchos');
    // Names and aliases both appear.
    expect(verbTokens).toEqual(expect.arrayContaining(['workflow', 'wf', 'get', 'view', 'vw', 'pipeline', 'ls']));
    // Flags carry their declaring command path.
    expect(flags).toEqual(
      expect.arrayContaining([
        { path: 'exarchos workflow get', token: '--json' },
        { path: 'exarchos workflow get', token: '--feature-id' },
      ]),
    );
  });
});

describe('cli-vocab-guard: live CLI surface', () => {
  // This is the contract the guard protects: the real rendered surface must use
  // canonical vocabulary (modulo tracked KNOWN_EXCEPTIONS). If anyone introduces
  // a NEW banned verb/flag, this assertion goes red — which is exactly the
  // regression `cli:vocab-guard` exists to catch in CI.
  it('the current rendered CLI surface has no un-excepted vocabulary violations', () => {
    const violations = findLiveCliViolations();
    expect(violations).toEqual([]);
  });
});
