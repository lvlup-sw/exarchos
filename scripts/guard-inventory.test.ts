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
  SHELL_INTERPRETERS,
  auditGuardInventory,
  buildGuardInventory,
  collectImportSpecifiers,
  describeHost,
  globMatches,
  hasDirectRunExit,
  indexShellIndirection,
  isEnforcingHost,
  isPathShaped,
  joinShellContinuations,
  loadSuiteConfigs,
  loadWorkflows,
  manifestPrimaries,
  parseSpecTasks,
  parseWorkflow,
  parseVitestProjects,
  pathFilterGlobs,
  resolveHosts,
  resolveShellExecutions,
  renderInventoryTable,
  scanMcpScriptGates,
  shellCommandSegments,
  shellWords,
  stripShellComments,
  suiteForTest,
  vitestPathOperands,
  vitestProjectSelectors,
  wave1Tasks,
  type GuardInventory,
  type GuardRecord,
  type LoadedWorkflow,
  type ResolutionContext,
  type ShellIndirectionIndex,
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

/**
 * A walk that examined something, so a fixture varying an unrelated field does not
 * also trip `[empty-indirection-walk]`. The zero cases are asserted explicitly by
 * `GuardInventory_IndirectionWalkThatWalkedNothing_FailsClosed`.
 */
function walkedSomething(overrides: Partial<ShellIndirectionIndex> = {}): ShellIndirectionIndex {
  return {
    byStep: new Map(),
    runStepsWalked: 12,
    wrapperScriptsWalked: ['scripts/wrapper.sh'],
    unresolvedInvocations: [],
    ...overrides,
  };
}

function inventoryOf(
  guards: readonly GuardRecord[],
  indirection: ShellIndirectionIndex = walkedSomething(),
): GuardInventory {
  return {
    guards,
    runnableWithoutSelfTest: [],
    compileTimeOnlyArtifacts: [],
    unresolvedSpecArtifacts: [],
    indirection,
  };
}

/** A resolution context over an in-memory file set, with the shell index built. */
function contextOf(
  workflow: LoadedWorkflow,
  files: Readonly<Record<string, string>>,
  scripts: Readonly<Record<string, string>> = {},
): ResolutionContext {
  const base: ResolutionContext = {
    workflows: [workflow],
    rootPkg: { dir: '', scripts },
    mcpPkg: { dir: 'servers/exarchos-mcp', scripts: {} },
    suites: loadSuiteConfigs(),
    exists: (path) => Object.hasOwn(files, path),
    readScript: (path) => files[path] ?? null,
  };
  return { ...base, shellIndex: indexShellIndirection(base) };
}

