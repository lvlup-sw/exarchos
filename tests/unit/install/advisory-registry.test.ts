/**
 * Tests for the advisory registry and its ratchets. They pin four properties:
 *
 *   - Exhaustive discovery: a seeded `continue-on-error: true`, `--observe` or `|| true` that
 *     no registry entry claims must fail. The scan finds the softening itself, so it needs
 *     no marker.
 *   - Entry completeness: `validateAdvisoryGovernance` rejects a blank owner, threshold,
 *     expiry or kill fixture.
 *   - Path-filter model: the parsed trigger and the job and step `if:` gates decide whether a
 *     CI path is unfiltered. The shape of a filename does not.
 *   - Live tree: the ratchet passes on the real repository.
 *
 * `analyzeCiPathFilters` is zero-dependency ESM under `tools/`, outside the `tsc` rootDir of
 * `src/`. Thus this file composes the registry and that model.
 */
import { describe, it, expect } from 'vitest';
import { dirname, join, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADVISORY_REGISTRY,
  REGISTRY_LOCAL_KILL_PROBES,
  parseAdvisoryMarkers,
  discoverAdvisories,
  discoverSofteningSites,
  discoverWorkflowSoftening,
  scanCommandSoftening,
  principalTarget,
  resolveEnforcementRefs,
  validateAdvisoryGovernance,
  verifyAdvisoryRatchet,
  assertAdvisoryRatchet,
  AdvisoryRatchetError,
  ENFORCEMENT_PRIMARY_DIR,
  type AdvisoryEntry,
  type CiPathAnalysis,
  type DiscoveredAdvisory,
  type KillProbeResult,
  type SofteningDiscoveryFs,
  type SofteningSite,
} from '../../../src/install/advisory-registry.js';
import { runKillProbe } from '../../../src/install/advisory-kill-probes.js';
// @ts-expect-error — no .d.ts for this .mjs gate; its contract is asserted here.
import { analyzeCiPathFilters, isNonFilteringIf, audit } from '../../../tools/audit/gates/check-enforcer-wiring.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The path of a seeded enforcement primary. The scan recognizes primaries only under
 * `ENFORCEMENT_PRIMARY_DIR`. A fixture with a hard-coded prefix can drift from that value.
 * The scan then finds zero sites, and that empty result looks the same as a clean result.
 */
const primary = (name: string): string => `${ENFORCEMENT_PRIMARY_DIR}/${name}`;

/** A fixed clock before each expiry in the real registry, so no real entry is expired under it. */
const CLOCK = new Date('2026-01-01T00:00:00Z');

const FORK_GUARD =
  "github.event.pull_request.head.repo.full_name == github.repository || github.event_name != 'pull_request'";

/** Build a well-formed registry entry, overridable field-by-field. */
function entry(over: Partial<AdvisoryEntry> = {}): AdvisoryEntry {
  return {
    id: 'sample-advisory',
    file: 'scripts/sample-advisory.mjs',
    control: 'sample-control',
    owner: 'exarchos',
    promotionThreshold: 'measured evidence X over two release trains',
    removalThreshold: 'the checked seam is retired',
    issue: '#1590',
    expires: '2099-01-01',
    killFixture: 'sample-probe',
    ciPath: '.github/workflows/ci.yml',
    ciStepMatch: 'scripts/sample-advisory.mjs',
    ciPathFiltered: false,
    ciFilterRationale: '',
    softening: [
      {
        file: '.github/workflows/ci.yml',
        kind: 'continue-on-error',
        target: 'scripts/sample-advisory.mjs',
      },
    ],
    ...over,
  };
}

/** The softening site on disk that backs a given entry's first claim. */
function site(e: AdvisoryEntry, over: Partial<SofteningSite> = {}): SofteningSite {
  const ref = e.softening[0]!;
  return { ...ref, line: 42, evidence: 'seeded', ...over };
}

/** A discovered marker matching a given entry. */
function discovered(over: Partial<DiscoveredAdvisory> = {}): DiscoveredAdvisory {
  return {
    file: 'scripts/sample-advisory.mjs',
    control: 'sample-control',
    raw: 'control: sample-control',
    ...over,
  };
}

/** A HEALTHY probe result for a given entry (fires on violation, silent on clean). */
function probe(e: AdvisoryEntry, over: Partial<KillProbeResult> = {}): KillProbeResult {
  return {
    advisoryId: e.id,
    killFixture: e.killFixture,
    firedOnViolation: true,
    firedOnClean: false,
    ...over,
  };
}

/** An "unfiltered" CI-path analysis. */
function unfiltered(): CiPathAnalysis {
  return { event: 'pull_request', unfiltered: true, filters: [] };
}

/** A "filtered" CI-path analysis. */
function filtered(kind = 'paths'): CiPathAnalysis {
  return {
    event: 'pull_request',
    unfiltered: false,
    filters: [{ kind, detail: 'on.pull_request.paths narrows to [docs/**]' }],
  };
}

/**
 * Run the ratchet over a synthetic world. Defaults are CONSISTENT (every entry
 * has its site, its probe and an unfiltered analysis) so a test only has to
 * state the one thing it is breaking.
 */
