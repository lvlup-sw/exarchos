import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  parseKnipOutput,
  loadAllowlist,
  readExclusionTags,
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

/** A healthy inverted reading: the `@proof` rule still matches one real symbol. */
const oneProofIssue = knipReport([
  { file: 'src/contract/declaration.ts', types: [{ name: '_ProofAlias_FailsCompile', line: 42 }] },
]);
/** knip resolved nothing (or the tag matches nothing) — the vacuous case. */
const emptyReport = knipReport([]);

function captureDeps(overrides: {
  run: KnipRun;
  allowlist: unknown;
  now?: Date;
  /** Defaults to the shipped policy shape: one exclusion tag, `-proof`. */
  knipConfig?: unknown;
  /** Defaults to a NON-vacuous denominator so unrelated cases stay isolated. */
  tagCensus?: KnipRun | ((tagName: string) => KnipRun);
}): { deps: KnipDiffDeps; out: string[]; err: string[]; censusCalls: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const censusCalls: string[] = [];
  const census = overrides.tagCensus ?? foundRun(oneProofIssue);
  const deps: KnipDiffDeps = {
    runKnip: () => overrides.run,
    runTagCensus: (tagName) => {
      censusCalls.push(tagName);
      return typeof census === 'function' ? census(tagName) : census;
    },
    readKnipConfig: () => overrides.knipConfig ?? { tags: ['-proof'] },
    readAllowlist: () => overrides.allowlist,
    now: overrides.now ?? new Date('2026-07-16T12:00:00.000Z'),
    log: (m) => out.push(m),
    errlog: (m) => err.push(m),
  };
  return { deps, out, err, censusCalls };
}

function foundRun(stdout: string, code = 1): KnipRun {
  return { found: true, code, stdout, stderr: '', binPath: '/repo/node_modules/.bin/knip' };
}

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

describe('readExclusionTags — mirrors knip\'s own tag normalisation', () => {
  // These cases pin knip's `splitTags` rule (node_modules/knip/dist/util/tag.js):
  // split each entry on `,`, take the FIRST [a-zA-Z]+ run, prefix `@`; only a
  // leading `-` makes it an EXCLUSION. If the gate normalised differently it
  // would take its denominator against a tag knip never applied.
  it('reads a leading-dash entry as the exclusion tag knip will match', () => {
    expect(readExclusionTags({ tags: ['-proof'] })).toEqual([{ name: 'proof', jsDocTag: '@proof' }]);
  });

  it('truncates at the first non-alphabetic character, exactly as knip does', () => {
    // knip resolves `-proof-alias` to `@proof`, NOT `@proof-alias`.
    expect(readExclusionTags({ tags: ['-proof-alias'] })).toEqual([
      { name: 'proof', jsDocTag: '@proof' },
    ]);
  });

  it('splits a comma-joined entry the way knip does', () => {
    expect(readExclusionTags({ tags: ['-proof,-legacy'] }).map((t) => t.jsDocTag)).toEqual([
      '@proof',
      '@legacy',
    ]);
  });

  it('does NOT treat an include filter (`+tag` / bare) as an exemption', () => {
    // `+tag` NARROWS what knip reports; it exempts nothing, so it carries no
    // denominator obligation and must not be mistaken for one.
    expect(readExclusionTags({ tags: ['+proof', 'internal'] })).toEqual([]);
  });

  it('returns nothing when knip.json declares no tags at all', () => {
    expect(readExclusionTags({})).toEqual([]);
    expect(readExclusionTags({ tags: [] })).toEqual([]);
    expect(readExclusionTags(null)).toEqual([]);
  });

  it('the SHIPPED knip.json declares the proof-alias exemption', () => {
    const config = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../knip.json', import.meta.url)), 'utf8'),
    );
    expect(readExclusionTags(config).map((t) => t.jsDocTag)).toContain('@proof');
  });
});

