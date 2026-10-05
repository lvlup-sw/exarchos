/**
 * The proof of the guard inventory, `tools/audit/gates/guard-inventory.ts`.
 * The module is a library, so this file is the guard. CI runs it in the unfiltered `grep-gates` job.
 *
 * The first three suites hold the acceptance criteria:
 *   1. CI reaches each guard, or the guard carries a reason that expires.
 *   2. The audit reports path-filtered hosting.
 *   3. An inventory of zero guards fails.
 * The other cases are kill fixtures for failure classes of the audit, and unit tests of its derivations.
 *
 * This file is outside the `@oracle-sources` corpus, which does not cover `tests/scripts`.
 * It still compares two independent authorities: the workflow YAML and the guard artifacts on disk.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  MANIFEST_PATH,
  CI_WORKFLOW,
  GUARD_EXEMPTIONS,
  GUARD_SUITE_ROOTS,
  HISTORICAL_PATH_REWRITES,
  resolveHistoricalPath,
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
  isTestArtifact,
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
  scanGuardSuiteRoots,
  scanMcpScriptGates,
  selfTestCandidates,
  SELF_TEST_MIRRORS,
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
} from '../../tools/audit/gates/guard-inventory.js';

/** The inventory of the live tree. All suites share it, because the scan walks the source trees. */
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
 * An index of a walk that examined something. A fixture that varies an unrelated field thus
 * does not trip `[empty-indirection-walk]`.
 * `GuardInventory_IndirectionWalkThatWalkedNothing_FailsClosed` asserts the zero cases.
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

/**
 * Wraps `guards` in an inventory.
 * `entrypointPredicatesScanned` is 1, so a fixture does not trip `[empty-entrypoint-scan]`.
 */
function inventoryOf(
  guards: readonly GuardRecord[],
  indirection: ShellIndirectionIndex = walkedSomething(),
): GuardInventory {
  return {
    guards,
    runnableWithoutSelfTest: [],
    suiteModulesWithoutSelfTest: [],
    compileTimeOnlyArtifacts: [],
    unresolvedSpecArtifacts: [],
    filenameCoupledEntrypoints: [],
    entrypointPredicatesScanned: 1,
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
    suites: loadSuiteConfigs(),
    exists: (path) => Object.hasOwn(files, path),
    readScript: (path) => files[path] ?? null,
  };
  return { ...base, shellIndex: indexShellIndirection(base) };
}

/** A `ci.yml` with the aggregator job and one `gates` job whose single step runs `command`. */
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

