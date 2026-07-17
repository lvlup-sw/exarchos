import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  parseKnipOutput,
  loadAllowlist,
  diffAgainstAllowlist,
  runKnipDiff,
  KnipParseError,
  EXIT_OK,
  EXIT_VIOLATIONS,
  EXIT_GATE_ERROR,
  type KnipRun,
  type KnipDiffDeps,
  type AllowlistEntry,
} from './knip-diff.js';

const knipReport = (issues: unknown[]): string => JSON.stringify({ issues });
const oneExportIssue = knipReport([
  { file: 'src/foo.ts', exports: [{ name: 'deadFn', line: 10 }], types: [], files: [], dependencies: [], devDependencies: [] },
]);

function captureDeps(overrides: {
  run: KnipRun;
  allowlist: unknown;
  now?: Date;
}): { deps: KnipDiffDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: KnipDiffDeps = {
    runKnip: () => overrides.run,
    readAllowlist: () => overrides.allowlist,
    now: overrides.now ?? new Date('2026-07-16T12:00:00.000Z'),
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
  };
  return { deps, out, err };
}

const foundRun = (stdout: string, code = 1): KnipRun => ({
  found: true,
  code,
  stdout,
  stderr: '',
  binPath: '/repo/node_modules/.bin/knip',
});

describe('parseKnipOutput', () => {
  it('flattens exports and types into violations with file + line', () => {
    const v = parseKnipOutput(
      knipReport([
        { file: 'src/a.ts', exports: [{ name: 'x', line: 3 }], types: [{ name: 'T', line: 5 }] },
      ]),
    );
    expect(v).toEqual([
      { kind: 'export', symbol: 'x', file: 'src/a.ts', line: 3 },
      { kind: 'type', symbol: 'T', file: 'src/a.ts', line: 5 },
    ]);
  });

  it('emits a file-kind violation when knip flags a whole file', () => {
    const v = parseKnipOutput(knipReport([{ file: 'src/dead.ts', files: [{ name: 'src/dead.ts' }] }]));
    expect(v).toEqual([{ kind: 'file', symbol: 'src/dead.ts', file: 'src/dead.ts' }]);
  });

  it('throws KnipParseError on empty output (fail-closed, not "clean")', () => {
    expect(() => parseKnipOutput('   ')).toThrow(KnipParseError);
  });

  it('throws KnipParseError on non-JSON output', () => {
    expect(() => parseKnipOutput('knip crashed: cannot find config <<<')).toThrow(KnipParseError);
  });

  it('throws KnipParseError when the top-level issues[] array is missing', () => {
    expect(() => parseKnipOutput(JSON.stringify({ notIssues: [] }))).toThrow(/issues\[\]/);
  });

  it('throws KnipParseError when a finding is missing its name', () => {
    expect(() => parseKnipOutput(knipReport([{ file: 'src/a.ts', exports: [{ line: 3 }] }]))).toThrow(
      KnipParseError,
    );
  });
});

describe('loadAllowlist', () => {
  it('returns typed entries for a valid allowlist', () => {
    const entries = loadAllowlist([
      { symbol: 'deadFn', file: 'src/foo.ts', owner: '@x', expires: '2099-01-01', rationale: 'r' },
    ]);
    expect(entries).toHaveLength(1);
  });

  it('throws when an entry violates the shared schema', () => {
    expect(() => loadAllowlist([{ symbol: 'x', file: 'src/foo.ts' }])).toThrow(/schema validation/);
  });

  it('the SHIPPED knip-allowlist.json conforms to the schema', () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL('./knip-allowlist.json', import.meta.url)), 'utf8'),
    );
    const entries = loadAllowlist(raw);
    expect(entries.length).toBeGreaterThan(0);
    // every entry carries the accountability contract
    for (const e of entries) {
      expect(e.owner.length).toBeGreaterThan(0);
      expect(e.rationale.length).toBeGreaterThan(0);
      expect(e.expires !== undefined || e.permanent === true).toBe(true);
    }
  });
});