function ratchet(input: {
  registry?: readonly AdvisoryEntry[];
  discovered?: readonly DiscoveredAdvisory[];
  probeResults?: readonly KillProbeResult[];
  softeningSites?: readonly SofteningSite[];
  ciPathAnalyses?: ReadonlyMap<string, CiPathAnalysis>;
  now?: Date;
}) {
  const registry = input.registry ?? [];
  return verifyAdvisoryRatchet({
    registry,
    discovered: input.discovered ?? [],
    probeResults: input.probeResults ?? registry.map((e) => probe(e)),
    softeningSites: input.softeningSites ?? registry.map((e) => site(e)),
    ciPathAnalyses:
      input.ciPathAnalyses ?? new Map(registry.map((e) => [e.id, unfiltered()] as const)),
    now: input.now ?? CLOCK,
  });
}

/** An in-memory tree for {@link discoverSofteningSites}. */
function memFs(files: Readonly<Record<string, string>>): SofteningDiscoveryFs {
  const abs = (rel: string): string => join(REPO_ROOT, ...rel.split('/'));
  const entries = Object.entries(files).map(([rel, text]) => [abs(rel), text] as const);
  return {
    exists: (p) => entries.some(([a]) => a === p),
    readFile: (p) => {
      const hit = entries.find(([a]) => a === p);
      if (!hit) throw new Error(`ENOENT: ${p}`);
      return hit[1];
    },
    listFiles: (root, extensions) =>
      entries
        .map(([a]) => a)
        .filter((a) => a.startsWith(root + sep) && extensions.some((e) => a.endsWith(e))),
  };
}

/** The package.json shape discovery needs. */
function pkg(scripts: Readonly<Record<string, string>>): string {
  return JSON.stringify({ name: 'exarchos', scripts }, null, 2);
}

/**
 * The type makes each mandated field required, and `validateAdvisoryGovernance` rejects a blank
 * value. The loop blanks one mandated field at a time, in the validator and then through the ratchet.
 */
describe('validateAdvisoryGovernance', () => {
  it('AdvisoryGovernance_CompleteEntry_NoProblems', () => {
    expect(validateAdvisoryGovernance(entry(), CLOCK)).toEqual([]);
  });

  const mandated: ReadonlyArray<keyof AdvisoryEntry> = [
    'owner',
    'promotionThreshold',
    'removalThreshold',
    'killFixture',
    'ciStepMatch',
  ];
  for (const field of mandated) {
    it(`AdvisoryGovernance_Missing_${field}_IsMalformed`, () => {
      const problems = validateAdvisoryGovernance(
        entry({ [field]: '   ' } as Partial<AdvisoryEntry>),
        CLOCK,
      );
      expect(problems.some((p) => p.kind === 'malformed' && p.detail.includes(field))).toBe(true);
    });

    it(`AdvisoryRatchet_Missing_${field}_Fails`, () => {
      const e = entry({ [field]: '' } as Partial<AdvisoryEntry>);
      const result = ratchet({ registry: [e] });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.kind === 'malformed')).toBe(true);
    });
  }

  it('AdvisoryGovernance_MissingExpiry_IsMalformed', () => {
    expect(
      validateAdvisoryGovernance(entry({ expires: '' }), CLOCK).some((p) => p.kind === 'malformed'),
    ).toBe(true);
  });

  /** A control with no softening site is blocking or dead. It is not an advisory. */
  it('AdvisoryGovernance_NoSofteningSite_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(entry({ softening: [] }), CLOCK);
    expect(problems.some((p) => p.kind === 'malformed' && p.detail.includes('softening'))).toBe(
      true,
    );
  });

  it('AdvisoryGovernance_SofteningRefMissingTarget_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(
      entry({
        softening: [{ file: '.github/workflows/ci.yml', kind: 'or-true', target: '  ' }],
      }),
      CLOCK,
    );
    expect(problems.some((p) => p.detail.includes('softening[0].target'))).toBe(true);
  });

  it('AdvisoryGovernance_SofteningRefUnknownKind_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(
      entry({
        softening: [
          {
            file: '.github/workflows/ci.yml',
            kind: 'set-plus-e' as never,
            target: 'scripts/x.mjs',
          },
        ],
      }),
      CLOCK,
    );
    expect(problems.some((p) => p.detail.includes('softening[0].kind'))).toBe(true);
  });

  it('AdvisoryGovernance_BadIssueRef_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(entry({ issue: 'PR-42' }), CLOCK);
    expect(problems.some((p) => p.kind === 'malformed' && p.detail.includes('issue'))).toBe(true);
  });

  it('AdvisoryGovernance_CiPathNotAWorkflow_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(entry({ ciPath: 'scripts/somewhere.sh' }), CLOCK);
    expect(problems.some((p) => p.kind === 'malformed' && p.detail.includes('ciPath'))).toBe(true);
  });

  it('AdvisoryGovernance_FilteredClaimWithoutRationale_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(
      entry({ ciPathFiltered: true, ciFilterRationale: '' }),
      CLOCK,
    );
    expect(problems.some((p) => p.detail.includes('ciFilterRationale'))).toBe(true);
  });

  /** The rule has two sides: a rationale on an unfiltered entry is stale text. */
  it('AdvisoryGovernance_UnfilteredClaimWithRationale_IsMalformed', () => {
    const problems = validateAdvisoryGovernance(
      entry({ ciPathFiltered: false, ciFilterRationale: 'left over from when it was filtered' }),
      CLOCK,
    );
    expect(problems.some((p) => p.detail.includes('ciFilterRationale'))).toBe(true);
  });

  it('AdvisoryGovernance_PastExpiry_IsExpired', () => {
    const problems = validateAdvisoryGovernance(entry({ expires: '2020-01-01' }), CLOCK);
    expect(problems.some((p) => p.kind === 'expired')).toBe(true);
  });

  it('AdvisoryGovernance_MalformedExpiry_IsMalformed', () => {
    expect(
      validateAdvisoryGovernance(entry({ expires: '2027-13-40' }), CLOCK).some(
        (p) => p.kind === 'malformed',
      ),
    ).toBe(true);
    expect(
      validateAdvisoryGovernance(entry({ expires: 'soon' }), CLOCK).some(
        (p) => p.kind === 'malformed',
      ),
    ).toBe(true);
  });

  it('AdvisoryGovernance_ExpiryOnTheDay_IsNotExpired', () => {
    const onDay = new Date('2099-01-01T23:59:59Z');
    expect(validateAdvisoryGovernance(entry({ expires: '2099-01-01' }), onDay)).toEqual([]);
  });
});