describe('Wave-1 guard inventory — CI reachability proof (DR-24, task 063)', () => {
  /**
   * The live proof. CI must run each guard that the discovery channels resolve, or the guard needs a reason that expires.
   * The four named guard families must be present, because an inventory that cannot see them proves nothing about them.
   * `cli-derivation-guard.ts` must block, must not be path-filtered only, must have a direct host and must have no exemption.
   * `blocks` alone is not sufficient, because a path-filtered host skips as passed on the PRs that it polices.
   */
  it('GuardInventory_EveryWave1Guard_IsReachableFromACiJob', () => {
    expect(liveAudit.violations, liveAudit.violations.join('\n')).toEqual([]);
    expect(liveAudit.ok).toBe(true);

    const artifacts = new Set(liveInventory.guards.map((g) => g.artifact));
    for (const named of [
      'src/runtime/agents/dispatch-shape.ts',
      'tools/conformance/src/output-schema-census.ts',
      'tools/audit/core/cli-derivation-guard.ts',
      'tools/conformance/src/authority-topology.ts',
    ]) {
      expect(artifacts, `${named} is missing from the inventory`).toContain(named);
    }

    const cliDerivation = liveInventory.guards.find(
      (g) => g.artifact === 'tools/audit/core/cli-derivation-guard.ts',
    );
    expect(cliDerivation?.enforcement).toBe('blocks');
    expect(cliDerivation?.pathFilteredOnly).toBe(false);
    expect(cliDerivation?.hosts.some((h) => h.via === 'direct')).toBe(true);
    expect(GUARD_EXEMPTIONS.map((e) => e.artifact)).not.toContain(
      'tools/audit/core/cli-derivation-guard.ts',
    );
  });

  /**
   * A runnable guard whose only host is its self-test must not read as reachable.
   * If a hosted self-test counts as a wired guard, an unwired gate reports as enforced.
   * The fixture seeds a record with enforcement `unreachable`, because the live tree has no such guard.
   * On the live tree, `cli-derivation-guard.ts` has both host kinds, and its `direct` host gives it `blocks`.
   */
  it('GuardInventory_SelfTestHostedGateWithNoDirectExecution_ReadsAsUnreachable', () => {
    const selfTestOnly = guard({
      artifact: 'tools/audit/core/example-gate.ts',
      runnable: true,
      hosts: [
        {
          workflow: CI_WORKFLOW,
          job: 'test-mcp',
          via: 'self-test',
          through: [],
          pathFilterKeys: [],
          exitSwallowed: false,
          onPullRequest: true,
          blocking: true,
        },
      ],
      enforcement: 'unreachable',
    });
    expect(selfTestOnly.hosts.length, 'its self-test really is hosted').toBeGreaterThan(0);
    expect(selfTestOnly.hosts.every((h) => h.via === 'self-test')).toBe(true);
    const audit = auditGuardInventory(inventoryOf([selfTestOnly]), { exemptions: [] });
    expect(audit.ok, 'a self-test-only host must NOT read as reachable').toBe(false);
    expect(audit.violations.join('\n')).toContain('unwired-guard');

    const record = liveInventory.guards.find(
      (g) => g.artifact === 'tools/audit/core/cli-derivation-guard.ts',
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

  /**
   * The inventory must hold each live primary of the enforcer manifest, so a new gate cannot stay out of it.
   * A `retired` primary is dead on purpose, and the audit must not demand it.
   */
  it('GuardInventory_ManifestPrimaryAbsentFromTheInventory_Fails', () => {
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
    expect(audit.violations.join('\n')).not.toContain('scripts/check-gone.mjs');
  });
});

describe('Path-filtered hosting (#1711 skipped-as-passed)', () => {
  /**
   * The live audit must name each guard that only path-filtered jobs host, and each must carry a filter key.
   * `layer-boundaries-seam.ts` is the named live instance.
   * The seeded guard has its source outside the filter and no unfiltered `pull_request` host, so the audit must fail it.
   */
  it('GuardInventory_PathFilteredGuard_IsReportedNotSilentlyAccepted', () => {
    expect(liveAudit.pathFilteredOnly.length).toBeGreaterThan(0);
    for (const artifact of liveAudit.pathFilteredOnly) {
      const record = liveInventory.guards.find((g) => g.artifact === artifact);
      expect(record, `${artifact} is reported filtered but absent from the inventory`).toBeDefined();
      const keys = new Set(record?.hosts.flatMap((h) => [...h.pathFilterKeys]) ?? []);
      expect(keys.size, `${artifact} reported filtered with no derived filter key`).toBeGreaterThan(0);
    }

    expect(liveAudit.pathFilteredOnly).toContain(
      'src/architecture/layer-boundaries-seam.ts',
    );

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

  /**
   * The `.test.sh` re-assert pattern: a filtered job enforces the guard, and an unfiltered job runs its self-test.
   * A PR that touches the source of the guard thus still starts a job that runs it.
   */
  it('GuardInventory_FilteredGuardReassertedOnAnUnfilteredPrHost_Passes', () => {
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
      { exemptions: [], filterGlobs: { mcp: ['src/**'] } },
    );
    expect(audit.violations.join('\n')).not.toContain('[implementation-surface-outside-filter]');
    expect(audit.pathFilteredOnly).toEqual(['scripts/check-reasserted.mjs']);
  });

  /**
   * The second host is a release job: unfiltered, but with no `pull_request` trigger.
   * It runs after the merge, so it must not clear the finding.
   */
  it('GuardInventory_ReleaseLaneUnfilteredHost_DoesNotCountAsPreMergeCoverage', () => {
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

describe('Non-empty denominator', () => {
  /**
   * The live inventory and the live manifest must also be non-empty.
   * An inventory that finds nothing must not satisfy this criterion.
   */
  it('GuardInventory_ZeroGuardsResolved_FailsClosed', () => {
    const audit = auditGuardInventory(inventoryOf([]), { exemptions: [] });
    expect(audit.ok).toBe(false);
    expect(audit.violations.join('\n')).toContain('[empty-inventory]');

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

/**
 * Channel 4 finds the conformance suite from the tree.
 * `RELOCATING_CENSUSES` names three censuses by hand, because a derived list comes from the mechanism under test.
 */
describe('Guard-suite discovery (channel 4)', () => {
  const RELOCATING_CENSUSES = [
    'tools/conformance/src/output-schema-census.ts',
    'tools/conformance/src/report-coupling-census.ts',
    'tools/conformance/src/authority-census.ts',
  ];

  /**
   * With an empty spec text, channel 2 discovers nothing, which is the effect of a relocation on that channel.
   * Channel 4 must still discover each named census, and each must still block.
   * The control asserts that channel 2 is dark, so the spec did not supply the result.
   */
  it('GuardSuite_WithTheSpecChannelDark_StillDiscoversEveryConformanceCensus', () => {
    const withoutSpec = buildGuardInventory({ specText: '' });
    const artifacts = new Set(withoutSpec.guards.map((g) => g.artifact));

    for (const census of RELOCATING_CENSUSES) {
      expect(artifacts.has(census), `${census} is discovered without the spec channel`).toBe(true);
      const record = withoutSpec.guards.find((g) => g.artifact === census);
      expect(record?.channels).toContain('conformance-suite');
      expect(record?.enforcement, `${census} enforcement`).toBe('blocks');
    }

    expect(withoutSpec.guards.some((g) => g.channels.includes('wave1-spec'))).toBe(false);
  });

  /**
   * The spec paths of these censuses do not resolve, so `conformance-suite` is the only channel that finds them.
   * If another channel later covers `tools/conformance/`, this test fails toward more coverage.
   * The control asserts that the spec channel still finds other guards, so channel 2 is not broken outright.
   * When the planning corpus is not mounted, the in-repo fallback supplies the spec.
   */
  it('GuardSuite_AfterTheRelocation_IsTheSoleSurvivingChannel', () => {
    for (const census of RELOCATING_CENSUSES) {
      const record = liveInventory.guards.find((g) => g.artifact === census);
      expect(record?.channels, `${census} channels`).toEqual(['conformance-suite']);
    }
    expect(liveInventory.guards.some((g) => g.channels.includes('wave1-spec'))).toBe(true);
  });

  it('GuardSuite_RootThatCannotBeRead_ThrowsRatherThanContributingZero', () => {
    expect(() => scanGuardSuiteRoots(join(REPO_ROOT, 'no-such-repo-root'))).toThrow(/cannot be enumerated/);
  });

  /**
   * `bindings/` is a readable directory of six modules with no self-test, so its guard count is zero.
   * Such a root must throw.
   */
  it('GuardSuite_RootThatMatchesNothing_ThrowsRatherThanShrinkingTheInventory', () => {
    expect(() =>
      scanGuardSuiteRoots(REPO_ROOT, ['tools/conformance/src/bindings']),
    ).toThrow(/contributed ZERO guards/);
  });

  /**
   * A loop over zero roots raises nothing, so the per-root checks pass on an empty list.
   * The scan must throw for it.
   */
  it('GuardSuite_EmptyRootList_ThrowsRatherThanContributingNothing', () => {
    expect(() => scanGuardSuiteRoots(REPO_ROOT, [])).toThrow(/roots are EMPTY/);
  });

  /**
   * A census that loses its self-test must appear in a report.
   * If it leaves the population silently, a deleted test deletes a guard.
   * A module cannot be in both lists.
   */
  it('GuardSuite_ModuleWithoutSelfTest_IsReportedNotSilentlyDropped', () => {
    const scan = scanGuardSuiteRoots();
    expect(scan.modulesWithoutSelfTest).toContain(
      'tools/conformance/src/bindings/registry.ts',
    );
    expect(liveInventory.suiteModulesWithoutSelfTest).toEqual(scan.modulesWithoutSelfTest);
    const guards = new Set(scan.modulesWithSelfTest);
    expect(scan.modulesWithoutSelfTest.filter((m) => guards.has(m))).toEqual([]);
  });

  /**
   * A relocation edits `GUARD_SUITE_ROOTS`, so a stale entry is the likely failure of this channel.
   * Each root must scan without a throw.
   */
  it('GuardSuite_DeclaredRoots_AllExistOnDisk', () => {
    expect(GUARD_SUITE_ROOTS.length).toBeGreaterThan(0);
    for (const root of GUARD_SUITE_ROOTS) {
      expect(() => scanGuardSuiteRoots(REPO_ROOT, [root]), `${root} is a live root`).not.toThrow();
    }
  });
});

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
    expect(isPathShaped('src/runtime/agents/dispatch-shape.ts')).toBe(true);
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

  /** A text scan matches `process.exit` in a comment or a string. The parser finds a call only in code. */
  it('DirectRunDetection_ExitNamedOnlyInACommentOrString_IsNotAnEntrypoint', () => {
    const decoy = ['// process.exit(1) is what a gate would do', "const help = 'process.exit(1)';", 'export {};'].join(
      '\n',
    );
    expect(hasDirectRunExit(decoy, 'c.ts')).toBe(false);
  });

  it('DirectRunDetection_UnparseableSource_ThrowsRatherThanReadingAsNotAGate', () => {
    expect(() => hasDirectRunExit('function ( { ] )', 'broken.ts')).toThrow(/parse error/);
  });

  /**
   * A scan of static imports alone reports a module that the entry point loads with `await import(...)`
   * as one with no production caller.
   */
  it('ImportScan_DynamicImport_IsCountedAsAProductionCaller', () => {
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

  /**
   * `--project` names a project, not a file.
   * If the parser reads it as a file filter, each guard of the root suite loses its host.
   */
  it('VitestInvocation_ProjectSelectorsAndPathOperands_AreParsedApart', () => {
    expect(vitestProjectSelectors(' --project unit --project integration')).toEqual(['unit', 'integration']);
    expect(vitestPathOperands(' --project unit --project integration')).toEqual([]);
    expect(vitestPathOperands(' tests/scripts/ci-topology.test.ts')).toEqual(['tests/scripts/ci-topology.test.ts']);
  });

  it('GlobMatch_DoubleStarCrossesSeparators_SingleStarDoesNot', () => {
    expect(globMatches('scripts/**/*.test.ts', 'scripts/a/b/c.test.ts')).toBe(true);
    expect(globMatches('scripts/**/*.test.ts', 'scripts/c.test.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(globMatches('src/**', 'src/x.ts')).toBe(true);
    expect(globMatches('src/**', 'tools/audit/gates/lint-inv6.mjs')).toBe(false);
    expect(globMatches('AGENTS.md', 'AGENTS.md')).toBe(true);
  });

  /** The repository has one suite. A collected test must resolve to it, and any other path must resolve to null. */
  it('SuiteResolution_EveryCollectedTest_ResolvesToTheOneSuite', () => {
    const suites = loadSuiteConfigs();
    expect(suiteForTest('src/runtime/agents/dispatch-shape.test.ts', suites)?.suite).toBe('root');
    expect(suiteForTest('tests/scripts/ci-topology.test.ts', suites)?.suite).toBe('root');
    expect(suiteForTest('docs/whatever.md', suites)).toBeNull();
  });

  /**
   * The suites live under `tests/`, and the gates live under `tools/audit/` and `src/`.
   * The pairing constructs the path, so without a mirror entry a lookup finds nothing and reports "no self-test".
   * The last assertion reads the disk, because a list of correct paths that do not exist pairs nothing.
   */
  it('SelfTestPairing_GateUnderScripts_IsFoundInTheRelocatedTestTree', () => {
    expect(selfTestCandidates('tools/audit/gates/check-type-debt.mjs')).toContain(
      'tests/scripts/check-type-debt.test.sh',
    );
    expect(selfTestCandidates('tools/audit/core/cli-vocab-guard.ts')).toContain(
      'tests/core/scripts/cli-vocab-guard.test.ts',
    );
    expect(selfTestCandidates('src/foo/bar.ts')).toContain('tests/unit/foo/bar.test.ts');

    const paired = ['tools/audit/gates/check-type-debt.mjs', 'tools/audit/gates/check-coverage-ratchet.mjs']
      .map((gate) => selfTestCandidates(gate).filter((c) => existsSync(join(REPO_ROOT, c))))
      .filter((found) => found.length > 0);
    expect(paired.length, 'no gate under scripts/ pairs with a real self-test').toBe(2);
  });

  /**
   * A mirror entry whose source tree moved still returns candidate paths, but the files do not exist.
   * An unpaired artifact reads as "no self-test" and not as an error, so each entry must pair one real file.
   */
  it('GuardInventory_EverySelfTestMirror_PairsSomethingReal', () => {
    for (const [from, to] of SELF_TEST_MIRRORS) {
      const sourceDir = join(REPO_ROOT, from);
      expect(existsSync(sourceDir), `mirror source ${from} does not exist`).toBe(true);

      const artifacts = readdirSync(sourceDir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.([cm]?[jt]s|sh)$/.test(e.name))
        .map((e) => `${from}${e.name}`)
        .filter((rel) => !isTestArtifact(rel));

      const pairs = artifacts.filter((rel) =>
        selfTestCandidates(rel).some((c) => existsSync(join(REPO_ROOT, c))),
      );
      expect(pairs.length, `mirror ${from} → ${to} pairs nothing on disk`).toBeGreaterThan(0);
    }
  });

  /** The workflow does not name the guard. Two npm scripts lie between the step and the guard. */
  it('HostResolution_NpmScriptChain_IsWalkedTransitively', () => {
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
      suites: loadSuiteConfigs(),
      exists: () => false,
    };
    const hosts = resolveHosts('scripts/check-orphan.mjs', ctx);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.blocking).toBe(false);
  });
});

describe('Exclusions stay reviewable', () => {
  /**
   * `stryker-adapter.mjs` is runnable, but it has no self-test, so it is not a guard.
   * The inventory must report the exclusion.
   */
  it('GuardInventory_RunnableModuleWithNoSelfTest_IsReportedNotDroppedSilently', () => {
    expect(liveInventory.runnableWithoutSelfTest).toContain('tools/audit/core/stryker-adapter.mjs');
  });

  /**
   * `tsc` enforces these modules and no CI step runs them, so execution reachability does not apply to them.
   * The test asserts a property and pins no file name, because a module can gain a self-test and leave the set.
   * No member can also be a guard, because each guard has a self-test.
   */
  it('GuardInventory_CompileTimeOnlyWave1Artifacts_AreReported', () => {
    expect(
      liveInventory.compileTimeOnlyArtifacts.length,
      'the compile-time-only class resolved empty — the classifier died, or every ' +
        'artifact silently changed rung',
    ).toBeGreaterThan(0);

    const withSelfTest = liveInventory.guards.map((g) => g.artifact);
    expect(withSelfTest.length, 'no guard carries a self-test — the denominator is empty').toBeGreaterThan(0);
    for (const artifact of liveInventory.compileTimeOnlyArtifacts) {
      expect(withSelfTest).not.toContain(artifact);
    }
  });

  /**
   * These guards run through their vitest, and nothing in production calls them.
   * The set must stay non-empty. A guard that gains a production caller leaves the set, so the test pins one name only.
   */
  it('GuardInventory_R11GuardsWithNoProductionCaller_AreNamed', () => {
    expect(liveAudit.noProductionCaller.length).toBeGreaterThan(0);
    expect(liveAudit.noProductionCaller).toContain('tools/audit/gates/guard-inventory.ts');
  });
});

/**
 * A wrapper script that a run-step runs can host a guard.
 * A rule that answers "reachable" for each guard is vacuous, so each reachable case has an unreachable pair.
 */
describe('Indirect hosting through a wrapper script (DR-24, task 070)', () => {
  const GATE = 'scripts/check-wrapped.mjs';

  /** Direction 1: only a wrapper hosts the guard. The host must name the wrapper chain, not only the job. */
  it('HostResolution_GuardRunByAWrapperScript_IsReachableAndNamesTheChain', () => {
    const ctx = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['set -euo pipefail', `node ${GATE}`].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    const hosts = resolveHosts(GATE, ctx);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.via).toBe('direct');
    expect(hosts[0]?.blocking).toBe(true);
    expect(hosts[0]?.through).toEqual(['scripts/wrapper.sh']);
    expect(hosts.map((h) => describeHost(h))).toEqual(['gates → scripts/wrapper.sh']);
  });

  /**
   * Direction 2: the same wrapper and the same step, but the wrapper does not run this guard.
   * The walk finds the guard that the wrapper does run, which proves that the walk ran.
   */
  it('HostResolution_GuardNoWrapperInvokes_IsStillUnreachable', () => {
    const ctx = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['set -euo pipefail', 'node scripts/check-other.mjs'].join('\n'),
      [GATE]: 'process.exit(0);\n',
      'scripts/check-other.mjs': 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, ctx)).toEqual([]);
    expect(resolveHosts('scripts/check-other.mjs', ctx)).toHaveLength(1);
  });

  /**
   * `validate-no-legacy.sh` names `tools/audit/knip-diff.ts` only in comments, so a text scan measures prose and not wiring.
   * The seeded comment holds a semicolon on purpose. A split on it gives a segment that starts with a real interpreter.
   * A resolver that strips no comments then reports the guard as run.
   */
  it('HostResolution_PathNamedOnlyInAComment_IsNotAnInvocation', () => {
    const wrapper = readFileSync(join(REPO_ROOT, 'tools/audit/gates/validate-no-legacy.sh'), 'utf8');
    expect(wrapper.includes('tools/audit/knip-diff.ts'), 'raw text names the guard').toBe(true);
    expect(
      stripShellComments(wrapper).includes('tools/audit/knip-diff.ts'),
      'and does so ONLY in comments — so a text scan measures prose, not wiring',
    ).toBe(false);

    const ctx = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': [`# example: cd repo; node ${GATE} --strict`, 'echo done'].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, ctx)).toEqual([]);
  });

  /**
   * An assignment is not an execution.
   * The second fixture runs the guard through the same variable, which proves that the rule discriminates.
   */
  it('HostResolution_PathAssignedToAVariableButNeverRun_IsNotAnInvocation', () => {
    const assignedOnly = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', 'GATE="$SCRIPT_DIR/check-wrapped.mjs"', 'echo skipping'].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, assignedOnly)).toEqual([]);

    const invoked = contextOf(workflowRunning('bash scripts/wrapper.sh'), {
      'scripts/wrapper.sh': ['SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', 'GATE="$SCRIPT_DIR/check-wrapped.mjs"', 'node "$GATE" --strict'].join('\n'),
      [GATE]: 'process.exit(0);\n',
    });
    expect(resolveHosts(GATE, invoked).map((h) => h.through)).toEqual([['scripts/wrapper.sh']]);
  });

  /** The walk follows `.sh` wrappers to any depth. It stops at a script that it already visited. */
  it('HostResolution_WrapperChain_IsWalkedTransitivelyAndReportedInOrder', () => {
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

  /**
   * `npx eslint --print-config <file>` reads the file and does not run it.
   * A real interpreter chain such as `npx tsx <file>` still resolves its program.
   */
  it('HostResolution_DataArgumentOfAnInterpretedTool_IsNotAnExecutedProgram', () => {
    const walk = resolveShellExecutions('scripts/wrapper.sh', (path) =>
      ({
        'scripts/wrapper.sh': `npx --no-install eslint --print-config ${GATE}\n`,
        [GATE]: 'process.exit(0);\n',
      })[path] ?? null,
    );
    expect(walk.executions.map((e) => e.target)).toEqual([]);

    const chained = resolveShellExecutions('scripts/wrapper.sh', (path) =>
      ({
        'scripts/wrapper.sh': 'npx --no-install tsx scripts/gate.ts\n',
        'scripts/gate.ts': 'process.exit(0);\n',
      })[path] ?? null,
    );
    expect(chained.executions.map((e) => e.target)).toEqual(['scripts/gate.ts']);
  });

  /**
   * The resolver must join backslash continuations.
   * If it does not, the operand on the second physical line reads as a command.
   */
  it('HostResolution_ContinuationLineArgument_IsNotACommandHead', () => {
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

  /**
   * A `.test.sh` runs its gate against seeded fixtures and not against the repository.
   * Such a host must stay `self-test`. If it becomes `direct`, an unwired gate reports as wired.
   */
  it('HostResolution_GuardRunByItsOwnSelfTestWrapper_StaysSelfTestNotDirect', () => {
    const ctx = contextOf(workflowRunning('bash scripts/check-wrapped.test.sh'), {
      'scripts/check-wrapped.test.sh': `node ${GATE} || true\n`,
      [GATE]: 'process.exit(0);\n',
    });
    const hosts = resolveHosts(GATE, ctx);
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.map((h) => h.via), 'no host may be promoted to `direct`').not.toContain('direct');
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

  /**
   * The live walk must examine real steps and wrappers.
   * A walk that finds nothing must not satisfy the fail-closed rule.
   */
  it('GuardInventory_LiveIndirectionWalk_IsGenuinelyNonEmpty', () => {
    expect(liveInventory.indirection.runStepsWalked).toBeGreaterThan(50);
    expect(liveInventory.indirection.wrapperScriptsWalked.length).toBeGreaterThan(5);
    expect(liveInventory.indirection.wrapperScriptsWalked).toContain('tools/audit/gates/validate-no-legacy.sh');
  });

  /**
   * Without a script reader, the index counts run-steps and walks no wrapper script.
   * The audit fails such an index as an empty walk.
   */
  it('GuardInventory_ContextWithoutAScriptReader_ResolvesNoIndirectionAtAll', () => {
    const index = indexShellIndirection({
      workflows: [workflowRunning('bash scripts/wrapper.sh')],
      rootPkg: { dir: '', scripts: {} },
      suites: loadSuiteConfigs(),
      exists: () => true,
    });
    expect(index.runStepsWalked).toBeGreaterThan(0);
    expect(index.wrapperScriptsWalked).toEqual([]);
  });
});

describe('The live chain this task was dispatched against', () => {
  /**
   * `knip-diff.ts` must stay in the inventory.
   * Its host names the chain from the job to the wrapper, and no exemption covers it.
   */
  it('GuardInventory_KnipDiff_IsReachableThroughValidateNoLegacy', () => {
    const record = liveInventory.guards.find((g) => g.artifact === 'tools/audit/knip-diff.ts');
    expect(record, 'knip-diff.ts must stay IN the inventory — the denominator was not narrowed').toBeDefined();
    expect(record?.channels, 'still discovered by the spec `**Files:**` channel').toContain('wave1-spec');
    expect(record?.enforcement).toBe('blocks');

    const enforcing = (record?.hosts ?? []).filter((h) => h.via === 'direct');
    expect(enforcing.map((h) => describeHost(h))).toEqual([
      'validate-no-legacy → tools/audit/gates/validate-no-legacy.sh',
    ]);

    expect(GUARD_EXEMPTIONS.map((e) => e.artifact)).not.toContain('tools/audit/knip-diff.ts');
  });

  /**
   * `ci.yml` runs `run-validate.mjs` only with `--list`, which runs no step.
   * The test reads `ci.yml` to check that claim. Thus no guard can claim a host through the manifest runner.
   */
  it('GuardInventory_ManifestDrivenRunner_IsNotTreatedAsAHost', () => {
    const ciText = readFileSync(join(REPO_ROOT, CI_WORKFLOW), 'utf8');
    const invocations = ciText.split('\n').filter((line) => line.includes('run-validate.mjs'));
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.every((line) => line.includes('--list'))).toBe(true);

    for (const record of liveInventory.guards) {
      for (const host of record.hosts) {
        expect(host.through, `${record.artifact} claims a host through the manifest runner`).not.toContain(
          'tools/audit/gates/run-validate.mjs',
        );
      }
    }
  });

  /**
   * The live tree has no unreachable guard.
   * An empty set looks the same as a resolver that answers "reachable" for each guard.
   * Thus the test adds a seeded record with enforcement `unreachable` to the live inventory, and the audit must fail it.
   */
  it('GuardInventory_IndirectionDidNotMakeEverythingReachable', () => {
    const unreachable = liveInventory.guards.filter((g) => g.enforcement === 'unreachable');
    expect(
      unreachable.map((g) => g.artifact),
      'Wave 1 exit: no guard is unreachable — see GUARD_EXEMPTIONS for the discharge record',
    ).toEqual([]);

    const seeded = guard({ artifact: 'tools/audit/core/never-wired.ts', runnable: true });
    const seededAudit = auditGuardInventory(
      inventoryOf([...liveInventory.guards, seeded], liveInventory.indirection),
      { manifestJson: liveManifest, filterGlobs: liveFilterGlobs, exemptions: [] },
    );
    expect(seededAudit.ok).toBe(false);
    expect(seededAudit.violations.join('\n')).toContain('tools/audit/core/never-wired.ts');
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

  /**
   * `SHELL_INTERPRETERS` is a hand-written list.
   * An omission gives a false unreachable, which the audit reports, and never a false reachable.
   */
  it('ShellInterpreters_MissingEntryFailsTowardUnreachable', () => {
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

describe('Historical spec paths resolve against the current tree', () => {
  const onDisk = (p: string): boolean => existsSync(join(REPO_ROOT, p));

  /**
   * The spec of channel 2 is frozen, so only these rewrites keep its file lists on real artifacts.
   * Each source path must be absent, or the rule can shadow a live path.
   * Each target must exist, or the rule resolves nothing. The catch-all target is the repository root.
   */
  it('GuardInventory_HistoricalPathRewrites_AllResolve', () => {
    expect(HISTORICAL_PATH_REWRITES.length).toBeGreaterThan(0);
    for (const [from, to] of HISTORICAL_PATH_REWRITES) {
      expect(onDisk(from), `rewrite source ${from} still exists — it is not historical`).toBe(false);
      if (to === '') continue;
      expect(onDisk(to), `rewrite target ${to} (from ${from}) does not exist`).toBe(true);
    }
  });

  /**
   * The `…/src/agents/` rule must win over the `…/src/` rule.
   * If it does not, a moved subtree resolves to a wrong path.
   */
  it('GuardInventory_HistoricalPathRewrites_AreOrderedSpecificBeforeCatchAll', () => {
    expect(resolveHistoricalPath('servers/exarchos-mcp/src/agents/dispatch-shape.ts', onDisk)).toBe(
      'src/runtime/agents/dispatch-shape.ts',
    );
    expect(resolveHistoricalPath('servers/exarchos-mcp/scripts/cli-vocab-guard.ts', onDisk)).toBe(
      'tools/audit/core/cli-vocab-guard.ts',
    );
  });

  /**
   * A path that resolves as written gets no rewrite, so a stale rule cannot mask a later move.
   * A path that resolves nowhere comes back unchanged, and the caller records it as unresolved.
   */
  it('GuardInventory_HistoricalPathRewrites_LeaveALiveCitationAlone', () => {
    expect(resolveHistoricalPath('tools/audit/gates/guard-inventory.ts', onDisk)).toBe('tools/audit/gates/guard-inventory.ts');
    expect(resolveHistoricalPath('servers/exarchos-mcp/src/event-store/gone.ts', onDisk)).toBe(
      'servers/exarchos-mcp/src/event-store/gone.ts',
    );
  });
});
