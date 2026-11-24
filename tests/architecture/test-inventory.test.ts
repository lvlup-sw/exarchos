/**
 * The test inventory that each test move reconciles against.
 *
 * `tsc` and the runner catch a test file that breaks. They do not catch a file that a stale
 * include glob drops, because a suite that does not run reports nothing.
 *
 * The identity of a case is `(suite path within the file, test name, runner)`. The file path
 * is metadata. An identity that holds the path changes on each move, which invalidates the
 * whole oracle.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Case = { suite: string; name: string; dynamic: boolean };
type FileEntry = { file: string; runner: string; cases: Case[] };

type Inventory = {
  identity: string;
  countingSemantics: string;
  totals: {
    testFiles: number;
    parsedFiles: number;
    shellFiles: number;
    cases: number;
    dynamicTitles: number;
    unparseableFiles: number;
  };
  unparseable: string[];
  relocations: { from: string; to: string }[];
  files: Record<string, FileEntry>;
};

type Reconciliation = {
  originCommit: string;
  originIds: number;
  currentIds: number;
  renames: { from: string; fromFile: string; to: string; toFile: string; similarity: number }[];
};

const inventory = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/test-inventory-baseline.json'), 'utf8'),
) as Inventory;

/**
 * The one-time audit of the original capture against the consolidated tree. It records each
 * renamed case.
 */
const reconciliation = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/test-inventory-reconciliation.json'), 'utf8'),
) as Reconciliation;

const fileEntries = Object.values(inventory.files);

/** The id used for reconciliation — deliberately free of the file path. */
const idOf = (entry: FileEntry, c: Case): string => `${entry.runner}::${c.suite}::${c.name}`;

/** The pattern for what the inventory counts as a test file. */
const IS_TEST_FILE = /\.(test|spec|bench)\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$|\.test\.sh$/;

/**
 * The test files that git tracks. Discovery reads the tracked files by extension and uses no
 * runner glob, because a stale glob drops files with no error.
 */
async function trackedTestFiles(): Promise<string[]> {
  return (
    await execFileAsync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
    })
  )
    .split('\0')
    .filter((rel) => IS_TEST_FILE.test(rel));
}

/**
 * Returns the baseline paths that are lost. A path is accounted for when git tracks it, or
 * when its relocation chain ends at a tracked path. The check and its kill probe both call
 * this function, so the probe cannot pass while the check is broken.
 *
 * The relocation ledger is append-only: a file that moves twice has two entries. Thus the
 * walk follows each hop to the end of the chain. The `seen` set stops the walk on a cycle,
 * which a ledger can hold by mistake.
 */
function unaccountedFor(
  baselinePaths: readonly string[],
  current: ReadonlySet<string>,
  relocations: readonly { from: string; to: string }[],
): string[] {
  const relocated = new Map(relocations.map((r) => [r.from, r.to]));

  const resolve = (start: string): string => {
    let at = start;
    const seen = new Set<string>([at]);
    for (;;) {
      const next = relocated.get(at);
      if (next === undefined || seen.has(next)) return at;
      seen.add(next);
      at = next;
    }
  };

  return baselinePaths.filter((rel) => {
    if (current.has(rel)) return false;
    return !current.has(resolve(rel));
  });
}

/**
 * The roots that the test consolidation emptied. `task` labels the move that emptied each
 * root. Each root must hold zero tracked test files, and each test that started in it must
 * reconcile. The match is by prefix, because `docs/evals` is a subtree and not a top-level
 * root.
 */
const FORMER_TEST_ROOTS: ReadonlyArray<{ prefix: string; task: string }> = [
  { prefix: 'src/', task: '030' },
  { prefix: 'scripts/', task: '031' },
  { prefix: 'test/', task: '032' },
  { prefix: 'benchmarks/', task: '033' },
  { prefix: 'docs/evals/', task: '033' },
  /**
   * `eslint-rules/` and `renovate-config/` moved into `tools/`. `migrations/` moved with them
   * and is absent from this list. It held no test file, so it has no ledger entry, and an
   * entry here fails the empty-denominator check.
   */
  { prefix: 'eslint-rules/', task: '036' },
  { prefix: 'renovate-config/', task: '036' },
];