describe('discoverSofteningSites', () => {
  const CI_WITH_OBSERVE = [
    'name: CI',
    'on:',
    '  pull_request:',
    'jobs:',
    '  gate:',
    '    steps:',
    '      - name: Type debt (soak)',
    '        run: node tools/audit/gates/check-type-debt.mjs --observe',
    '',
  ].join('\n');

  const DOCS_WITH_CONTINUE_ON_ERROR = [
    'name: Docs',
    'on:',
    '  pull_request:',
    'jobs:',
    '  docs:',
    '    steps:',
    '      - name: Prose lint (advisory)',
    '        continue-on-error: true',
    '        run: node tools/audit/gates/check-prose-lint.mjs',
    '',
  ].join('\n');

  it('AdvisoryDiscovery_SeededContinueOnError_IsFound', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({
        'package.json': pkg({}),
        '.github/workflows/docs.yml': DOCS_WITH_CONTINUE_ON_ERROR,
      }),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      file: '.github/workflows/docs.yml',
      kind: 'continue-on-error',
      target: 'tools/audit/gates/check-prose-lint.mjs',
    });
  });

  it('AdvisoryDiscovery_SeededObserveFlag_IsFound', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({ 'package.json': pkg({}), '.github/workflows/ci.yml': CI_WITH_OBSERVE }),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      file: '.github/workflows/ci.yml',
      kind: 'observe',
      target: 'tools/audit/gates/check-type-debt.mjs',
    });
  });

  /** The `|| true` catches an npm script, and the script chain reaches a primary. */
  it('AdvisoryDiscovery_SeededOrTrueInNpmChain_IsFound', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({
        'package.json': pkg({
          'lint:rogue': `node ${primary('lint-rogue.mjs')} content/`,
          guard: 'node dist/guard.js && (npm run lint:rogue || true) && npm run other',
        }),
      }),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      file: 'package.json',
      kind: 'or-true',
      target: primary('lint-rogue.mjs'),
    });
  });

  it('AdvisoryDiscovery_SeededOrTrueInShellScript_IsFound', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({
        'package.json': pkg({}),
        [primary('run-gates.sh')]: [
          '#!/usr/bin/env bash',
          `bash ${primary('check-rogue.sh')} || true`,
          '',
        ].join('\n'),
      }),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: primary('run-gates.sh'), kind: 'or-true' });
  });

  /** A `|| true` that catches a grep exit code or a shell function softens no enforcement primary. */
  it('AdvisoryDiscovery_ShellIdiomOrTrue_IsNotASofteningSite', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({
        'package.json': pkg({}),
        'scripts/helper.sh': [
          '#!/usr/bin/env bash',
          "hits=$(grep -c 'thing' file.txt || true)",
          'check_build_props || true',
          'files=$(ls 2>/dev/null || true)',
          '',
        ].join('\n'),
      }),
    });
    expect(found).toEqual([]);
  });

  it('AdvisoryDiscovery_ExplicitContinueOnErrorFalse_IsNotASofteningSite', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({
        'package.json': pkg({}),
        '.github/workflows/docs.yml': DOCS_WITH_CONTINUE_ON_ERROR.replace(
          'continue-on-error: true',
          'continue-on-error: false',
        ),
      }),
    });
    expect(found).toEqual([]);
  });

  /** A `.test.sh` file that softens its subject is a test harness, not an advisory. */
  it('AdvisoryDiscovery_SelfTestScripts_AreExcluded', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({
        'package.json': pkg({}),
        'scripts/check-rogue.test.sh': 'bash scripts/check-rogue.sh || true\n',
      }),
    });
    expect(found).toEqual([]);
  });

  /** A `continue-on-error` outside any step still gives a site, with a coarse `job-level:` target. */
  it('AdvisoryDiscovery_JobLevelContinueOnError_StillProducesASite', () => {
    const sites = discoverWorkflowSoftening(
      [
        'name: X',
        'on:',
        '  pull_request:',
        'jobs:',
        '  soft:',
        '    continue-on-error: true',
        '    steps:',
        '      - run: echo hi',
        '',
      ].join('\n'),
      '.github/workflows/x.yml',
      {},
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]?.kind).toBe('continue-on-error');
    expect(sites[0]?.target).toMatch(/^job-level:/);
  });

  it('AdvisoryDiscovery_YamlCommentMentioningMarkers_IsNotASofteningSite', () => {
    const sites = discoverWorkflowSoftening(
      [
        'name: X',
        'on:',
        '  pull_request:',
        'jobs:',
        '  j:',
        '    steps:',
        '      # exit-code-swallowed (`|| true` / continue-on-error), see docs',
        '      - run: node scripts/check-alpha.mjs',
        '',
      ].join('\n'),
      '.github/workflows/x.yml',
      {},
    );
    expect(sites).toEqual([]);
  });

  it('AdvisoryDiscovery_ReportsLineNumberAndEvidence', () => {
    const found = discoverSofteningSites({
      repoRoot: REPO_ROOT,
      fs: memFs({
        'package.json': pkg({}),
        '.github/workflows/docs.yml': DOCS_WITH_CONTINUE_ON_ERROR,
      }),
    });
    expect(found[0]?.line).toBe(8);
    expect(found[0]?.evidence).toContain('check-prose-lint');
  });
});