/** A one-job `ci.yml` whose single step is `run`. */
function workflowRunning(command: string): LoadedWorkflow {
  return parseWorkflow(
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
      `      - run: ${command}`,
    ].join('\n'),
  );
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

    // Task 020's guard was the ONE recorded exception for all of Wave 1. Task
    // 076 DISCHARGED it: deleting the hand-written `merge-orchestrate` promotion
    // let the derivation entrypoint go green on a clean tree, so it is now wired
    // direct and blocking on the unfiltered `grep-gates` deps tail, and its
    // exemption entry was deleted rather than re-dated.
    //
    // All three properties are asserted, because "blocks" alone would be
    // satisfied by a path-filtered host that skips-as-passed on the PRs it
    // polices — #1711, the failure this whole DR exists for.
    const cliDerivation = liveInventory.guards.find(
      (g) => g.artifact === 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    );
    expect(cliDerivation?.enforcement).toBe('blocks');
    expect(cliDerivation?.pathFilteredOnly).toBe(false);
    expect(cliDerivation?.hosts.some((h) => h.via === 'direct')).toBe(true);
    expect(GUARD_EXEMPTIONS.map((e) => e.artifact)).not.toContain(
      'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    );
  });

  it('GuardInventory_SelfTestHostedGateWithNoDirectExecution_ReadsAsUnreachable', () => {
    // The distinction that decides whether this instrument works at all: a
    // guard whose SELF-TEST is hosted but whose GATE is never executed must read
    // `unreachable`, not green. If a hosted self-test counted as a wired guard,
    // an unwired gate would report as enforced.
    //
    // `cli-derivation-guard` was this claim's live subject for all of Wave 1.
    // Task 076 wired it direct-and-blocking, which REMOVED the subject — so the
    // claim is re-seeded synthetically here rather than deleted with the
    // remediation, exactly as task 021's kill fixture was. A guarantee must not
    // lapse because the defect it describes got fixed.
    const selfTestOnly = guard({
      artifact: 'servers/exarchos-mcp/scripts/example-gate.ts',
      runnable: true,
      hosts: [{ job: 'test-mcp', via: 'self-test', pathFiltered: false }],
      enforcement: 'unreachable',
    });
    expect(selfTestOnly.hosts.length, 'its self-test really is hosted').toBeGreaterThan(0);
    expect(selfTestOnly.hosts.every((h) => h.via === 'self-test')).toBe(true);
    const audit = auditGuardInventory(inventoryOf([selfTestOnly]), { exemptions: [] });
    expect(audit.ok, 'a self-test-only host must NOT read as reachable').toBe(false);
    expect(audit.violations.join('\n')).toContain('unwired-guard');

    // And on the LIVE tree, the discharged guard is wired by a DIRECT execution
    // — not merely re-classified because its self-test is hosted. Both host
    // kinds are present, and it is the `direct` one that earns `blocks`.
    const record = liveInventory.guards.find(
      (g) => g.artifact === 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    );
    expect(record).toBeDefined();
    expect(record?.runnable).toBe(true);
    expect(record?.hosts.some((h) => h.via === 'self-test')).toBe(true);
    expect(record?.hosts.some((h) => h.via === 'direct')).toBe(true);
    expect(record?.enforcement).toBe('blocks');
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
              through: [],
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
              through: [],
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
              through: [],
              pathFilterKeys: ['mcp'],
              exitSwallowed: false,
              onPullRequest: true,
              blocking: true,
            },
            {
              workflow: CI_WORKFLOW,
              job: 'grep-gates',
              via: 'self-test',
              through: [],
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
              through: [],
              pathFilterKeys: ['root'],
              exitSwallowed: false,
              onPullRequest: true,
              blocking: true,
            },
            {
              workflow: '.github/workflows/release.yml',
              job: 'release',
              via: 'self-test',
              through: [],
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

  it('DirectRunDetection_ExitCodeAssignment_IsAlsoAnEntrypoint', () => {
    // `process.exitCode = …` is the flush-safe spelling of the same entrypoint:
    // `process.exit` can sever stdout before the gate's diagnostics drain. If
    // only the call form counted, adopting the safer spelling would silently
    // demote a real gate to "not a gate" — an absence that reads as compliance.
    const assigned = 'function run(): number { return 1; }\nprocess.exitCode = run();\n';
    expect(hasDirectRunExit(assigned, 'd.ts')).toBe(true);

    // The same containment rules still apply in both directions.
    const insideFn = 'export function run(): void { process.exitCode = 1; }\n';
    expect(hasDirectRunExit(insideFn, 'e.ts')).toBe(false);
    const inProse = ['// process.exitCode = 1 is what a gate would do', 'export {};'].join('\n');
    expect(hasDirectRunExit(inProse, 'f.ts')).toBe(false);
    // …and a READ of exitCode is not an entrypoint — only an assignment is.
    expect(hasDirectRunExit('const c = process.exitCode;\nexport {};\n', 'g.ts')).toBe(false);
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
    //
    // Asserted as a PROPERTY, not as one transcribed filename. This used to pin
    // `output-schema-declaration.ts`, which left the set the moment it earned a
    // co-located self-test (the DR-4 vacuity kill fixtures) — a module GAINING an
    // executable verdict is the outcome this program wants, and it should not
    // redden a test. Same reasoning the R-11 case below states for itself: a name
    // pinned forever asserts a fact the tree is allowed to change.
    expect(
      liveInventory.compileTimeOnlyArtifacts.length,
      'the compile-time-only class resolved empty — the classifier died, or every ' +
        'artifact silently changed rung',
    ).toBeGreaterThan(0);

    // The class must mean what it says: no member may have a co-located self-test,
    // or "compile-time only" has become a label rather than a classification.
    for (const artifact of liveInventory.compileTimeOnlyArtifacts) {
      expect(liveInventory.artifactsWithSelfTest ?? []).not.toContain(artifact);
    }
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

// ─── Indirect hosting: a guard run by a wrapper a run-step runs (task 070) ───
//
// Both kill-fixture directions are required and both are asserted here. An
// indirection rule that answers "reachable" for everything is vacuous, and it is
// the single most likely way to get this wrong — so every case that proves a
// guard IS reachable is paired with one proving a guard is NOT.

describe('Indirect hosting through a wrapper script (DR-24, task 070)', () => {
  const GATE = 'scripts/check-wrapped.mjs';

  it('HostResolution_GuardRunByAWrapperScript_IsReachableAndNamesTheChain', () => {
    // Direction 1 of the kill fixture: hosted ONLY through a wrapper.
    const ctx = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['set -euo pipefail', `node ${GATE}`].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    const hosts = resolveHosts(GATE, ctx);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.via).toBe('direct');
    expect(hosts[0]?.blocking).toBe(true);
    // The verdict names HOW, not merely THAT.
    expect(hosts[0]?.through).toEqual(['scripts/wrapper.sh']);
    expect(hosts.map((h) => describeHost(h))).toEqual(['gates → scripts/wrapper.sh']);
  });

  it('HostResolution_GuardNoWrapperInvokes_IsStillUnreachable', () => {
    // Direction 2, and the one that keeps the rule from being vacuous: the SAME
    // wrapper, the same CI step, a guard it simply does not run.
    const ctx = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['set -euo pipefail', 'node scripts/check-other.mjs'].join('\n'),
      [GATE]: 'process.exit(0);\n',
      'scripts/check-other.mjs': 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, ctx)).toEqual([]);
    // …while the guard the wrapper DOES run is found, so the walk really ran.
    expect(resolveHosts('scripts/check-other.mjs', ctx)).toHaveLength(1);
  });

  it('HostResolution_PathNamedOnlyInAComment_IsNotAnInvocation', () => {
    // The measure-the-wrong-property trap, and it is LIVE rather than synthetic:
    // `validate-no-legacy.sh` writes `scripts/audit/knip-diff.ts` in two comments
    // and never as a literal in a command. Both numbers are asserted, because the
    // whole point is that text-matching and real invocation DISAGREE.
    const wrapper = readFileSync(join(REPO_ROOT, 'scripts/validate-no-legacy.sh'), 'utf8');
    expect(wrapper.includes('scripts/audit/knip-diff.ts'), 'raw text names the guard').toBe(true);
    expect(
      stripShellComments(wrapper).includes('scripts/audit/knip-diff.ts'),
      'and does so ONLY in comments — so a text scan measures prose, not wiring',
    ).toBe(false);

    // A wrapper whose only mention is a comment must report the guard unwired.
    // The fixture carries a `;` INSIDE the comment on purpose. A plain prose
    // mention is not discriminating — the comment's first word is `#`, which is
    // not a command — so a resolver that skipped comment-stripping entirely would
    // still pass it. Split on the `;` the comment becomes a segment whose head is
    // a real interpreter, which is the shape that actually tells the two apart.
    const ctx = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': [`# example: cd repo; node ${GATE} --strict`, 'echo done'].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, ctx)).toEqual([]);
  });

  it('HostResolution_PathAssignedToAVariableButNeverRun_IsNotAnInvocation', () => {
    // Assignment is not execution. Without this, any wrapper that merely names a
    // guard in a variable would launder it into "reachable".
    const assignedOnly = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', 'GATE="$SCRIPT_DIR/check-wrapped.mjs"', 'echo skipping'].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, assignedOnly)).toEqual([]);

    // Same assignment, now actually invoked through the variable — the real
    // `KNIP_DIFF` shape. This is the pair that proves the rule discriminates.
    const invoked = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', 'GATE="$SCRIPT_DIR/check-wrapped.mjs"', 'node "$GATE" --strict'].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, invoked).map((h) => h.through)).toEqual([['scripts/wrapper.sh']]);
  });

  it('HostResolution_WrapperChain_IsWalkedTransitivelyAndReportedInOrder', () => {
    // The bound is on LANGUAGE, not depth: `.sh` wrappers are followed as far as
    // they go, terminating on the `seen` set.
    const ctx = contextOf(workflowRunning('bash scripts/outer.sh'), {
      'scripts/outer.sh': 'bash scripts/inner.sh\n',
      'scripts/inner.sh': `node ${GATE}\n`,
      [GATE]: 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, ctx).map((h) => h.through)).toEqual([['scripts/outer.sh', 'scripts/inner.sh']]);
  });

  it('HostResolution_MutuallyRecursiveWrappers_Terminate', () => {
    const walk = resolveShellExecutions('scripts/a.sh', (path) =>
      ({
        'scripts/a.sh': 'bash scripts/b.sh\n',
        'scripts/b.sh': `bash scripts/a.sh\nnode ${GATE}\n`,
        [GATE]: 'process.exit(0);\n',
      })[path] ?? null,
    );
    expect(walk.scriptsWalked).toEqual(['scripts/a.sh', 'scripts/b.sh']);
    expect(walk.executions.map((e) => e.target)).toContain(GATE);
  });

  it('HostResolution_DataArgumentOfAnInterpretedTool_IsNotAnExecutedProgram', () => {
    // `npx eslint --print-config <file>` READS the file. Counting every argument
    // of an interpreter as a program reported `orchestrate/composite.ts` as an
    // executed guard — a false "reachable" found while building this resolver.
    const walk = resolveShellExecutions('scripts/wrapper.sh', (path) =>
      ({
        'scripts/wrapper.sh': `npx --no-install eslint --print-config ${GATE}\n`,
        [GATE]: 'process.exit(0);\n',
      })[path] ?? null,
    );
    expect(walk.executions.map((e) => e.target)).toEqual([]);

    // …but a genuine interpreter chain still resolves its program.
    const chained = resolveShellExecutions('scripts/wrapper.sh', (path) =>
      ({
        'scripts/wrapper.sh': 'npx --no-install tsx scripts/gate.ts\n',
        'scripts/gate.ts': 'process.exit(0);\n',
      })[path] ?? null,
    );
    expect(chained.executions.map((e) => e.target)).toEqual(['scripts/gate.ts']);
  });

  it('HostResolution_ContinuationLineArgument_IsNotACommandHead', () => {
    // A defect found by running this resolver over the real tree: without joining
    // `\`-continuations, the second physical line of a wrapped `grep` puts its
    // operand in command position, and `AGENTS.md` reported as an executed program.
    const joined = joinShellContinuations('grep -q x \\\n  AGENTS.md\n').trimEnd();
    expect(joined.split('\n'), 'the two physical lines become one logical line').toHaveLength(1);
    expect(shellWords(joined)).toEqual(['grep', '-q', 'x', 'AGENTS.md']);
    const walk = resolveShellExecutions('scripts/wrapper.sh', (path) =>
      ({
        'scripts/wrapper.sh': `HITS=$(grep -inE "x" \\\n  ${GATE} 2>/dev/null || true)\n`,
        [GATE]: 'process.exit(0);\n',
      })[path] ?? null,
    );
    expect(walk.executions.map((e) => e.target)).toEqual([]);
  });

  it('HostResolution_GuardRunByItsOwnSelfTestWrapper_StaysSelfTestNotDirect', () => {
    // Task 063's load-bearing distinction, preserved across the new channel. A
    // gate executed by its own `.test.sh` runs against seeded fixtures, not the
    // repo — so it must NOT be promoted to `direct`, or an unwired gate whose
    // self-test happens to invoke it would report as wired.
    const ctx = contextOf(workflowRunning('bash scripts/check-wrapped.test.sh'), {
      'scripts/check-wrapped.test.sh': `node ${GATE} || true\n`,
      [GATE]: 'process.exit(0);\n',
    });
    const hosts = resolveHosts(GATE, ctx);
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.map((h) => h.via), 'no host may be promoted to `direct`').not.toContain('direct');
    // …so the gate reads as UNREACHABLE, exactly as it did before task 070.
    expect(hosts.every((h) => !isEnforcingHost(h, true))).toBe(true);
  });
});

