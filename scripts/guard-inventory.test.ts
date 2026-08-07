// scripts/guard-inventory.test.ts
//
// DR-24 / task 063 — the Wave-1 guard inventory's own proof.
//
// The three named cases below are the acceptance criteria, in order:
//   1. every Wave-1 guard is reachable from a CI job (or carries an expiring reason),
//   2. path-filtered hosting is REPORTED, not silently accepted,
//   3. an inventory resolving zero guards FAILS rather than passing clean.
//
// The remaining cases are kill fixtures. Every failure class the audit can emit
// has one, because a guard whose failure path is never exercised is the same
// unproven mechanism this whole task exists to find — and this file is that
// guard's self-test, hosted (per DR-24) in the same CI job as the guard itself:
// the unfiltered `grep-gates` deps tail.
//
// NOTE on DR-30: the `@oracle-sources` corpus covers `repo/src`, `mcp/src`,
// `mcp/test` and `mcp/tests` — not root `scripts/`. This file sits outside it,
// the same honest consequence `cli-derivation-guard` records for `mcp/scripts`.
// The two authorities this file compares are nonetheless real and independent:
// the workflow YAML (`.github/workflows/**`) and the guard artifacts on disk.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  MANIFEST_PATH,
  CI_WORKFLOW,
  GUARD_EXEMPTIONS,
  auditGuardInventory,
  buildGuardInventory,
  collectImportSpecifiers,
  globMatches,
  hasDirectRunExit,
  isPathShaped,
  loadSuiteConfigs,
  loadWorkflows,
  manifestPrimaries,
  parseSpecTasks,
  parseWorkflow,
  parseVitestProjects,
  pathFilterGlobs,
  resolveHosts,
  renderInventoryTable,
  scanMcpScriptGates,
  suiteForTest,
  vitestPathOperands,
  vitestProjectSelectors,
  wave1Tasks,
  type GuardInventory,
  type GuardRecord,
  type ResolutionContext,
} from './guard-inventory.js';

// ─── Shared live fixtures (built once — the scan walks both source trees) ────

const liveInventory = buildGuardInventory();
const liveWorkflows = loadWorkflows();
const liveCi = liveWorkflows.find((w) => w.path === CI_WORKFLOW);
const liveManifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST_PATH), 'utf8'));
const liveFilterGlobs = liveCi === undefined ? {} : pathFilterGlobs(liveCi.doc);
const liveAudit = auditGuardInventory(liveInventory, {
  manifestJson: liveManifest,
  filterGlobs: liveFilterGlobs,
});

/** A minimal well-formed record, so each fixture varies exactly one field. */
function guard(overrides: Partial<GuardRecord> & { artifact: string }): GuardRecord {
  return {
    channels: ['wave1-spec'],
    wave1Tasks: [],
    hosts: [],
    runnable: false,
    enforcement: 'unreachable',
    pathFilteredOnly: false,
    productionImported: null,
    ...overrides,
  };
}

function inventoryOf(guards: readonly GuardRecord[]): GuardInventory {
  return {
    guards,
    runnableWithoutSelfTest: [],
    compileTimeOnlyArtifacts: [],
    unresolvedSpecArtifacts: [],
  };
}

// ─── 1. Every Wave-1 guard is reachable from a CI job ───────────────────────