describe('resolveEnforcementRefs / principalTarget', () => {
  it('EnforcementRefs_ResolveThroughNpmRunChains', () => {
    const scripts = {
      'lint:inv6': 'node tools/audit/gates/lint-inv6.mjs content/',
      guard: 'npm run lint:inv6',
    };
    expect(resolveEnforcementRefs('npm run guard', scripts)).toEqual(['tools/audit/gates/lint-inv6.mjs']);
  });

  it('EnforcementRefs_CyclicNpmScripts_Terminate', () => {
    const scripts = { a: 'npm run b', b: 'npm run a' };
    expect(resolveEnforcementRefs('npm run a', scripts)).toEqual([]);
  });

  it('EnforcementRefs_SelfTestPrimary_IsNotAnEnforcementRef', () => {
    expect(resolveEnforcementRefs('bash scripts/check-x.test.sh', {})).toEqual([]);
  });

  it('PrincipalTarget_FallsBackToTheScriptishPathToken', () => {
    expect(
      principalTarget(`echo '{"layer": "capability"}' | bun dist/evals/run-evals-cli.js`, {}),
    ).toBe('dist/evals/run-evals-cli.js');
  });

  it('PrincipalTarget_StripsWorkspacePrefixes', () => {
    expect(principalTarget('node "$GITHUB_WORKSPACE/tools/audit/gates/check-mutation-gate.mjs"', {})).toBe(
      'tools/audit/gates/check-mutation-gate.mjs',
    );
  });
});

describe('scanCommandSoftening', () => {
  /** The code of a gate that parses its own `--observe` argument is not a site. */
  it('SofteningScan_ObserveWithoutAnEnforcementRef_IsIgnored', () => {
    expect(
      scanCommandSoftening("} else if (arg === '--observe') {", 'scripts/check-x.mjs', 1, {}),
    ).toEqual([]);
  });

  it('SofteningScan_ObserveOnAnEnforcementInvocation_IsASite', () => {
    const sites = scanCommandSoftening(
      `node ${primary('check-x.mjs')} --observe`,
      '.github/workflows/ci.yml',
      10,
      {},
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ kind: 'observe', target: primary('check-x.mjs'), line: 10 });
  });
});

describe('verifyAdvisoryRatchet — softening reconciliation', () => {
  it('AdvisoryRatchet_RegisteredAndDiscoveredAndProbed_Ok', () => {
    const e = entry();
    expect(ratchet({ registry: [e], discovered: [discovered()] })).toEqual({
      ok: true,
      violations: [],
    });
  });

  it('AdvisoryRatchet_UnregisteredContinueOnError_Fails', () => {
    const result = ratchet({
      registry: [],
      softeningSites: [
        {
          file: '.github/workflows/eval-gate.yml',
          kind: 'continue-on-error',
          target: 'dist/evals/run-evals-cli.js',
          line: 103,
          evidence: 'bun dist/evals/run-evals-cli.js',
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'unregistered')).toBe(true);
  });

  it('AdvisoryRatchet_UnregisteredObserveFlag_Fails', () => {
    const result = ratchet({
      registry: [],
      softeningSites: [
        {
          file: '.github/workflows/ci.yml',
          kind: 'observe',
          target: 'tools/audit/gates/check-mutation-gate.mjs',
          line: 277,
          evidence: 'node tools/audit/gates/check-mutation-gate.mjs --observe',
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'unregistered')).toBe(true);
  });

  it('AdvisoryRatchet_UnregisteredOrTrue_Fails', () => {
    const result = ratchet({
      registry: [],
      softeningSites: [
        {
          file: 'package.json',
          kind: 'or-true',
          target: 'scripts/lint-rogue.mjs',
          line: 38,
          evidence: 'npm run lint:rogue || true',
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'unregistered')).toBe(true);
  });

  /** An entry that claims the `continue-on-error` in a file does not cover a new `|| true` in that file. */
  it('AdvisoryRatchet_SameFileDifferentKind_IsStillUnregistered', () => {
    const e = entry();
    const result = ratchet({
      registry: [e],
      softeningSites: [
        site(e),
        { ...site(e), kind: 'or-true', target: 'scripts/other.mjs', line: 99 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'unregistered')).toBe(true);
  });

  it('AdvisoryRatchet_ClaimedSofteningNotOnDisk_Fails', () => {
    const e = entry();
    const result = ratchet({ registry: [e], softeningSites: [] });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'missing-on-disk')).toBe(true);
  });

  it('AdvisoryRatchet_UnregisteredMarker_Fails', () => {
    const result = ratchet({
      registry: [],
      discovered: [discovered({ file: 'scripts/rogue.mjs', control: 'rogue' })],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'unregistered')).toBe(true);
  });

  it('AdvisoryRatchet_ControlMismatch_Fails', () => {
    const e = entry({ control: 'declared-control' });
    const result = ratchet({
      registry: [e],
      discovered: [discovered({ control: 'other-control' })],
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'control-mismatch')).toBe(true);
  });

  it('AdvisoryRatchet_DuplicateId_Fails', () => {
    const dup = [entry(), entry({ file: 'scripts/other.mjs', control: 'c2' })].map((x) => ({
      ...x,
      id: 'dup',
    }));
    expect(ratchet({ registry: dup }).violations.some((v) => v.kind === 'duplicate-id')).toBe(true);
  });

  it('AdvisoryRatchet_ExpiredEntry_Fails', () => {
    const result = ratchet({ registry: [entry({ expires: '2000-01-01' })] });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'expired')).toBe(true);
  });

  it('AdvisoryRatchet_KillFixtureDidNotFire_Fails', () => {
    const e = entry();
    const result = ratchet({ registry: [e], probeResults: [probe(e, { firedOnViolation: false })] });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'kill-fixture-dead')).toBe(true);
  });

  it('AdvisoryRatchet_KillFixtureFiresOnClean_IsNotDiscriminating_Fails', () => {
    const e = entry();
    const result = ratchet({ registry: [e], probeResults: [probe(e, { firedOnClean: true })] });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'kill-fixture-dead')).toBe(true);
  });

  it('AdvisoryRatchet_NoProbeResult_Fails', () => {
    const result = ratchet({ registry: [entry()], probeResults: [] });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'kill-fixture-missing')).toBe(true);
  });

  it('AdvisoryRatchet_ReportsEveryViolationInOnePass', () => {
    const e = entry({ owner: '', expires: '2000-01-01' });
    const result = ratchet({
      registry: [e],
      probeResults: [],
      softeningSites: [],
      ciPathAnalyses: new Map(),
    });
    const kinds = new Set(result.violations.map((v) => v.kind));
    expect(kinds.has('malformed')).toBe(true);
    expect(kinds.has('expired')).toBe(true);
    expect(kinds.has('missing-on-disk')).toBe(true);
    expect(kinds.has('kill-fixture-missing')).toBe(true);
    expect(kinds.has('ci-path-unverified')).toBe(true);
  });
});