/**
 * Test files that left with the tool that they tested. A consolidated test ends only by a move or by the
 * deletion of its subject. A row whose path is tracked again, or whose tool still exists, fails the check.
 */
const RETIRED_TEST_FILES: ReadonlyArray<{ path: string; subject: string }> = [
  { path: 'tests/scripts/audit/check-no-duplicate-suites.test.ts', subject: 'tools/audit/check-no-duplicate-suites.mjs' },
  { path: 'tests/scripts/audit/consolidate-suite.test.ts', subject: 'tools/audit/consolidate-suite.mjs' },
  { path: 'tests/scripts/audit/manifest-gate-ci.test.ts', subject: 'tools/audit/manifest-gate-ci.mjs' },
  { path: 'tests/unit/config/loader.test.ts', subject: 'src/config/loader.ts' },
  { path: 'tests/unit/config/guards.test.ts', subject: 'src/config/guards.ts' },
  { path: 'tests/unit/hooks/config-hooks.test.ts', subject: 'src/hooks/config-hooks.ts' },
  { path: 'tests/unit/hooks/config-hooks-integration.test.ts', subject: 'src/hooks/config-hooks.ts' },
  { path: 'tests/unit/events/composite-hooks.test.ts', subject: 'src/hooks/config-hooks.ts' },
  { path: 'tests/scripts/check-mutation-gate.test.sh', subject: 'tools/audit/gates/check-mutation-gate.mjs' },
  { path: 'tests/unit/verbs/stryker-adapter.smoke.test.ts', subject: 'tools/audit/core/stryker-adapter.mjs' },
  { path: 'tests/unit/verbs/gates/mutation-adequacy.test.ts', subject: 'src/verbs/gates/mutation-adequacy.ts' },
  { path: 'tests/unit/verbs/gates/mutation-adequacy.report.test.ts', subject: 'src/verbs/gates/mutation-adequacy.ts' },
  { path: 'tests/unit/verbs/gates/mutation-adequacy.characterization.test.ts', subject: 'src/verbs/gates/mutation-adequacy.ts' },
  { path: 'tests/unit/config/mutation-diff-scope.test.ts', subject: 'src/config/mutation-diff-scope.ts' },
  { path: 'tests/integration/1928-verifier-protocol.test.ts', subject: 'src/runtime/verification-host/claims.ts' },
  { path: 'tests/process/1928-verifier-binary.test.ts', subject: 'src/runtime/verification-host/main.ts' },
  { path: 'tests/process/1928-host-recovery.test.ts', subject: 'src/runtime/verification-host/adequacy.ts' },
  { path: 'tests/unit/dispatch/core/verifier-client.test.ts', subject: 'src/dispatch/core/verifier-client.ts' },
  { path: 'tests/unit/verbs/gates/test-adequacy.test.ts', subject: 'src/verbs/gates/test-adequacy.ts' },
  { path: 'tests/unit/verbs/gates/test-adequacy.false-advisory.test.ts', subject: 'src/verbs/gates/test-adequacy.ts' },
  { path: 'tests/unit/verbs/gates/test-adequacy.handler.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/unit/verbs/gates/test-adequacy.integration.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/unit/verbs/gates/test-adequacy.parity.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/unit/verbs/gates/test-adequacy.production-path.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/unit/verbs/gates/test-adequacy.toolchain-globs.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/unit/verbs/gates/kill-probe-profile.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/acceptance/kill-probe-base.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/acceptance/kill-probe-profile.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/integration/1928-hosted-adequacy.test.ts', subject: 'src/verbs/gates/test-adequacy-handler.ts' },
  { path: 'tests/core/types/run-outcome.type-test.ts', subject: 'src/verbs/gates/test-adequacy.ts' },
  { path: 'tests/unit/adapters/cli/cli-launcher.test.ts', subject: 'src/runtime/launcher/harness-entry.ts' },
  { path: 'tests/process/1928-launch-ownership.test.ts', subject: 'src/runtime/launcher/harness-entry.ts' },
  { path: 'tests/unit/runtime/launcher/channel-probe.test.ts', subject: 'src/runtime/launcher/lifecycle-core.ts' },
  { path: 'tests/unit/runtime/launcher/create-worktree.test.ts', subject: 'src/runtime/launcher/create-worktree.ts' },
  { path: 'tests/unit/runtime/launcher/harness-registry.test.ts', subject: 'src/runtime/launcher/harness-registry.ts' },
  { path: 'tests/unit/runtime/launcher/injection-channel.integration.test.ts', subject: 'src/runtime/launcher/injection-seam.ts' },
  { path: 'tests/unit/runtime/launcher/injection-seam.test.ts', subject: 'src/runtime/launcher/injection-seam.ts' },
  { path: 'tests/unit/runtime/launcher/lifecycle.test.ts', subject: 'src/runtime/launcher/lifecycle-core.ts' },
  { path: 'tests/unit/runtime/launcher/on-ramps.test.ts', subject: 'src/runtime/launcher/harnesses/index.ts' },
  { path: 'tests/unit/runtime/launcher/production-deps.test.ts', subject: 'src/runtime/launcher/production-deps.ts' },
  { path: 'tests/unit/runtime/launcher/signals.test.ts', subject: 'src/runtime/launcher/signals.ts' },
  { path: 'tests/unit/runtime/launcher/single-abstraction.guard.test.ts', subject: 'src/runtime/launcher/harnesses/index.ts' },
  { path: 'tests/unit/runtime/launcher/teardown.test.ts', subject: 'src/runtime/launcher/teardown.ts' },
  { path: 'tests/unit/runtime/launcher/topology.test.ts', subject: 'src/runtime/launcher/topology.ts' },
  { path: 'tests/unit/runtime/launcher/verb.test.ts', subject: 'src/runtime/launcher/verb.ts' },
  { path: 'tests/unit/runtime/launcher/wlm-compose.test.ts', subject: 'src/runtime/launcher/wlm-compose.ts' },
  { path: 'tests/unit/verbs/vcs/add-pr-comment.parity.test.ts', subject: 'src/verbs/vcs/add-pr-comment.ts' },
  { path: 'tests/unit/verbs/vcs/add-pr-comment.test.ts', subject: 'src/verbs/vcs/add-pr-comment.ts' },
  { path: 'tests/unit/verbs/vcs/assess-stack.test.ts', subject: 'src/verbs/vcs/assess-stack.ts' },
  { path: 'tests/integration/shepherd-classifier.integration.test.ts', subject: 'src/verbs/vcs/assess-stack.ts' },
  { path: 'tests/integration/1928-pr-observation.test.ts', subject: 'src/vcs/github-pr-observer.ts' },
  { path: 'tests/unit/verbs/vcs/check-ci.test.ts', subject: 'src/verbs/vcs/check-ci.ts' },
  { path: 'tests/unit/verbs/vcs/check-coderabbit.test.ts', subject: 'src/verbs/vcs/check-coderabbit.ts' },
  { path: 'tests/unit/verbs/vcs/check-pr-comments.test.ts', subject: 'src/verbs/vcs/check-pr-comments.ts' },
  { path: 'tests/unit/verbs/vcs/create-issue.parity.test.ts', subject: 'src/verbs/vcs/create-issue.ts' },
  { path: 'tests/unit/verbs/vcs/create-issue.test.ts', subject: 'src/verbs/vcs/create-issue.ts' },
  { path: 'tests/unit/verbs/vcs/create-pr.parity.test.ts', subject: 'src/verbs/vcs/create-pr.ts' },
  { path: 'tests/unit/verbs/vcs/create-pr.test.ts', subject: 'src/verbs/vcs/create-pr.ts' },
  { path: 'tests/unit/verbs/vcs/get-pr-comments.test.ts', subject: 'src/verbs/vcs/get-pr-comments.ts' },
  { path: 'tests/unit/verbs/vcs/list-prs.test.ts', subject: 'src/verbs/vcs/list-prs.ts' },
  { path: 'tests/unit/verbs/vcs/merge-pr.test.ts', subject: 'src/verbs/vcs/merge-pr.ts' },
  { path: 'tests/unit/verbs/vcs/validate-pr-stack.test.ts', subject: 'src/verbs/vcs/validate-pr-stack.ts' },
  { path: 'tests/unit/vcs/require-github.test.ts', subject: 'src/vcs/require-github.ts' },
  { path: 'tests/unit/verbs/team/setup-worktree.test.ts', subject: 'src/verbs/team/setup-worktree.ts' },
  { path: 'tests/unit/verbs/team/setup-worktree.integration.test.ts', subject: 'src/verbs/team/setup-worktree.ts' },
  { path: 'tests/unit/vcs/worktree-provisioner.test.ts', subject: 'src/vcs/worktree-provisioner.ts' },
  { path: 'tests/unit/verbs/worktree/pure/prune-ladder.test.ts', subject: 'src/verbs/worktree/pure/prune-ladder.ts' },
  { path: 'tests/unit/verbs/worktree/manager.prune.test.ts', subject: 'src/verbs/worktree/pure/prune-ladder.ts' },
  { path: 'tests/unit/adapters/cli/cli-merge-orchestrate.test.ts', subject: 'src/registry/actions/orchestrate/merge.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.api-refire.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.busy.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.integration.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.migration.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.parity-harness.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.parity.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/merge-orchestrate.race.test.ts', subject: 'src/verbs/merge/merge-orchestrate.ts' },
  { path: 'tests/unit/verbs/merge/execute-merge.test.ts', subject: 'src/verbs/merge/execute-merge.ts' },
  { path: 'tests/unit/verbs/merge/execute-merge.deprecation-parity.test.ts', subject: 'src/verbs/merge/execute-merge.ts' },
  { path: 'tests/unit/verbs/merge/execute-merge.migration.test.ts', subject: 'src/verbs/merge/execute-merge.ts' },
  { path: 'tests/core/integration/governance/merge-idempotency.test.ts', subject: 'src/verbs/merge/execute-merge.ts' },
  { path: 'tests/unit/verbs/merge/local-git-merge.test.ts', subject: 'src/verbs/merge/local-git-merge.ts' },
  { path: 'tests/unit/verbs/pure/merge-preflight.test.ts', subject: 'src/verbs/pure/merge-preflight.ts' },
  { path: 'tests/unit/verbs/vcs/git-exec-default.test.ts', subject: 'src/verbs/vcs/git-exec-default.ts' },
  { path: 'tests/unit/verbs/worktree/merge-serializer.test.ts', subject: 'src/verbs/worktree/merge-serializer.ts' },
  { path: 'tests/unit/verbs/worktree/serialize-dryrun.test.ts', subject: 'src/verbs/worktree/merge-serializer.ts' },
  { path: 'tests/unit/verbs/pure/execute-merge.test.ts', subject: 'src/verbs/pure/execute-merge.ts' },
  { path: 'tests/unit/verbs/worktree/git-retry.test.ts', subject: 'src/verbs/worktree/git-retry.ts' },
];