describe('The indirection resolver is itself measured (non-empty denominator)', () => {
  it('GuardInventory_IndirectionWalkThatWalkedNothing_FailsClosed', () => {
    const noSteps = auditGuardInventory(
      inventoryOf([guard({ artifact: 'scripts/check-a.mjs', enforcement: 'blocks' })], walkedSomething({ runStepsWalked: 0 })),
      { exemptions: [] },
    );
    expect(noSteps.ok).toBe(false);
    expect(noSteps.violations.join('\n')).toContain('[empty-indirection-walk]');
    expect(noSteps.violations.join('\n')).toContain('ZERO `run:` steps');

    const noWrappers = auditGuardInventory(
      inventoryOf([guard({ artifact: 'scripts/check-a.mjs', enforcement: 'blocks' })], walkedSomething({ wrapperScriptsWalked: [] })),
      { exemptions: [] },
    );
    expect(noWrappers.ok).toBe(false);
    expect(noWrappers.violations.join('\n')).toContain('ZERO wrapper scripts');
  });

  it('GuardInventory_LiveIndirectionWalk_IsGenuinelyNonEmpty', () => {
    // The criterion above is not satisfied by a walk that happens to find nothing.
    expect(liveInventory.indirection.runStepsWalked).toBeGreaterThan(50);
    expect(liveInventory.indirection.wrapperScriptsWalked.length).toBeGreaterThan(5);
    expect(liveInventory.indirection.wrapperScriptsWalked).toContain('scripts/validate-no-legacy.sh');
  });

  it('GuardInventory_ContextWithoutAScriptReader_ResolvesNoIndirectionAtAll', () => {
    // The fail-closed shape: no reader means the walk cannot happen, and the audit
    // says so rather than reporting a clean inventory built on an unwalked tree.
    const index = indexShellIndirection({
      workflows: [workflowRunning('bash scripts/wrapper.sh')],
      rootPkg: { dir: '', scripts: {} },
      mcpPkg: { dir: 'servers/exarchos-mcp', scripts: {} },
      suites: loadSuiteConfigs(),
      exists: () => true,
    });
    expect(index.runStepsWalked).toBeGreaterThan(0);
    expect(index.wrapperScriptsWalked).toEqual([]);
  });
});