describe('verifyAdvisoryRatchet — CI-path claims', () => {
  it('AdvisoryRatchet_UnfilteredClaimOnAFilteredLane_Fails', () => {
    const e = entry({ ciPathFiltered: false, ciFilterRationale: '' });
    const result = ratchet({
      registry: [e],
      ciPathAnalyses: new Map([[e.id, filtered()]]),
    });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'ci-path-mismatch')).toBe(true);
  });

  /** The check has two sides: a filtered claim on an unfiltered lane is also drift. */
  it('AdvisoryRatchet_FilteredClaimOnAnUnfilteredLane_Fails', () => {
    const e = entry({ ciPathFiltered: true, ciFilterRationale: 'hosted on a filtered job' });
    const result = ratchet({ registry: [e], ciPathAnalyses: new Map([[e.id, unfiltered()]]) });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'ci-path-mismatch')).toBe(true);
  });

  it('AdvisoryRatchet_FilteredClaimMatchingAFilteredLane_Ok', () => {
    const e = entry({ ciPathFiltered: true, ciFilterRationale: 'hosted on a path-filtered job' });
    expect(ratchet({ registry: [e], ciPathAnalyses: new Map([[e.id, filtered()]] ) }).ok).toBe(true);
  });

  it('AdvisoryRatchet_NoAnalysisSupplied_Fails', () => {
    const result = ratchet({ registry: [entry()], ciPathAnalyses: new Map() });
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'ci-path-unverified')).toBe(true);
  });
});

describe('assertAdvisoryRatchet', () => {
  it('AdvisoryRatchet_Assert_ThrowsTypedError', () => {
    expect(() =>
      assertAdvisoryRatchet({
        registry: [],
        discovered: [discovered({ file: 'scripts/rogue.mjs', control: 'rogue' })],
        probeResults: [],
        softeningSites: [],
        ciPathAnalyses: new Map(),
        now: CLOCK,
      }),
    ).toThrow(AdvisoryRatchetError);
  });

  it('AdvisoryRatchet_Assert_HealthyRegistry_DoesNotThrow', () => {
    const e = entry();
    expect(() =>
      assertAdvisoryRatchet({
        registry: [e],
        discovered: [discovered()],
        probeResults: [probe(e)],
        softeningSites: [site(e)],
        ciPathAnalyses: new Map([[e.id, unfiltered()]]),
        now: CLOCK,
      }),
    ).not.toThrow();
  });
});