describe('test inventory', () => {
  it('TestInventory_AtBaseline_RecordsEveryDiscoveredTestId', () => {
    expect(inventory.totals.testFiles).toBe(fileEntries.length);
    expect(inventory.totals.cases).toBeGreaterThan(10000);
    expect(inventory.totals.unparseableFiles).toBe(0);
    expect(inventory.unparseable).toEqual([]);
  });

  it('TestInventory_Discovery_FoundEveryTrackedTestFile', async () => {
    const missing = (await trackedTestFiles()).filter((rel) => inventory.files[rel] === undefined);

    expect(missing, 'tracked test files absent from the inventory').toEqual([]);
  });

  /**
   * A file that is gone with no relocation entry must appear by name, not as a count. The
   * comparison is the baseline against the tracked tree. A `current` set that comes from the
   * baseline keys makes `dropped` empty for every input.
   */
  it('TestInventory_MissingFile_NamesTheMissingSource', async () => {
    const dropped = unaccountedFor(
      Object.keys(inventory.files),
      new Set(await trackedTestFiles()),
      inventory.relocations,
    );

    expect(dropped, 'baseline test files neither tracked nor relocated').toEqual([]);
  });

  /** The kill probe for the reconciliation. It calls the same `unaccountedFor` as the check. */
  it('TestInventory_SeededDisappearance_IsReportedByName', async () => {
    const current = new Set(await trackedTestFiles());
    const phantom = 'src/__vanished__.test.ts';

    const missing = unaccountedFor(
      [phantom, ...Object.keys(inventory.files).slice(0, 3)],
      current,
      inventory.relocations,
    );

    expect(missing).toContain(phantom);
  });

  /**
   * Two losses must each give the file name: a file that is gone with no relocation, and a
   * relocation that points at a missing destination. A check of ledger membership alone
   * accepts the second loss. The last assertion is the control: a tracked file reconciles
   * clean.
   */
  it('TestInventory_UnexplainedLoss_NamesTheMissingFileAndBlocks', async () => {
    const current = new Set(await trackedTestFiles());
    const real = Object.keys(inventory.files)[0];
    expect(real, 'the baseline is empty — nothing to reconcile').toBeDefined();

    const vanished = 'tests/unit/__never-existed__.test.ts';
    expect(unaccountedFor([vanished], current, inventory.relocations)).toEqual([vanished]);

    const danglingFrom = 'tests/unit/__moved-nowhere__.test.ts';
    expect(
      unaccountedFor([danglingFrom], current, [
        ...inventory.relocations,
        { from: danglingFrom, to: 'tests/unit/__also-not-here__.test.ts' },
      ]),
      'a relocation pointing at a missing destination was treated as accounted for',
    ).toEqual([danglingFrom]);

    expect(unaccountedFor([real!], current, inventory.relocations)).toEqual([]);
  });

  /**
   * Each former root must hold no tracked test file, and each test that started there must
   * reconcile. Neither condition implies the other.
   *
   * The population is the `from` side of the relocation ledger, filtered to test files. The
   * baseline `files` map holds only the paths after the moves, so a filter by a former root
   * gives nothing. The ledger also holds fixtures and other non-test files, which the test
   * discovery cannot see. A root with no ledger entry fails, because an empty population
   * proves nothing.
   */
  it('TestInventory_AfterFullConsolidation_ReconcilesAgainstBaseline', async () => {
    const current = new Set(await trackedTestFiles());
    const tracked = await trackedTestFiles();
    const retired = RETIRED_TEST_FILES.map((r) => r.path);
    expect(retired.filter((p) => current.has(p)), 'a retired test file is tracked again').toEqual([]);
    expect(
      RETIRED_TEST_FILES.filter((r) => fs.existsSync(path.join(REPO_ROOT, r.subject))).map((r) => r.subject),
      'a retired test file names a tool that still exists',
    ).toEqual([]);
    const accounted = new Set([...current, ...retired]);

    for (const { prefix, task } of FORMER_TEST_ROOTS) {
      const left = tracked.filter((f) => f.startsWith(prefix));
      expect(left, `test files remain under ${prefix} (task ${task}, DR-5)`).toEqual([]);

      const fromHere = inventory.relocations
        .filter((r) => r.from.startsWith(prefix) && IS_TEST_FILE.test(r.from))
        .map((r) => r.from);
      expect(
        fromHere.length,
        `the ledger records no relocation out of ${prefix} — this root is unwatched, not clean`,
      ).toBeGreaterThan(0);

      expect(
        unaccountedFor(fromHere, accounted, inventory.relocations),
        `tests lost from ${prefix} (task ${task})`,
      ).toEqual([]);
    }
  });

  /**
   * A test file can stay and still lose cases: a renamed case has a new id, which the
   * identity cannot tell from a deletion. `test-inventory-reconciliation.json` records each
   * rename pair from the one-time audit. Each `from` id must stay absent, and each `to` id
   * must exist.
   */
  it('TestInventory_RenamedCases_StillReconcileAgainstTheTask002Oracle', () => {
    const current = new Set(
      fileEntries.flatMap((e) => e.cases.map((c) => `${c.suite}::${c.name}`)),
    );

    expect(reconciliation.renames.length, 'the reconciliation ledger is empty').toBeGreaterThan(0);

    const resurrected = reconciliation.renames.filter((r) => current.has(r.from));
    expect(resurrected.map((r) => r.from), 'a retired case id is live again — re-audit').toEqual([]);

    const missingDestinations = reconciliation.renames.filter((r) => !current.has(r.to));
    expect(
      missingDestinations.map((r) => `${r.from}  ->  ${r.to}`),
      'a rename destination no longer exists — the case was lost after all',
    ).toEqual([]);
  });

  /**
   * Each test move appends to the relocation map. The test pins the shape of an entry: a
   * source and a different destination.
   */
  it('TestInventory_RelocatedFile_ReconcilesViaTheRelocationMap', () => {
    expect(Array.isArray(inventory.relocations)).toBe(true);

    for (const entry of inventory.relocations) {
      expect(entry.from, 'relocation without a source').toBeTruthy();
      expect(entry.to, 'relocation without a destination').toBeTruthy();
      expect(entry.from).not.toBe(entry.to);
    }
  });

  /**
   * A file move must not change an id that the file contributes. The test computes each id
   * with the local `idOf` helper.
   */
  it('TestInventory_Identity_IsIndependentOfFilePath', () => {
    const sample = fileEntries.find((e) => e.cases.length > 2);
    expect(sample).toBeDefined();

    const before = sample!.cases.map((c) => idOf(sample!, c));
    const moved: FileEntry = { ...sample!, file: `tests/relocated/${path.basename(sample!.file)}` };
    const after = moved.cases.map((c) => idOf(moved, c));

    expect(after).toEqual(before);
  });

  /**
   * A table-driven case is one call site and N executions, so the parsed total is less than
   * the combined count of the runners. The baseline must state this, or the gap reads as
   * missing tests.
   */
  it('TestInventory_CountingSemantics_AreStatedNotAssumed', () => {
    expect(inventory.countingSemantics).toMatch(/call site/i);
    expect(inventory.countingSemantics).toMatch(/each/i);
  });

  /** vitest cannot see a shell suite, so an inventory that comes from the runner drops each one. */
  it('TestInventory_ShellSuites_AreRecordedAtFileGranularity', () => {
    const shell = fileEntries.filter((e) => e.runner === 'shell');

    expect(shell.length).toBe(inventory.totals.shellFiles);
    expect(shell.length).toBeGreaterThan(0);
    for (const entry of shell) expect(entry.cases).toEqual([]);
  });

  /**
   * A computed title has no stable text, and an invented title gives an id that reconciles
   * against nothing. The inventory marks such a case as dynamic. The name check reads the
   * first 20 dynamic cases.
   */
  it('TestInventory_DynamicTitles_AreMarkedRatherThanGuessed', () => {
    const dynamic = fileEntries.flatMap((e) => e.cases.filter((c) => c.dynamic));

    expect(dynamic.length).toBe(inventory.totals.dynamicTitles);
    for (const c of dynamic.slice(0, 20)) expect(c.name).toMatch(/^<dynamic-/);
  });

  /**
   * vitest cannot see a shell suite, and the shell runner cannot see a vitest suite. The two
   * runners are the whole population, because no nested vitest workspace exists.
   */
  it('TestInventory_BothRunners_AreRepresented', () => {
    const runners = new Set(fileEntries.map((e) => e.runner));

    expect(runners).toContain('vitest:root');
    expect(runners).toContain('shell');
    expect(runners).not.toContain('vitest:nested');
  });

  /**
   * Tests are in more than one top-level root. A discovery that reads one root drops the
   * others and still reports a clean total.
   *
   * `src/` and `scripts/` must hold no test. The test asserts their absence, because a root
   * that is only absent from the list has no guard. `test/`, `benchmarks/` and `evals/` must
   * not exist as directories. `docs/` exists and must hold no test.
   */
  it('TestInventory_EveryTestBearingRoot_IsRepresented', () => {
    const roots = new Set(fileEntries.map((e) => e.file.split('/')[0]));

    for (const root of ['tests', 'tools']) {
      expect(roots, `no test file inventoried under ${root}/`).toContain(root);
    }
    expect(roots, 'a test file has re-appeared under src/ (DR-5)').not.toContain('src');
    expect(roots, 'a test file has re-appeared under scripts/ (DR-5)').not.toContain('scripts');
    for (const gone of ['test', 'benchmarks', 'evals']) {
      expect(roots, `the ${gone}/ root has come back (DR-5)`).not.toContain(gone);
      expect(
        fs.existsSync(path.join(REPO_ROOT, gone)),
        `the ${gone}/ directory has come back`,
      ).toBe(false);
    }
    const underDocs = fileEntries.map((e) => e.file).filter((f) => f.startsWith('docs/'));
    expect(underDocs, 'a test appeared under docs/, which holds no tests').toEqual([]);
  });
});