describe('Wave-1 guard inventory — CI reachability proof (DR-24, task 063)', () => {
  it('GuardInventory_EveryWave1Guard_IsReachableFromACiJob', () => {
    // The live proof. Every guard the three discovery channels resolve must be
    // executed by some CI job, or carry a recorded, EXPIRING reason why not.
    expect(liveAudit.violations, liveAudit.violations.join('\n')).toEqual([]);
    expect(liveAudit.ok).toBe(true);

    // The four guard families this task was dispatched against must each be
    // PRESENT — an inventory that cannot see them proves nothing about them.
    const artifacts = new Set(liveInventory.guards.map((g) => g.artifact));
    for (const named of [
      'servers/exarchos-mcp/src/agents/dispatch-shape.ts',
      'servers/exarchos-mcp/src/architecture/output-schema-census.ts',
      'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
      'servers/exarchos-mcp/src/architecture/authority-topology.ts',
    ]) {
      expect(artifacts, `${named} is missing from the inventory`).toContain(named);
    }

    // Task 020's guard is the ONE recorded exception, and it is recorded as
    // unreachable rather than quietly re-classified as fine.
    const cliDerivation = liveInventory.guards.find(
      (g) => g.artifact === 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    );
    expect(cliDerivation?.enforcement).toBe('unreachable');
    expect(GUARD_EXEMPTIONS.map((e) => e.artifact)).toContain(
      'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    );
  });

  it('GuardInventory_SelfTestHostedGateWithNoDirectExecution_ReadsAsUnreachable', () => {
    // The distinction that decides whether this instrument works at all.
    // `cli-derivation-guard`'s co-located self-test DOES run on every MCP-touching
    // PR. Its GATE does not. If a hosted self-test counted as a wired guard, the
    // single guard this task was dispatched to find would report green.
    const record = liveInventory.guards.find(
      (g) => g.artifact === 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    );
    expect(record).toBeDefined();
    expect(record?.runnable).toBe(true);
    expect(record?.hosts.length, 'its self-test really is hosted').toBeGreaterThan(0);
    expect(record?.hosts.every((h) => h.via === 'self-test')).toBe(true);
    expect(record?.enforcement).toBe('unreachable');
  });

  it('GuardInventory_SeededUnwiredGuard_FailsTheReachabilityProof', () => {
    const audit = auditGuardInventory(inventoryOf([guard({ artifact: 'scripts/check-seeded.mjs' })]), {
      exemptions: [],
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.join('\n')).toContain('[unwired-guard]');
  });

  it('GuardInventory_ExemptionPastItsExpiry_Fails', () => {
    const audit = auditGuardInventory(inventoryOf([guard({ artifact: 'scripts/check-seeded.mjs' })]), {
      now: new Date('2027-01-01T00:00:00Z'),
      exemptions: [
        {
          artifact: 'scripts/check-seeded.mjs',
          excuses: 'unreachable',
          reason: 'seeded',
          blockedBy: '#0',
          expires: '2026-01-01',
        },
      ],
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.join('\n')).toContain('[expired-exemption]');
  });

  it('GuardInventory_ExemptionForAGuardThatIsNowWired_FailsAsStale', () => {
    const audit = auditGuardInventory(
      inventoryOf([
        guard({
          artifact: 'scripts/check-seeded.mjs',
          enforcement: 'blocks',
          hosts: [
            {
              workflow: CI_WORKFLOW,
              job: 'grep-gates',
              via: 'direct',
              pathFilterKeys: [],
              exitSwallowed: false,
              onPullRequest: true,
              blocking: true,
            },
          ],
        }),
      ]),
      {
        now: new Date('2026-01-01T00:00:00Z'),
        exemptions: [
          {
            artifact: 'scripts/check-seeded.mjs',
            excuses: 'unreachable',
            reason: 'seeded',
            blockedBy: '#0',
            expires: '2026-12-31',
          },
        ],
      },
    );
    expect(audit.ok).toBe(false);
    expect(audit.violations.join('\n')).toContain('[stale-exemption]');
  });

  it('GuardInventory_ExemptionNamingAGuardOutsideTheInventory_FailsAsOrphan', () => {
    const audit = auditGuardInventory(inventoryOf([guard({ artifact: 'scripts/check-a.mjs' })]), {
      now: new Date('2026-01-01T00:00:00Z'),
      exemptions: [
        {
          artifact: 'scripts/check-renamed.mjs',
          excuses: 'unreachable',
          reason: 'seeded',
          blockedBy: '#0',
          expires: '2026-12-31',
        },
        {
          artifact: 'scripts/check-a.mjs',
          excuses: 'unreachable',
          reason: 'seeded',
          blockedBy: '#0',
          expires: '2026-12-31',
        },
      ],
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.join('\n')).toContain('[orphan-exemption]');
  });

  it('GuardInventory_ManifestPrimaryAbsentFromTheInventory_Fails', () => {
    // The anti-omission tooth: the inventory's denominator can never fall below
    // the enforcer manifest's, so a new scripts/check-* gate enters this
    // inventory whether or not its author remembers to say so.
    const audit = auditGuardInventory(inventoryOf([guard({ artifact: 'scripts/check-a.mjs', enforcement: 'blocks' })]), {
      exemptions: [],
      manifestJson: {
        primaries: [
          { script: 'scripts/check-a.mjs', disposition: 'gating' },
          { script: 'scripts/check-invisible.mjs', disposition: 'gating' },
          { script: 'scripts/check-gone.mjs', disposition: 'retired' },
        ],
      },
    });
    expect(audit.violations.join('\n')).toContain('[manifest-primary-missing]');
    expect(audit.violations.join('\n')).toContain('scripts/check-invisible.mjs');
    // A `retired` primary is deliberately dead and must NOT be demanded back.
    expect(audit.violations.join('\n')).not.toContain('scripts/check-gone.mjs');
  });
});

// ─── 2. Path-filtered hosting is reported, not silently accepted ────────────

describe('Path-filtered hosting (#1711 skipped-as-passed)', () => {
  it('GuardInventory_PathFilteredGuard_IsReportedNotSilentlyAccepted', () => {
    // Reported: the live inventory has path-filtered-only guards and names every
    // one of them, with the gating key DERIVED from the job's own `if:` text.
    expect(liveAudit.pathFilteredOnly.length).toBeGreaterThan(0);
    for (const artifact of liveAudit.pathFilteredOnly) {
      const record = liveInventory.guards.find((g) => g.artifact === artifact);
      expect(record, `${artifact} is reported filtered but absent from the inventory`).toBeDefined();
      const keys = new Set(record?.hosts.flatMap((h) => [...h.pathFilterKeys]) ?? []);
      expect(keys.size, `${artifact} reported filtered with no derived filter key`).toBeGreaterThan(0);
    }

    // The whole Wave-1 in-tree guard population sits in the `mcp`-filtered lane —
    // the standing finding this criterion exists to surface. G5's census is the
    // named instance: it is unenforced on every PR that touches no MCP path.
    expect(liveAudit.pathFilteredOnly).toContain('servers/exarchos-mcp/src/architecture/authority-topology.ts');

    // Not silently accepted: the same condition, with the guard's own source
    // outside the filter and no unfiltered pull_request host re-asserting it,
    // is a VIOLATION rather than an entry in a list nobody reads.
    const audit = auditGuardInventory(
      inventoryOf([
        guard({
          artifact: 'scripts/check-outside-the-filter.mjs',
          enforcement: 'blocks',
          pathFilteredOnly: true,
          hosts: [
            {
              workflow: CI_WORKFLOW,
              job: 'test-root',
              via: 'direct',
              pathFilterKeys: ['root'],
              exitSwallowed: false,
              onPullRequest: true,
              blocking: true,
            },
          ],
        }),
      ]),
      { exemptions: [], filterGlobs: { root: ['src/**'] } },
    );
    expect(audit.ok).toBe(false);
    expect(audit.violations.join('\n')).toContain('[implementation-surface-outside-filter]');
  });

  it('GuardInventory_FilteredGuardReassertedOnAnUnfilteredPrHost_Passes', () => {
    // The DR-10 `.test.sh` re-assert pattern: enforced from a filtered job, but
    // re-asserted unfiltered, so a PR touching the guard's own source still arms
    // a job that runs it. That is the two-surface rule SATISFIED, not evaded.
    const audit = auditGuardInventory(
      inventoryOf([
        guard({
          artifact: 'scripts/check-reasserted.mjs',
          enforcement: 'blocks',
          pathFilteredOnly: true,
          hosts: [
            {
              workflow: CI_WORKFLOW,
              job: 'test-mcp',
              via: 'direct',
              pathFilterKeys: ['mcp'],
              exitSwallowed: false,
              onPullRequest: true,
              blocking: true,
            },
            {
              workflow: CI_WORKFLOW,
              job: 'grep-gates',
              via: 'self-test',
              pathFilterKeys: [],
              exitSwallowed: false,
              onPullRequest: true,
              blocking: true,
            },
          ],
        }),
      ]),
      { exemptions: [], filterGlobs: { mcp: ['servers/exarchos-mcp/**'] } },
    );
    expect(audit.violations.join('\n')).not.toContain('[implementation-surface-outside-filter]');
    expect(audit.pathFilteredOnly).toEqual(['scripts/check-reasserted.mjs']);
  });

  it('GuardInventory_ReleaseLaneUnfilteredHost_DoesNotCountAsPreMergeCoverage', () => {
    // `release.yml` runs the whole root suite, unfiltered — but on a tag push,
    // after the merge that would have introduced the regression. Letting it clear
    // the two-surface finding would launder post-merge execution as a PR gate.
    const audit = auditGuardInventory(
      inventoryOf([
        guard({
          artifact: 'scripts/check-outside-the-filter.mjs',
          enforcement: 'blocks',
          pathFilteredOnly: true,
          hosts: [
            {
              workflow: CI_WORKFLOW,
              job: 'test-root',
              via: 'direct',
              pathFilterKeys: ['root'],
              exitSwallowed: false,
              onPullRequest: true,
              blocking: true,
            },
            {
              workflow: '.github/workflows/release.yml',
              job: 'release',
              via: 'self-test',
              pathFilterKeys: [],
              exitSwallowed: false,
              onPullRequest: false,
              blocking: false,
            },
          ],
        }),
      ]),
      { exemptions: [], filterGlobs: { root: ['src/**'] } },
    );
    expect(audit.violations.join('\n')).toContain('[implementation-surface-outside-filter]');
  });
});

// ─── 3. Non-empty denominator ───────────────────────────────────────────────

describe('Non-empty denominator', () => {
  it('GuardInventory_ZeroGuardsResolved_FailsClosed', () => {
    const audit = auditGuardInventory(inventoryOf([]), { exemptions: [] });
    expect(audit.ok).toBe(false);
    expect(audit.violations.join('\n')).toContain('[empty-inventory]');

    // …and the live run is genuinely non-empty, so the criterion above is not
    // being satisfied by an inventory that happens to find nothing.
    expect(liveInventory.guards.length).toBeGreaterThan(20);
    expect(manifestPrimaries(liveManifest).length).toBeGreaterThan(0);
  });

  it('GuardInventory_ScanRootThatCannotBeRead_ThrowsRatherThanContributingZero', () => {
    expect(() => scanMcpScriptGates(join(REPO_ROOT, 'no-such-repo-root'))).toThrow(/cannot enumerate/);
  });

  it('GuardInventory_VitestConfigThatParsesNoProjects_ThrowsRatherThanUnhostingEveryTest', () => {
    expect(() => loadSuiteConfigs(join(REPO_ROOT, 'no-such-repo-root'))).toThrow();
  });

  it('GuardInventory_LiveTableRendersOneRowPerGuard', () => {
    const table = renderInventoryTable(liveInventory);
    expect(table.split('\n').length).toBe(liveInventory.guards.length + 2);
    expect(table).toContain('| Guard | CI job(s) | Path-filtered? | Blocks / observes | Prod caller? |');
  });
});

// ─── Derivation units — each one has bitten this repo before ────────────────

describe('Derivations the inventory rests on', () => {
  it('SpecParse_AnchorTasksTrailingTheWave1Block_AreNotWave1', () => {
    const spec = [
      '**Wave 1f — something**',
      '',
      '### Task 046: A real Wave-1 task',
      '**Files:** `a/b.ts`',
      '',
      '### Task 028: [ANCHOR] Effect ledger',
      '**Files:** `c/d.ts`',
      '',
    ].join('\n');
    const ids = wave1Tasks(parseSpecTasks(spec)).map((t) => t.id);
    expect(ids).toEqual(['046']);
  });

  it('SpecParse_FilesLineEntries_KeepPathsAndDropProseAndDirectories', () => {
    expect(isPathShaped('servers/exarchos-mcp/src/agents/dispatch-shape.ts')).toBe(true);
    expect(isPathShaped('AGENTS.md')).toBe(true);
    expect(isPathShaped('src/')).toBe(false);
    expect(isPathShaped('/exarchos:invariants')).toBe(false);
    expect(isPathShaped('as')).toBe(false);
    expect(isPathShaped('audit-prompt')).toBe(false);
  });

  it('DirectRunDetection_ExitInsideAFunctionBody_IsNotAnEntrypoint', () => {
    const notAGate = 'export function run(): void { process.exit(1); }\n';
    const aGate = 'function run(): number { return 1; }\nprocess.exit(run());\n';
    expect(hasDirectRunExit(notAGate, 'a.ts')).toBe(false);
    expect(hasDirectRunExit(aGate, 'b.ts')).toBe(true);
  });

  it('DirectRunDetection_ExitNamedOnlyInACommentOrString_IsNotAnEntrypoint', () => {
    // The text-proxy trap, five prior occurrences in this program. The parser
    // classifies comments and literals as trivia, so they never become calls.
    const decoy = ['// process.exit(1) is what a gate would do', "const help = 'process.exit(1)';", 'export {};'].join(
      '\n',
    );
    expect(hasDirectRunExit(decoy, 'c.ts')).toBe(false);
  });

  it('DirectRunDetection_UnparseableSource_ThrowsRatherThanReadingAsNotAGate', () => {
    expect(() => hasDirectRunExit('function ( { ] )', 'broken.ts')).toThrow(/parse error/);
  });

  it('ImportScan_DynamicImport_IsCountedAsAProductionCaller', () => {
    // `index.ts` reaches `adapters/mcp.ts` only through `await import(...)`. A
    // static-only scan reports the MCP adapter as having no production caller.
    const source = "const m = await import('./adapters/mcp.js');\nexport {};\n";
    expect(collectImportSpecifiers(source, 'index.ts')).toEqual(['./adapters/mcp.js']);
  });

  it('ImportScan_SpecifierInACommentOrTemplateLiteral_IsNotAnImport', () => {
    const source = ["// import { x } from './guard.js'", 'const s = `./guard.js`;', 'export {};'].join('\n');
    expect(collectImportSpecifiers(source, 'a.ts')).toEqual([]);
  });

  it('VitestProjects_CoverageIncludeUnderANonTestKey_IsNotASuiteGlob', () => {
    const config = [
      'export default {',
      "  test: { name: 'unit', include: ['src/**/*.test.ts'] },",
      "  coverage: { include: ['src/**/*.ts'] },",
      '};',
    ].join('\n');
    expect(parseVitestProjects(config, 'vitest.config.ts')).toEqual([
      { name: 'unit', includes: ['src/**/*.test.ts'] },
    ]);
  });

  it('VitestInvocation_ProjectSelectorsAndPathOperands_AreParsedApart', () => {
    // `vitest run --project unit --project integration` names PROJECTS, not
    // files. Reading them as file filters unhosts every root-suite guard.
    expect(vitestProjectSelectors(' --project unit --project integration')).toEqual(['unit', 'integration']);
    expect(vitestPathOperands(' --project unit --project integration')).toEqual([]);
    expect(vitestPathOperands(' scripts/ci-topology.test.ts')).toEqual(['scripts/ci-topology.test.ts']);
  });

  it('GlobMatch_DoubleStarCrossesSeparators_SingleStarDoesNot', () => {
    expect(globMatches('scripts/**/*.test.ts', 'scripts/a/b/c.test.ts')).toBe(true);
    expect(globMatches('scripts/**/*.test.ts', 'scripts/c.test.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatches('servers/exarchos-mcp/**', 'servers/exarchos-mcp/src/x.ts')).toBe(true);
    expect(globMatches('servers/exarchos-mcp/**', 'scripts/lint-inv6.mjs')).toBe(false);
    expect(globMatches('AGENTS.md', 'AGENTS.md')).toBe(true);
  });

  it('SuiteResolution_McpTest_IsNeverClaimedByTheRootSuite', () => {
    const suites = loadSuiteConfigs();
    expect(suiteForTest('servers/exarchos-mcp/src/agents/dispatch-shape.test.ts', suites)?.suite).toBe('mcp');
    expect(suiteForTest('scripts/ci-topology.test.ts', suites)?.suite).toBe('root');
    expect(suiteForTest('docs/whatever.md', suites)).toBeNull();
  });

  it('HostResolution_NpmScriptChain_IsWalkedTransitively', () => {
    // The class-2 `unreachable-npm` trap: the guard is never named in the
    // workflow, only two npm-script hops away from it.
    const workflow = parseWorkflow(
      CI_WORKFLOW,
      [
        'on: [pull_request]',
        'jobs:',
        '  ci-gate:',
        '    needs: [gates]',
        '    steps:',
        '      - run: echo aggregate',
        '  gates:',
        '    steps:',
        '      - run: npm run outer',
      ].join('\n'),
    );
    const ctx: ResolutionContext = {
      workflows: [workflow],
      rootPkg: { dir: '', scripts: { outer: 'npm run inner', inner: 'node scripts/check-deep.mjs' } },
      mcpPkg: { dir: 'servers/exarchos-mcp', scripts: {} },
      suites: loadSuiteConfigs(),
      exists: () => false,
    };
    const hosts = resolveHosts('scripts/check-deep.mjs', ctx);
    expect(hosts.map((h) => h.job)).toEqual(['gates']);
    expect(hosts[0]?.via).toBe('direct');
    expect(hosts[0]?.blocking).toBe(true);
  });

  it('HostResolution_ExitCodeSwallowedByOrTrue_IsNotBlocking', () => {
    const workflow = parseWorkflow(
      CI_WORKFLOW,
      [
        'on: [pull_request]',
        'jobs:',
        '  ci-gate:',
        '    needs: [gates]',
        '    steps:',
        '      - run: echo aggregate',
        '  gates:',
        '    steps:',
        '      - run: (node scripts/check-soft.mjs || true)',
      ].join('\n'),
    );
    const ctx: ResolutionContext = {
      workflows: [workflow],
      rootPkg: { dir: '', scripts: {} },
      mcpPkg: { dir: 'servers/exarchos-mcp', scripts: {} },
      suites: loadSuiteConfigs(),
      exists: () => false,
    };
    const hosts = resolveHosts('scripts/check-soft.mjs', ctx);
    expect(hosts[0]?.exitSwallowed).toBe(true);
    expect(hosts[0]?.blocking).toBe(false);
  });

  it('HostResolution_JobAbsentFromTheAggregator_ObservesRatherThanBlocks', () => {
    const workflow = parseWorkflow(
      CI_WORKFLOW,
      [
        'on: [pull_request]',
        'jobs:',
        '  ci-gate:',
        '    needs: [wired]',
        '    steps:',
        '      - run: echo aggregate',
        '  unwired:',
        '    steps:',
        '      - run: node scripts/check-orphan.mjs',
      ].join('\n'),
    );
    const ctx: ResolutionContext = {
      workflows: [workflow],
      rootPkg: { dir: '', scripts: {} },
      mcpPkg: { dir: 'servers/exarchos-mcp', scripts: {} },
      suites: loadSuiteConfigs(),
      exists: () => false,
    };
    const hosts = resolveHosts('scripts/check-orphan.mjs', ctx);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.blocking).toBe(false);
  });
});

// ─── Reporting surfaces that must not go silent ──────────────────────────────

describe('Exclusions stay reviewable', () => {
  it('GuardInventory_RunnableModuleWithNoSelfTest_IsReportedNotDroppedSilently', () => {
    // `stryker-adapter.mjs` is runnable but is a toolchain adapter, not a guard —
    // it has no co-located self-test, which is DR-24's own definition. Excluding
    // it is correct; excluding it INVISIBLY would make the exclusion a hiding place.
    expect(liveInventory.runnableWithoutSelfTest).toContain('servers/exarchos-mcp/scripts/stryker-adapter.mjs');
  });

  it('GuardInventory_CompileTimeOnlyWave1Artifacts_AreReported', () => {
    // Modules whose enforcement rung is `tsc`, not a CI step. They carry no
    // executable verdict, so execution reachability is not a question that can be
    // asked of them — but they are named rather than dropped.
    expect(liveInventory.compileTimeOnlyArtifacts).toContain('servers/exarchos-mcp/src/output-schema-declaration.ts');
  });

  it('GuardInventory_R11GuardsWithNoProductionCaller_AreNamed', () => {
    // The R-11 axis, orthogonal to CI reachability: these run on every
    // MCP-touching PR through their co-located vitest and are called by nothing
    // in production. Reported so Wave-1 exit cannot inherit them unexamined.
    //
    // `cli-derivation-guard.ts` was pinned here on task 063's own branch and is
    // deliberately NOT pinned any more: task 026 exported `parseOrThrow` from it
    // and `scripts/authority-live-proof.ts` imports it, so it now has a real
    // production caller and left the R-11 set. That is the axis working — a name
    // pinned as R-11 forever would assert a fact the tree is allowed to change.
    // The population assertion below stays, so the set cannot silently empty.
    expect(liveAudit.noProductionCaller.length).toBeGreaterThan(0);
    expect(liveAudit.noProductionCaller).toContain('scripts/guard-inventory.ts');
  });
});