describe('analyzeCiPathFilters (path-filter modelling)', () => {
  const wf = (opts: {
    on?: string[];
    jobIf?: string | null;
    stepIf?: string | null;
    extraJob?: string[];
  }): string =>
    [
      'name: Sample',
      'on:',
      ...(opts.on ?? ['  pull_request:']),
      'jobs:',
      '  gate:',
      ...(opts.jobIf ? [`    if: ${opts.jobIf}`] : []),
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - name: Alpha gate',
      ...(opts.stepIf ? [`        if: ${opts.stepIf}`] : []),
      '        run: node scripts/check-alpha.mjs',
      ...(opts.extraJob ?? []),
      '',
    ].join('\n');

  const MATCH = 'scripts/check-alpha.mjs';

  it('CiPathFilters_UnfilteredPullRequestWorkflow_IsUnfiltered', () => {
    const a = analyzeCiPathFilters(wf({}), { stepMatch: MATCH });
    expect(a.unfiltered).toBe(true);
    expect(a.filters).toEqual([]);
  });

  it('CiPathFilters_PathsFilter_FailsTheUnfilteredClaim', () => {
    const a = analyzeCiPathFilters(
      wf({ on: ['  pull_request:', '    paths:', "      - 'docs/**'"] }),
      { stepMatch: MATCH },
    );
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('paths');
    expect(a.filters[0].detail).toContain('docs/**');
  });

  it('CiPathFilters_InlinePathsFilter_FailsTheUnfilteredClaim', () => {
    const a = analyzeCiPathFilters(
      wf({ on: ['  pull_request:', "    paths: ['src/**', 'scripts/**']"] }),
      { stepMatch: MATCH },
    );
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('paths');
  });

  it('CiPathFilters_PathsIgnoreFilter_FailsTheUnfilteredClaim', () => {
    const a = analyzeCiPathFilters(
      wf({ on: ['  pull_request:', '    paths-ignore:', "      - 'docs/**'"] }),
      { stepMatch: MATCH },
    );
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('paths-ignore');
  });

  it('CiPathFilters_BranchesFilter_FailsTheUnfilteredClaim', () => {
    const a = analyzeCiPathFilters(wf({ on: ['  pull_request:', '    branches: [main]'] }), {
      stepMatch: MATCH,
    });
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('branches');
  });

  /** `types:` selects pull-request lifecycle events, not file paths. */
  it('CiPathFilters_TypesNarrowing_IsNotAPathFilter', () => {
    const a = analyzeCiPathFilters(
      wf({ on: ['  pull_request:', '    types: [opened, synchronize, reopened]'] }),
      { stepMatch: MATCH },
    );
    expect(a.unfiltered).toBe(true);
  });

  /** The job `if:` reads the output of a `dorny/paths-filter` job, the form that `ci.yml` uses. */
  it('CiPathFilters_JobLevelIfGate_FailsTheUnfilteredClaim', () => {
    const a = analyzeCiPathFilters(
      wf({ jobIf: `(${FORK_GUARD}) && needs.changes.outputs.root == 'true'` }),
      { stepMatch: MATCH },
    );
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('job-if');
    expect(a.filters[0].detail).toContain('needs.changes.outputs.root');
  });

  it('CiPathFilters_StepLevelIfGate_FailsTheUnfilteredClaim', () => {
    const a = analyzeCiPathFilters(wf({ stepIf: "github.event_name == 'pull_request'" }), {
      stepMatch: MATCH,
    });
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('step-if');
  });

  /** The fork guard is a security guard, not a path filter. A model that counts it marks each guarded job as filtered. */
  it('CiPathFilters_ForkGuardOnly_IsStillUnfiltered', () => {
    expect(analyzeCiPathFilters(wf({ jobIf: FORK_GUARD }), { stepMatch: MATCH }).unfiltered).toBe(
      true,
    );
    expect(
      analyzeCiPathFilters(wf({ jobIf: `(${FORK_GUARD}) && always()` }), { stepMatch: MATCH })
        .unfiltered,
    ).toBe(true);
  });

  it('CiPathFilters_NoPullRequestTrigger_FailsTheUnfilteredClaim', () => {
    const a = analyzeCiPathFilters(wf({ on: ['  push:', '    branches: [main]'] }), {
      stepMatch: MATCH,
    });
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('no-trigger');
  });

  it('CiPathFilters_StepNotPresentInTheWorkflow_FailsTheClaim', () => {
    const a = analyzeCiPathFilters(wf({}), { stepMatch: 'scripts/check-nowhere.mjs' });
    expect(a.unfiltered).toBe(false);
    expect(a.filters.map((f: { kind: string }) => f.kind)).toContain('step-not-found');
  });

  /** A step that runs in a filtered job and also in an unfiltered job is unfiltered. */
  it('CiPathFilters_ReassertedOnAnUnfilteredJob_IsUnfiltered', () => {
    const text = wf({
      jobIf: `(${FORK_GUARD}) && needs.changes.outputs.mcp == 'true'`,
      extraJob: [
        '  grep-gates:',
        `    if: ${FORK_GUARD}`,
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: node scripts/check-alpha.mjs',
      ],
    });
    expect(analyzeCiPathFilters(text, { stepMatch: MATCH }).unfiltered).toBe(true);
  });

  /** A workflow with a well-formed path and a narrowed lane must fail the claim. The shape of the path proves nothing. */
  it('CiPathFilters_FilenameShapeAloneNoLongerSatisfiesTheClaim', () => {
    const a = analyzeCiPathFilters(
      wf({ on: ['  pull_request:', '    paths:', "      - 'docs/**'"] }),
      { stepMatch: MATCH },
    );
    expect(a.unfiltered).toBe(false);
  });

  it('CiPathFilters_NonFilteringIfIdioms_AreRecognized', () => {
    expect(isNonFilteringIf(null)).toBe(true);
    expect(isNonFilteringIf('')).toBe(true);
    expect(isNonFilteringIf(FORK_GUARD)).toBe(true);
    expect(isNonFilteringIf('always()')).toBe(true);
    expect(isNonFilteringIf('!cancelled()')).toBe(true);
    expect(isNonFilteringIf(`(${FORK_GUARD}) && always()`)).toBe(true);
    expect(
      isNonFilteringIf(
        "${{ always() && (needs.plan.result != 'success' || fromJSON(needs.plan.outputs.lanes).always != 'false') }}",
      ),
    ).toBe(true);
    expect(isNonFilteringIf("needs.changes.outputs.mcp == 'true'")).toBe(false);
    expect(
      isNonFilteringIf(
        "${{ always() && (needs.plan.result != 'success' || fromJSON(needs.plan.outputs.lanes).mcp != 'false') }}",
      ),
    ).toBe(false);
    expect(isNonFilteringIf("github.event_name == 'pull_request'")).toBe(false);
  });
});