describe('The live chain this task was dispatched against', () => {
  it('GuardInventory_KnipDiff_IsReachableThroughValidateNoLegacy', () => {
    const record = liveInventory.guards.find((g) => g.artifact === 'scripts/audit/knip-diff.ts');
    expect(record, 'knip-diff.ts must stay IN the inventory — the denominator was not narrowed').toBeDefined();
    expect(record?.channels, 'still discovered by the spec `**Files:**` channel').toContain('wave1-spec');
    expect(record?.enforcement).toBe('blocks');

    // The verdict names the real chain: job → wrapper → guard.
    const enforcing = (record?.hosts ?? []).filter((h) => h.via === 'direct');
    expect(enforcing.map((h) => describeHost(h))).toEqual([
      'validate-no-legacy → scripts/validate-no-legacy.sh',
    ]);

    // …and it is NOT excused by an exemption, which would have been a wiring lie.
    expect(GUARD_EXEMPTIONS.map((e) => e.artifact)).not.toContain('scripts/audit/knip-diff.ts');
  });

  it('GuardInventory_ManifestDrivenRunner_IsNotTreatedAsAHost', () => {
    // The header claims following `run-validate.mjs` would be WRONG rather than
    // merely unimplemented, because `ci.yml` invokes it as `--list`. That claim is
    // checked here instead of asserted in prose (task 066's lesson: a claim no
    // instrument reads is a claim that can be false).
    const ciText = readFileSync(join(REPO_ROOT, CI_WORKFLOW), 'utf8');
    const invocations = ciText.split('\n').filter((line) => line.includes('run-validate.mjs'));
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.every((line) => line.includes('--list'))).toBe(true);

    // So no guard may claim reachability through the manifest runner.
    for (const record of liveInventory.guards) {
      for (const host of record.hosts) {
        expect(host.through, `${record.artifact} claims a host through the manifest runner`).not.toContain(
          'scripts/run-validate.mjs',
        );
      }
    }
  });

  it('GuardInventory_IndirectionDidNotMakeEverythingReachable', () => {
    // The whole-inventory form of kill-fixture direction 2 — that the shell
    // indirection channel resolves real wiring rather than blessing everything
    // it walks.
    //
    // This test used to hold `cli-derivation-guard` as its live unreachable
    // subject: if indirection had over-reached, the set would have emptied and
    // the suite would still be green. Task 076 wired that guard, so the set IS
    // empty now — Wave 1's last unwired guard is discharged. An empty set is the
    // GOAL, but it is also indistinguishable from a resolver that says
    // "reachable" to everything, which is precisely what this test existed to
    // rule out. So the falsifier is re-seeded rather than retired.
    const unreachable = liveInventory.guards.filter((g) => g.enforcement === 'unreachable');
    expect(
      unreachable.map((g) => g.artifact),
      'Wave 1 exit: no guard is unreachable — see GUARD_EXEMPTIONS for the discharge record',
    ).toEqual([]);

    // The seeded proof that "empty" means "checked": an unwired guard added to
    // the LIVE inventory still reads unreachable and still fails the audit. The
    // resolver has not learned to say yes to everything.
    const seeded = guard({ artifact: 'servers/exarchos-mcp/scripts/never-wired.ts', runnable: true });
    const seededAudit = auditGuardInventory(
      inventoryOf([...liveInventory.guards, seeded], liveInventory.indirection),
      { manifestJson: liveManifest, filterGlobs: liveFilterGlobs, exemptions: [] },
    );
    expect(seededAudit.ok).toBe(false);
    expect(seededAudit.violations.join('\n')).toContain('servers/exarchos-mcp/scripts/never-wired.ts');
    expect(seededAudit.violations.join('\n')).toContain('unwired-guard');
  });
});