describe('runKnipDiff — the exemption denominator (DR-24)', () => {
  it('FAILS CLOSED (exit 2) when the exclusion tag matches ZERO symbols', () => {
    // The vacuous-gate failure this probe exists to prevent: `@proof` is still
    // declared but nothing carries it any more, so the sweep is exempting
    // nothing and its clean result means nothing.
    const { deps, err } = captureDeps({
      run: foundRun(knipReport([])),
      allowlist: [],
      tagCensus: foundRun(emptyReport, 0),
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/vacuous-exemption/);
    expect(err.join('\n')).toMatch(/@proof/);
  });

  it('FAILS CLOSED (exit 2) when knip resolves zero files, instead of reporting clean', () => {
    // Same probe, different cause. A knip whose `project` globs match nothing
    // emits an empty report for BOTH readings. Without the denominator the gate
    // would print "0 findings, OK" — the strongest form of a silently dead gate.
    const { deps, err, out } = captureDeps({
      run: foundRun(emptyReport, 0),
      allowlist: [],
      tagCensus: foundRun(emptyReport, 0),
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(out.join('\n')).not.toMatch(/OK/);
    expect(err.join('\n')).toMatch(/vacuous-exemption/);
  });

  it('FAILS CLOSED (exit 2) when knip.json declares no exclusion tag to measure', () => {
    const { deps, err } = captureDeps({
      run: foundRun(knipReport([])),
      allowlist: [],
      knipConfig: { ignoreExportsUsedInFile: true },
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/no-denominator/);
  });

  it('FAILS CLOSED (exit 2) when the denominator reading itself cannot run', () => {
    const { deps, err } = captureDeps({
      run: foundRun(knipReport([])),
      allowlist: [],
      tagCensus: { found: false, code: -1, stdout: '', stderr: 'ENOENT', binPath: '/nope/knip' },
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/tool-missing/);
    expect(err.join('\n')).toMatch(/denominator/);
  });

  it('FAILS CLOSED (exit 2) when the denominator reading emits garbage', () => {
    const { deps, err } = captureDeps({
      run: foundRun(knipReport([])),
      allowlist: [],
      tagCensus: foundRun('knip exploded <<<', 2),
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/unparseable-output/);
    expect(err.join('\n')).toMatch(/denominator/);
  });

  it('takes the reading with the filter INVERTED, once per declared tag', () => {
    const { deps, censusCalls } = captureDeps({
      run: foundRun(knipReport([])),
      allowlist: [],
      knipConfig: { tags: ['-proof', '-legacy'] },
    });
    expect(runKnipDiff(deps)).toBe(EXIT_OK);
    expect(censusCalls).toEqual(['proof', 'legacy']);
  });

  it('publishes the measured denominator on the GREEN path so it can be falsified', () => {
    const { deps, out } = captureDeps({ run: foundRun(knipReport([])), allowlist: [] });
    expect(runKnipDiff(deps)).toBe(EXIT_OK);
    expect(out.join('\n')).toMatch(/denominator: `@proof` exempts 1 unreferenced/);
  });

  it('counts only exports and types — a `file` finding is not a tagged symbol', () => {
    // knip's tag filter never applies to whole-file findings. Counting one would
    // let an unrelated dead FILE stand in as evidence that the tag rule is live.
    const { deps, err } = captureDeps({
      run: foundRun(knipReport([])),
      allowlist: [],
      tagCensus: foundRun(knipReport([{ file: 'src/dead.ts', files: [{ name: 'src/dead.ts' }] }]), 1),
    });
    expect(runKnipDiff(deps)).toBe(EXIT_GATE_ERROR);
    expect(err.join('\n')).toMatch(/vacuous-exemption/);
  });
});

describe('runKnipDiff — the exemption is bounded (kill probe)', () => {
  it('a dead export that does NOT carry the convention still FAILS the sweep', () => {
    // THE load-bearing property. The `@proof` rule must exempt the proof idiom
    // specifically, never "any unreferenced exported symbol". A live denominator
    // does not buy silence for anything outside it.
    const { deps, err } = captureDeps({ run: foundRun(oneExportIssue), allowlist: [] });
    expect(runKnipDiff(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/unallowlisted/);
    expect(err.join('\n')).toMatch(/deadFn/);
  });

  it('teaches the `@proof` convention in the failure an author actually reads', () => {
    // The convention has to be discoverable from the guard's own output — a
    // comment beside the aliases is not reachable from a red CI log.
    const { deps, err } = captureDeps({ run: foundRun(oneExportIssue), allowlist: [] });
    expect(runKnipDiff(deps)).toBe(EXIT_VIOLATIONS);
    const report = err.join('\n');
    expect(report).toMatch(/COMPILE-TIME PROOF/);
    expect(report).toMatch(/@proof/);
    expect(report).toMatch(/tsconfig\.json` excludes/);
  });

  it('names the tag from knip.json rather than a copy hard-coded in the guard', () => {
    const { deps, err } = captureDeps({
      run: foundRun(oneExportIssue),
      allowlist: [],
      knipConfig: { tags: ['-invariant'] },
    });
    expect(runKnipDiff(deps)).toBe(EXIT_VIOLATIONS);
    expect(err.join('\n')).toMatch(/@invariant/);
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