describe('parseAdvisoryMarkers', () => {
  it('AdvisoryMarker_Parses_ControlField', () => {
    const src = '# ' + 'ADVISORY(control: benchmark-regression) — non-blocking perf check\n';
    const [m] = parseAdvisoryMarkers(src, 'scripts/x.sh');
    expect(m).toBeDefined();
    expect(m?.control).toBe('benchmark-regression');
    expect(m?.file).toBe('scripts/x.sh');
  });

  it('AdvisoryMarker_NoMarker_Empty', () => {
    expect(parseAdvisoryMarkers('no marker here', 'scripts/x.sh')).toEqual([]);
  });
});

describe('discoverAdvisories (injectable fs)', () => {
  it('AdvisoryDiscovery_FindsMarker_ExcludesSelf', () => {
    const fs = {
      listFiles: (root: string) =>
        root.endsWith('tools')
          ? [join(REPO_ROOT, 'tools', 'audit', 'gates', 'lint-inv6.mjs'), join(REPO_ROOT, 'src', 'advisory-registry.ts')]
          : [],
      readFile: (abs: string) =>
        abs.includes('lint-inv6')
          ? '// ' + 'ADVISORY(control: inv6-workflow-agnosticism) — x'
          : '// ' + 'ADVISORY(control: should-be-ignored) — self',
    };
    const found = discoverAdvisories({ repoRoot: REPO_ROOT, roots: ['tools', 'src'], fs });
    expect(found).toHaveLength(1);
    expect(found[0]?.control).toBe('inv6-workflow-agnosticism');
  });
});

const AUDIT_STEP = primary('check-alpha.mjs');

/** Minimal audit() input carrying one primary that claims an unfiltered path. */
function auditFixture(workflowBody: string, overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      primaries: [
        {
          script: AUDIT_STEP,
          disposition: 'gating',
          workflow: '.github/workflows/ci.yml',
          diffDependent: false,
          rationale: 'wired directly in the gate job',
          unfilteredCiPath: true,
          ...overrides,
        },
      ] as Record<string, unknown>[],
    },
    scripts: {} as Record<string, string>,
    workflows: { '.github/workflows/ci.yml': workflowBody } as Record<string, string>,
    primaryFiles: [AUDIT_STEP],
  };
}

const AUDIT_UNFILTERED = [
  'name: CI',
  'on:',
  '  pull_request:',
  'jobs:',
  '  gate:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - run: node ${AUDIT_STEP}`,
  '',
].join('\n');

const AUDIT_FILTERED = [
  'name: CI',
  'on:',
  '  pull_request:',
  '    paths:',
  "      - 'docs/**'",
  'jobs:',
  '  gate:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - run: node ${AUDIT_STEP}`,
  '',
].join('\n');

/**
 * `analyzeCiPathFilters` is the model. `audit()` is where the gate judges the
 * `unfilteredCiPath` claim of the manifest, so these tests cover that wiring.
 */