describe('diffAgainstAllowlist', () => {
  const now = new Date('2026-07-16T12:00:00.000Z');
  const violation = { kind: 'export' as const, symbol: 'deadFn', file: 'src/foo.ts', line: 10 };

  it('reports an unallowlisted violation', () => {
    const r = diffAgainstAllowlist([violation], [], now);
    expect(r.unallowlisted).toEqual([violation]);
    expect(r.expired).toHaveLength(0);
  });

  it('matches an allowlisted, unexpired violation (nothing to report)', () => {
    const entry: AllowlistEntry = { symbol: 'deadFn', file: 'src/foo.ts', owner: '@x', expires: '2099-01-01', rationale: 'r' };
    const r = diffAgainstAllowlist([violation], [entry], now);
    expect(r.unallowlisted).toHaveLength(0);
    expect(r.expired).toHaveLength(0);
    expect(r.stale).toHaveLength(0);
  });

  it('reports an expired allowlist entry', () => {
    const entry: AllowlistEntry = { symbol: 'deadFn', file: 'src/foo.ts', owner: '@x', expires: '2000-01-01', rationale: 'r' };
    const r = diffAgainstAllowlist([violation], [entry], now);
    expect(r.expired).toEqual([entry]);
  });

  it('reports a stale (no-longer-flagged) allowlist entry', () => {
    const entry: AllowlistEntry = { symbol: 'goneFn', file: 'src/foo.ts', owner: '@x', permanent: true, rationale: 'r' };
    const r = diffAgainstAllowlist([], [entry], now);
    expect(r.stale).toEqual([entry]);
  });
});

describe('runKnipDiff — fail-closed gate (DR-8)', () => {
  it('FAILS CLOSED (exit 2) with a tool-missing diagnostic when the knip binary is absent', () => {
    const { deps, err } = captureDeps({
      run: { found: false, code: -1, stdout: '', stderr: 'ENOENT', binPath: '/repo/node_modules/.bin/knip' },
      allowlist: [],
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/tool-missing/);
    expect(err.join('\n')).toMatch(/knip binary not found/);
  });

  it('FAILS CLOSED (exit 2) with an unparseable-output diagnostic when knip emits garbage', () => {
    const { deps, err } = captureDeps({
      run: foundRun('knip exploded: not json <<<', 2),
      allowlist: [],
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/unparseable-output/);
  });

  it('FAILS CLOSED (exit 2) when the allowlist file itself is malformed', () => {
    const { deps, err } = captureDeps({
      run: foundRun(oneExportIssue),
      allowlist: [{ symbol: 'deadFn', file: 'src/foo.ts' }], // missing owner/expiry/rationale
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/bad-allowlist/);
  });
});

describe('runKnipDiff — dead-code findings', () => {
  it('passes (exit 0) when every knip finding is allowlisted and unexpired', () => {
    const { deps, out } = captureDeps({
      run: foundRun(oneExportIssue),
      allowlist: [{ symbol: 'deadFn', file: 'src/foo.ts', owner: '@x', expires: '2099-01-01', rationale: 'r' }],
    });
    expect(runKnipDiff(deps)).toBe(EXIT_OK);
    expect(out.join('\n')).toMatch(/OK/);
  });

  it('FAILS (exit 1) naming the unallowlisted symbol', () => {
    const { deps, err } = captureDeps({ run: foundRun(oneExportIssue), allowlist: [] });
    expect(runKnipDiff(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/unallowlisted/);
    expect(err.join('\n')).toMatch(/deadFn/);
  });

  it('FAILS (exit 1) naming an expired allowlist entry', () => {
    const { deps, err } = captureDeps({
      run: foundRun(oneExportIssue),
      allowlist: [{ symbol: 'deadFn', file: 'src/foo.ts', owner: '@x', expires: '2000-01-01', rationale: 'r' }],
    });
    expect(runKnipDiff(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/expired/);
    expect(err.join('\n')).toMatch(/deadFn/);
  });
});