describe('Shell parsing units the indirection rests on', () => {
  it('ShellComments_HashInsideQuotesOrAParameterExpansion_IsNotAComment', () => {
    expect(stripShellComments('echo hi # trailing\n').trim()).toBe('echo hi');
    expect(stripShellComments('echo "a # b"\n').trim()).toBe('echo "a # b"');
    expect(stripShellComments('echo "${x#pre}"\n').trim()).toBe('echo "${x#pre}"');
    expect(stripShellComments('echo $#\n').trim()).toBe('echo $#');
  });

  it('ShellWords_QuotesAreRemovedButVariablesSurvive', () => {
    expect(shellWords('"$TSX_BIN" "$KNIP_DIFF" --include "a,b"')).toEqual([
      '$TSX_BIN',
      '$KNIP_DIFF',
      '--include',
      'a,b',
    ]);
  });

  it('ShellSegments_PipelinesAndAndListsSplitIntoCommands', () => {
    expect(shellCommandSegments('grep -q x f | node gate.mjs').map((s) => s.trim())).toEqual([
      'grep -q x f',
      'node gate.mjs',
    ]);
    expect(shellCommandSegments('a && b || c ; d').map((s) => s.trim())).toEqual(['a', 'b', 'c', 'd']);
    expect(shellCommandSegments('echo "a && b"').map((s) => s.trim())).toEqual(['echo "a && b"']);
  });

  it('ShellInterpreters_MissingEntryFailsTowardUnreachable', () => {
    // The one hand-written list in this module. It is safe only because an
    // omission causes a FALSE UNREACHABLE (a reported hole) and never a false
    // reachable, so this pins the direction rather than the membership.
    expect(SHELL_INTERPRETERS).toContain('bash');
    expect(SHELL_INTERPRETERS).toContain('node');
    expect(SHELL_INTERPRETERS).not.toContain('grep');
    const walk = resolveShellExecutions('scripts/wrapper.sh', (path) =>
      ({
        'scripts/wrapper.sh': 'perl scripts/gate.mjs\n',
        'scripts/gate.mjs': 'process.exit(0);\n',
      })[path] ?? null,
    );
    expect(walk.executions.map((e) => e.target), 'an unlisted interpreter hides the call').toEqual([]);
  });
});