describe('check-enforcer-wiring audit() — unfilteredCiPath claim (DR-15)', () => {
  it('EnforcerWiring_UnfilteredClaimOnAnUnfilteredWorkflow_Passes', () => {
    const result = audit(auditFixture(AUDIT_UNFILTERED)) as {
      ok: boolean;
      violations: string[];
    };
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('EnforcerWiring_UnfilteredClaimOnAPathFilteredWorkflow_Fails', () => {
    const result = audit(auditFixture(AUDIT_FILTERED)) as {
      ok: boolean;
      violations: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toContain('[filtered-ci-path]');
    expect(result.violations.join('\n')).toContain('docs/**');
  });

  it('EnforcerWiring_UnfilteredClaimOnAJobIfGatedWorkflow_Fails', () => {
    const gated = [
      'name: CI',
      'on:',
      '  pull_request:',
      'jobs:',
      '  gate:',
      '    runs-on: ubuntu-latest',
      "    if: needs.changes.outputs.root == 'true'",
      '    steps:',
      `      - run: node ${AUDIT_STEP}`,
      '',
    ].join('\n');
    const result = audit(auditFixture(gated)) as { ok: boolean; violations: string[] };
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toContain('[filtered-ci-path]');
  });

  it('EnforcerWiring_UnfilteredClaimWithoutAWorkflow_Fails', () => {
    const fx = auditFixture(AUDIT_UNFILTERED, { workflow: undefined, disposition: 'advisory' });
    const result = audit(fx) as { ok: boolean; violations: string[] };
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toContain('[unfiltered-path-unverifiable]');
  });

  it('EnforcerWiring_UnfilteredClaimNamingAnAbsentWorkflow_Fails', () => {
    const fx = auditFixture(AUDIT_UNFILTERED, {
      workflow: '.github/workflows/nope.yml',
      disposition: 'advisory',
    });
    const result = audit(fx) as { ok: boolean; violations: string[] };
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toContain('[unfiltered-path-unverifiable]');
  });

  /** The claim is opt-in: a primary with no claim gets no violation for a filtered lane. */
  it('EnforcerWiring_NoUnfilteredClaim_IsNotAdjudicated', () => {
    const fx = auditFixture(AUDIT_FILTERED, { unfilteredCiPath: undefined });
    const result = audit(fx) as { ok: boolean; violations: string[] };
    expect(result.violations.join('\n')).not.toContain('filtered-ci-path');
  });
});

/** Compose the real-repo ratchet inputs (discovery + path model + probes). */
function liveRatchetInputs() {
  const softeningSites = discoverSofteningSites({ repoRoot: REPO_ROOT });
  const ciPathAnalyses = new Map<string, CiPathAnalysis>(
    ADVISORY_REGISTRY.map((e) => [
      e.id,
      analyzeCiPathFilters(readFileSync(join(REPO_ROOT, ...e.ciPath.split('/')), 'utf8'), {
        stepMatch: e.ciStepMatch,
      }) as CiPathAnalysis,
    ]),
  );
  const probeResults = ADVISORY_REGISTRY.map((e) => {
    const local = REGISTRY_LOCAL_KILL_PROBES[e.id];
    return local ? local(e, { repoRoot: REPO_ROOT }) : runKillProbe(e, { repoRoot: REPO_ROOT });
  });
  return {
    registry: ADVISORY_REGISTRY,
    discovered: discoverAdvisories({ repoRoot: REPO_ROOT }),
    probeResults,
    softeningSites,
    ciPathAnalyses,
    now: new Date(),
  };
}

describe('ADVISORY_REGISTRY (real repo)', () => {
  it('EveryRegisteredAdvisory_HasCompleteGovernance', () => {
    for (const e of ADVISORY_REGISTRY) {
      expect(validateAdvisoryGovernance(e, CLOCK), `${e.id} governance`).toEqual([]);
      expect(e.owner.trim().length, `${e.id} owner`).toBeGreaterThan(0);
      expect(e.promotionThreshold.trim().length, `${e.id} promotionThreshold`).toBeGreaterThan(0);
      expect(e.removalThreshold.trim().length, `${e.id} removalThreshold`).toBeGreaterThan(0);
      expect(e.killFixture.trim().length, `${e.id} killFixture`).toBeGreaterThan(0);
      expect(e.softening.length, `${e.id} softening`).toBeGreaterThan(0);
      expect(e.ciPath, `${e.id} ciPath`).toMatch(/^\.github\/workflows\/[\w.-]+\.ya?ml$/);
      expect(e.issue, `${e.id} issue`).toMatch(/^#\d+$/);
      expect(e.expires, `${e.id} expires`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  /** In the real tree, a registry entry claims each `continue-on-error`, `--observe` and `|| true` site. */
  it('EverySofteningSiteOnDisk_IsRegistered', () => {
    const claimed = new Set(
      ADVISORY_REGISTRY.flatMap((e) =>
        e.softening.map((r) => `${r.file}\u0000${r.kind}\u0000${r.target}`),
      ),
    );
    const sites = discoverSofteningSites({ repoRoot: REPO_ROOT });
    expect(sites.length, 'discovery must find the real softening sites').toBeGreaterThan(0);
    const unclaimed = sites.filter(
      (s) => !claimed.has(`${s.file}\u0000${s.kind}\u0000${s.target}`),
    );
    expect(
      unclaimed.map((s) => `${s.kind} ${s.file}:${s.line} -> ${s.target}`),
      'unregistered advisory softening found on disk',
    ).toEqual([]);
  });

  /** The registry governs each advisory primary in the enforcer-wiring manifest. The manifest names three or more. */
  it('EveryManifestAdvisory_IsRegistered', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'tools', 'audit', 'gates', 'enforcer-wiring-manifest.json'), 'utf8'),
    ) as { primaries: { script: string; disposition: string }[] };
    const manifestAdvisories = manifest.primaries
      .filter((p) => p.disposition === 'advisory')
      .map((p) => p.script);
    expect(manifestAdvisories.length).toBeGreaterThanOrEqual(3);
    const governed = new Set([
      ...ADVISORY_REGISTRY.map((e) => e.file),
      ...ADVISORY_REGISTRY.flatMap((e) => e.softening.map((r) => r.target)),
    ]);
    expect(manifestAdvisories.filter((s) => !governed.has(s))).toEqual([]);
  });

  it('RealCiPathClaims_MatchTheParsedWorkflows', () => {
    for (const e of ADVISORY_REGISTRY) {
      const analysis = analyzeCiPathFilters(
        readFileSync(join(REPO_ROOT, ...e.ciPath.split('/')), 'utf8'),
        { stepMatch: e.ciStepMatch },
      ) as CiPathAnalysis;
      expect(
        !analysis.unfiltered,
        `${e.id} declares ciPathFiltered=${e.ciPathFiltered}; parsed ${e.ciPath} says ` +
          `filtered=${!analysis.unfiltered} (${analysis.filters.map((f) => f.kind).join(', ')})`,
      ).toBe(e.ciPathFiltered);
    }
  });

  it('EveryKillFixture_StillFires', () => {
    for (const r of liveRatchetInputs().probeResults) {
      expect(r.firedOnViolation, `${r.advisoryId} kill fixture must FIRE: ${r.detail}`).toBe(true);
      expect(r.firedOnClean, `${r.advisoryId} must be discriminating: ${r.detail}`).toBe(false);
    }
  });

  it('RealRepoAdvisoryRatchet_IsGreen', () => {
    const result = verifyAdvisoryRatchet(liveRatchetInputs());
    expect(result.violations.map((v) => `[${v.kind}] ${v.detail}`)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
