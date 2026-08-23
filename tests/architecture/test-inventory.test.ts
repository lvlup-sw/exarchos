/**
 * The test inventory the consolidation is reconciled against.
 *
 * 1,138 test files move during this refactor. The risk is not that one breaks —
 * `tsc` and the runner catch that — but that one is silently dropped by a stale
 * include glob and nobody notices, because a suite that no longer runs looks
 * exactly like a suite with nothing to say.
 *
 * Identity is `(suite path within the file, test name, runner)`. Path is
 * metadata, never identity: keying on it would invalidate the entire oracle on
 * the first move, which is the failure that made an earlier version of this
 * unusable.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/** The task 034 audit of the task 002 capture against the consolidated tree. */
const reconciliation = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/test-inventory-reconciliation.json'), 'utf8'),
) as Reconciliation;

const fileEntries = Object.values(inventory.files);

/** The id used for reconciliation — deliberately free of the file path. */
const idOf = (entry: FileEntry, c: Case): string => `${entry.runner}::${c.suite}::${c.name}`;

/**
 * Test files git currently tracks. Discovery is by extension over tracked
 * files rather than by a runner glob, because a glob is the thing that goes
 * stale silently.
 */
/** What the inventory counts as a test file. One definition, three readers. */
const IS_TEST_FILE = /\.(test|spec|bench)\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$|\.test\.sh$/;

function trackedTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
    .split('\0')
    .filter((rel) => IS_TEST_FILE.test(rel));
}

/**
 * Reconciliation, as ONE function.
 *
 * The check and its kill probe used to inline two different filters — the real
 * one followed a relocation to its destination and confirmed the destination
 * exists, the probe only asked whether a relocation was present. So the probe
 * could stay green while the check it claims to prove was broken, which is the
 * failure mode a kill probe exists to rule out. Both now call this.
 *
 * A baseline path is accounted for when it is still tracked, when a relocation
 * points at something that is, or when the path the chain ends at is named in
 * the retirement register — a test deleted ON PURPOSE. Nothing else counts: a
 * deletion with no register row is indistinguishable from a suite dropped by a
 * stale glob, which is the whole reason this oracle exists.
 */
function unaccountedFor(
  baselinePaths: readonly string[],
  current: ReadonlySet<string>,
  relocations: readonly { from: string; to: string }[],
  retired: ReadonlySet<string> = new Set(),
): string[] {
  const landingOf = relocationResolver(relocations);

  return baselinePaths.filter((rel) => {
    if (current.has(rel)) return false;
    const landed = landingOf(rel);
    if (current.has(landed)) return false;
    // A deliberate deletion is accounted for only when the register below names
    // the path the chain ENDED at. The parameter defaults to empty so every
    // caller that does not opt in — including all four kill probes — keeps
    // driving the un-amnestied path.
    return !retired.has(landed);
  });
}

/**
 * Follow a path through the ledger to where it finally landed.
 *
 * The ledger is APPEND-ONLY — every move task adds a hop rather than
 * rewriting an existing one — so a file that has moved twice is recorded as
 * two entries, and following one hop reports it as lost. A file relocated
 * into `tests/` and later moved again within it is the ordinary case, not an
 * exotic one. The `seen` set bounds the walk: a cycle would otherwise hang
 * here, and a ledger can contain one by mistake.
 *
 * Hoisted out of {@link unaccountedFor} so the retirement register's own
 * assertions resolve chains the SAME way the reconciliation does — a register
 * checked against a second, hand-rolled walk could agree with itself while
 * disagreeing with the check it exists to serve.
 */
function relocationResolver(
  relocations: readonly { from: string; to: string }[],
): (start: string) => string {
  const relocated = new Map(relocations.map((r) => [r.from, r.to]));
  return (start: string): string => {
    let at = start;
    const seen = new Set<string>([at]);
    for (;;) {
      const next = relocated.get(at);
      if (next === undefined || seen.has(next)) return at;
      seen.add(next);
      at = next;
    }
  };
}

/**
 * The roots DR-5 emptied, and the task that emptied each. Every one must hold
 * zero tracked test files, and every test that was in it must reconcile.
 *
 * `docs/evals` is a subtree rather than a top-level root, so it is matched by
 * prefix like the others rather than by first path segment.
 */
const FORMER_TEST_ROOTS: ReadonlyArray<{ prefix: string; task: string }> = [
  { prefix: 'src/', task: '030' },
  { prefix: 'scripts/', task: '031' },
  { prefix: 'test/', task: '032' },
  { prefix: 'benchmarks/', task: '033' },
  { prefix: 'docs/evals/', task: '033' },
  // Task 036 folded these two into `tools/`. `migrations/` moved with them but
  // is deliberately absent: it carried no test file, so it has no ledger
  // entries, and listing it would trip the empty-denominator check below —
  // correctly, since there would be nothing there to reconcile.
  { prefix: 'eslint-rules/', task: '036' },
  { prefix: 'renovate-config/', task: '036' },
];

/**
 * Tests deleted ON PURPOSE by the gate-triage pass, and why each one went.
 *
 * The ledger records where a test WENT. It has no way to say a test was
 * retired, so a deliberate deletion reaches {@link unaccountedFor} looking
 * exactly like a suite silently dropped by a stale include glob — the one
 * failure this whole oracle exists to catch. Recording the retirement keeps the
 * two distinguishable, instead of relaxing the check that tells them apart.
 *
 * Same shape as the register in `retired-public-names.test.ts`: the set is
 * DATA, every row states a reason a reviewer reads before deleting anything
 * else, and `TestInventory_RetirementRegister_IsHonestAndNotInert` refuses a
 * row that is stale (its file is back) or inert (no chain ever ended there).
 *
 * `path` is the path the relocation chain ENDS at, not where the test started.
 */
interface RetiredTest {
  /** Where the chain landed — the file that was actually deleted. */
  readonly path: string;
  /** Why it went, in one line. */
  readonly why: string;
}

const RETIRED_TESTS: readonly RetiredTest[] = [
  {
    path: 'tests/unit/verbs/gates/design-completeness.test.ts',
    why:
      'check_design_completeness was a self-declared deprecated alias that delegated to ' +
      'check_plan_coverage, so every case here exercised the survivor through one extra hop.',
  },
  {
    path: 'tests/unit/verbs/gates/check-coverage-thresholds.test.ts',
    why:
      'check_coverage_thresholds is retired: it read Istanbul/Jest coverage-summary.json ' +
      'shapes directly, which is the toolchain literal this spec exists to remove, and no ' +
      'runbook chain or resolver sequence reached it.',
  },
  {
    path: 'tests/unit/verbs/gates/check-convergence.test.ts',
    why:
      'check_convergence attributed a gate result by reading details.dimension, which the ' +
      'durable gate runner never stamps, so its aggregate verdict was unsatisfiable on any ' +
      'automated path. gate.dimension itself is kept; only this consumer retires.',
  },
  {
    path: 'tests/unit/projections/views/convergence-view.test.ts',
    why:
      'ConvergenceView and the convergence CLI view name retire with check_convergence — an ' +
      'INV-2 contract change called out as such. The surviving surfaces are pinned by ' +
      'tests/architecture/retired-public-names.test.ts.',
  },
  {
    path: 'tests/unit/verbs/gates/context-economy.test.ts',
    why:
      'Consolidated: check_context_economy was measured to be one of exactly three getDiff ' +
      'callers among the gates, structurally identical to the other two. Its coverage moved ' +
      'to the single diff-scanner in tests/unit/verbs/gates/diff-hygiene.test.ts.',
  },
  {
    path: 'tests/unit/verbs/gates/operational-resilience.test.ts',
    why:
      'Consolidated with context-economy and workflow-determinism into the one diff-scanner ' +
      'with a rule pack; its coverage moved to tests/unit/verbs/gates/diff-hygiene.test.ts.',
  },
  {
    path: 'tests/unit/verbs/gates/workflow-determinism.test.ts',
    why:
      'Consolidated with context-economy and operational-resilience into the one diff-scanner ' +
      'with a rule pack; its coverage moved to tests/unit/verbs/gates/diff-hygiene.test.ts.',
  },
  {
    path: 'tests/unit/verbs/gates/pre-synthesis-check.test.ts',
    why:
      'pre_synthesis_check was a blocking orphan nothing invoked. It folded INTO ' +
      'prepare_synthesis, carrying its resolver and provider seams across, so its cases now ' +
      'run against the survivor in tests/unit/verbs/team/prepare-synthesis.test.ts.',
  },
  {
    path: 'tests/unit/verbs/review/debug-review-gate.test.ts',
    why:
      'debug_review_gate held the last npm run test:run literal in the gate population and no ' +
      'chain reached it. Recorded operator decision of 2026-08-22 was to delete rather than ' +
      'wire it, closing the literal and the orphan together.',
  },
];

/** The retired chain terminuses, in the shape {@link unaccountedFor} wants. */
const retiredPaths = (): ReadonlySet<string> => new Set(RETIRED_TESTS.map((r) => r.path));

/**
 * Retired CASE ids — the same register, one level down.
 *
 * A file can survive while a case inside it goes, and the path-independent
 * identity cannot tell a deleted case from a renamed one. This names the cases
 * the triage pass deleted along with the code they covered, so the task 002
 * audit below stays a real check rather than being relaxed to accommodate them.
 */
const RETIRED_CASES: readonly RetiredTest[] = [
  {
    path:
      'projections/views/tools.ts composite error paths > ' +
      'HandleViewConvergence_QueryThrowsError_ReturnsViewError::should return VIEW_ERROR when ' +
      'queryDeltaEvents throws an Error',
    why:
      'The error path of the convergence view handler, which retires with the view itself. ' +
      'Its subject is gone, so the case cannot be re-homed onto a survivor.',
  },
];

describe('test inventory', () => {
  it('TestInventory_AtBaseline_RecordsEveryDiscoveredTestId', () => {
    expect(inventory.totals.testFiles).toBe(fileEntries.length);
    expect(inventory.totals.cases).toBeGreaterThan(10000);
    expect(inventory.totals.unparseableFiles).toBe(0);
    expect(inventory.unparseable).toEqual([]);
  });

  it('TestInventory_Discovery_FoundEveryTrackedTestFile', () => {
    const missing = trackedTestFiles().filter((rel) => inventory.files[rel] === undefined);

    expect(missing, 'tracked test files absent from the inventory').toEqual([]);
  });

  it('TestInventory_MissingFile_NamesTheMissingSource', () => {
    // Reconciliation is `oracle − relocations`. A file that vanished with no
    // relocation entry must be named, not summarised as a count.
    //
    // The comparison is baseline-against-reality. An earlier version built the
    // "current" set out of the baseline's own keys and then filtered those same
    // keys by absence from it, so `dropped` was empty by construction and this
    // oracle could not fail for any input — including a genuinely deleted test.
    const dropped = unaccountedFor(
      Object.keys(inventory.files),
      new Set(trackedTestFiles()),
      inventory.relocations,
    );

    expect(dropped, 'baseline test files neither tracked nor relocated').toEqual([]);
  });

  it('TestInventory_SeededDisappearance_IsReportedByName', () => {
    // The kill probe for the reconciliation above, driving the SAME function
    // rather than a re-implementation of it — the earlier version asked only
    // whether a relocation existed, so it stayed green regardless of whether
    // the real check still followed one to a destination that exists.
    const current = new Set(trackedTestFiles());
    const phantom = 'src/__vanished__.test.ts';

    const missing = unaccountedFor(
      [phantom, ...Object.keys(inventory.files).slice(0, 3)],
      current,
      inventory.relocations,
    );

    expect(missing).toContain(phantom);
  });

  it('TestInventory_UnexplainedLoss_NamesTheMissingFileAndBlocks', () => {
    // Task 034. Two distinct losses a consolidation can suffer, and the
    // reconciliation has to name the file in both — a count would say only
    // that something went, which is the report that made an earlier oracle
    // unusable.
    const current = new Set(trackedTestFiles());
    const real = Object.keys(inventory.files)[0];
    expect(real, 'the baseline is empty — nothing to reconcile').toBeDefined();

    // (a) a file that simply vanished, with no relocation at all.
    const vanished = 'tests/unit/__never-existed__.test.ts';
    expect(unaccountedFor([vanished], current, inventory.relocations)).toEqual([vanished]);

    // (b) the subtler one: a relocation IS recorded, but it points at a
    // destination that does not exist. A membership-only check calls this
    // accounted for, and the test is gone just the same.
    const danglingFrom = 'tests/unit/__moved-nowhere__.test.ts';
    expect(
      unaccountedFor([danglingFrom], current, [
        ...inventory.relocations,
        { from: danglingFrom, to: 'tests/unit/__also-not-here__.test.ts' },
      ]),
      'a relocation pointing at a missing destination was treated as accounted for',
    ).toEqual([danglingFrom]);

    // And the converse, so the two above are not passing because the function
    // simply reports everything: a file that IS tracked reconciles clean.
    expect(unaccountedFor([real!], current, inventory.relocations)).toEqual([]);
  });

  it('TestInventory_AfterFullConsolidation_ReconcilesAgainstBaseline', () => {
    // Task 034. Tasks 030-033 emptied five roots between them. Two things have
    // to hold for each, and neither implies the other: nothing tracked is left
    // in it, and every test that WAS there is accounted for.
    //
    // The population is the relocation ledger's `from` side, not the baseline's
    // keys. Every move task regenerates the baseline, so `files` already holds
    // post-move paths — filtering it by a former root yields nothing, and a
    // reconciliation over nothing passes without checking anything. The ledger
    // is the only side that still remembers where a test started.
    const current = new Set(trackedTestFiles());
    const tracked = trackedTestFiles();

    for (const { prefix, task } of FORMER_TEST_ROOTS) {
      const left = tracked.filter((f) => f.startsWith(prefix));
      expect(left, `test files remain under ${prefix} (task ${task}, DR-5)`).toEqual([]);

      // Test files only. The ledger also carries the non-test travellers each
      // move took along — fixtures, `.type-test.ts`, a README — and those are
      // invisible to a discovery scoped to test extensions, so including them
      // would report every one as lost.
      const fromHere = inventory.relocations
        .filter((r) => r.from.startsWith(prefix) && IS_TEST_FILE.test(r.from))
        .map((r) => r.from);
      // Denominator: a root with no ledger entries would satisfy the check
      // below by having nothing in it to reconcile.
      expect(
        fromHere.length,
        `the ledger records no relocation out of ${prefix} — this root is unwatched, not clean`,
      ).toBeGreaterThan(0);

      expect(
        unaccountedFor(fromHere, current, inventory.relocations, retiredPaths()),
        `tests lost from ${prefix} (task ${task})`,
      ).toEqual([]);
    }
  });

  it('TestInventory_RenamedCases_StillReconcileAgainstTheTask002Oracle', () => {
    // Task 034. The other half of the reconciliation: a test can survive as a
    // FILE and still lose cases, because a renamed case has a new id and the
    // path-independent identity cannot tell that from a deletion.
    //
    // The one-time audit against the task 002 capture found 63 such ids across
    // 26 files, every one of them a rename with its file intact and no case
    // actually lost. `test-inventory-reconciliation.json` records each pair;
    // this re-checks them, so re-renaming or deleting one fails here instead of
    // quietly re-opening the gap the audit closed.
    const current = new Set(
      fileEntries.flatMap((e) => e.cases.map((c) => `${c.suite}::${c.name}`)),
    );

    expect(reconciliation.renames.length, 'the reconciliation ledger is empty').toBeGreaterThan(0);

    const resurrected = reconciliation.renames.filter((r) => current.has(r.from));
    expect(resurrected.map((r) => r.from), 'a retired case id is live again — re-audit').toEqual([]);

    // The case-level register, held to the same two conditions as the file-level
    // one: a retired case must actually be GONE, and it must actually be a
    // destination this ledger names. Either one failing makes the exemption a
    // hole rather than a record.
    const retiredCases = new Set(RETIRED_CASES.map((c) => c.path));
    const destinations = new Set(reconciliation.renames.map((r) => r.to));
    for (const { path: id, why } of RETIRED_CASES) {
      expect(why.length, `a retired case is registered with no stated reason: ${id}`).toBeGreaterThan(40);
      expect(current.has(id), `\`${id}\` is registered as retired but is live — drop the row`).toBe(false);
      expect(
        destinations.has(id),
        `\`${id}\` is registered as retired but is not a rename destination — inert row`,
      ).toBe(true);
    }

    const missingDestinations = reconciliation.renames.filter(
      (r) => !current.has(r.to) && !retiredCases.has(r.to),
    );
    expect(
      missingDestinations.map((r) => `${r.from}  ->  ${r.to}`),
      'a rename destination no longer exists — the case was lost after all',
    ).toEqual([]);
  });

  it('TestInventory_RetirementRegister_IsHonestAndNotInert', () => {
    // An escape hatch is only as good as the conditions on using it. Two, and
    // a row has to satisfy both:
    //
    //   STALE — the file is tracked again. The row now exempts a live test from
    //     reconciliation, which is worse than no register at all.
    //   INERT — no relocation chain ends at the path. Nothing was ever exempted,
    //     so the row proves nothing and is most likely a typo, which would leave
    //     the real deletion unaccounted for while reading as handled.
    const current = new Set(trackedTestFiles());
    const landingOf = relocationResolver(inventory.relocations);
    const landings = new Set(inventory.relocations.map((r) => landingOf(r.from)));

    // Denominator: an empty register would make the loop below pass by never
    // running, which is how this repo's guards go vacuous rather than red.
    expect(
      RETIRED_TESTS.length,
      'the retirement register is empty — this check governs nothing',
    ).toBeGreaterThan(0);
    expect(landings.size, 'the relocation ledger resolves no landings').toBeGreaterThan(100);

    const paths = RETIRED_TESTS.map((r) => r.path);
    expect(new Set(paths).size, 'the register names the same path twice').toBe(paths.length);

    for (const { path: retired, why } of RETIRED_TESTS) {
      expect(why.length, `${retired} is retired with no stated reason`).toBeGreaterThan(40);
      expect(
        current.has(retired),
        `${retired} is registered as retired but is tracked again — drop the row`,
      ).toBe(false);
      expect(
        landings.has(retired),
        `no relocation chain ends at ${retired}, so registering it retires nothing — ` +
          'check the path against the ledger',
      ).toBe(true);
    }
  });

  it('TestInventory_DeletionWithoutARetirement_IsStillReported', () => {
    // The kill probe for the register: it must exempt the paths it NAMES and
    // nothing else. A register that widened into a blanket amnesty would turn
    // every case above green while the oracle stopped watching — the same
    // shape as the membership-only check the reconciliation already rejects.
    const current = new Set(trackedTestFiles());
    const from = 'src/__deleted-without-a-record__.test.ts';
    const to = 'tests/unit/__deleted-without-a-record__.test.ts';

    expect(
      unaccountedFor(
        [from],
        current,
        [...inventory.relocations, { from, to }],
        retiredPaths(),
      ),
      'a deletion absent from the retirement register was treated as accounted for',
    ).toEqual([from]);

    // And the converse, so the case above is not passing because the register
    // is simply being ignored: the SAME dangling chain reconciles clean once
    // its landing is registered.
    expect(
      unaccountedFor(
        [from],
        current,
        [...inventory.relocations, { from, to }],
        new Set([...retiredPaths(), to]),
      ),
      'a registered retirement was still reported as lost',
    ).toEqual([]);
  });

  it('TestInventory_RelocatedFile_ReconcilesViaTheRelocationMap', () => {
    // The map starts empty and every move task appends to it. Its shape is
    // asserted now so a move task cannot invent a different one later.
    expect(Array.isArray(inventory.relocations)).toBe(true);

    for (const entry of inventory.relocations) {
      expect(entry.from, 'relocation without a source').toBeTruthy();
      expect(entry.to, 'relocation without a destination').toBeTruthy();
      expect(entry.from).not.toBe(entry.to);
    }
  });

  it('TestInventory_Identity_IsIndependentOfFilePath', () => {
    // The property the whole oracle rests on: moving a file must not change
    // any id it contributes.
    const sample = fileEntries.find((e) => e.cases.length > 2);
    expect(sample).toBeDefined();

    const before = sample!.cases.map((c) => idOf(sample!, c));
    const moved: FileEntry = { ...sample!, file: `tests/relocated/${path.basename(sample!.file)}` };
    const after = moved.cases.map((c) => idOf(moved, c));

    expect(after).toEqual(before);
  });

  it('TestInventory_CountingSemantics_AreStatedNotAssumed', () => {
    // The parsed total sits below the runners' combined count because a
    // table-driven case is one call site and N executions. Unexplained, that
    // gap reads as ~800 missing tests.
    expect(inventory.countingSemantics).toMatch(/call site/i);
    expect(inventory.countingSemantics).toMatch(/each/i);
  });

  it('TestInventory_ShellSuites_AreRecordedAtFileGranularity', () => {
    // vitest cannot see them at all, so a runner-derived inventory would drop
    // all 45 without comment.
    const shell = fileEntries.filter((e) => e.runner === 'shell');

    expect(shell.length).toBe(inventory.totals.shellFiles);
    expect(shell.length).toBeGreaterThan(0);
    for (const entry of shell) expect(entry.cases).toEqual([]);
  });

  it('TestInventory_DynamicTitles_AreMarkedRatherThanGuessed', () => {
    // A computed title has no stable text. Inventing one would produce an id
    // that reconciles against nothing, so they are flagged instead.
    const dynamic = fileEntries.flatMap((e) => e.cases.filter((c) => c.dynamic));

    expect(dynamic.length).toBe(inventory.totals.dynamicTitles);
    for (const c of dynamic.slice(0, 20)) expect(c.name).toMatch(/^<dynamic-/);
  });

  it('TestInventory_BothRunners_AreRepresented', () => {
    // vitest cannot see a shell suite and the shell runner cannot see a vitest
    // one, so an inventory derived from either alone under-reports the other.
    // This was a three-way split while a nested vitest workspace existed; task
    // 019 dissolved that package, so the two runners are the whole population.
    const runners = new Set(fileEntries.map((e) => e.runner));

    expect(runners).toContain('vitest:root');
    expect(runners).toContain('shell');
    expect(runners).not.toContain('vitest:nested');
  });

  it('TestInventory_EveryTestBearingRoot_IsRepresented', () => {
    // What the nested-workspace assertion was really protecting: one collector
    // covering a subset of the trees and reporting a clean total. The packages
    // merged, but the trees did not — tests live under several top-level roots,
    // and a discovery bounded to one of them would drop the rest in silence.
    const roots = new Set(fileEntries.map((e) => e.file.split('/')[0]));

    for (const root of ['tests', 'tools']) {
      expect(roots, `no test file inventoried under ${root}/`).toContain(root);
    }
    // `src/` and `scripts/` are the roots that must hold NONE: task 030 lifted
    // every co-located suite out of the first and task 031 out of the second,
    // and DR-5 is the standing promise that none comes back. Asserted here
    // rather than merely dropped from the list above, so the discovery keeps a
    // live opinion about each one either way — a root that is simply removed
    // from the list stops being watched instead of starting to be enforced.
    expect(roots, 'a test file has re-appeared under src/ (DR-5)').not.toContain('src');
    expect(roots, 'a test file has re-appeared under scripts/ (DR-5)').not.toContain('scripts');
    // `test/`, `benchmarks/` and `evals/` are gone outright — not emptied but
    // dissolved (032, 033) — so this also catches a root being recreated rather
    // than merely refilled. `docs/` survives, but with no test under it: the
    // eval graders moved to `tests/evals/` and DR-7 reduces what is left to the
    // VitePress skeleton.
    for (const gone of ['test', 'benchmarks', 'evals']) {
      expect(roots, `the ${gone}/ root has come back (DR-5)`).not.toContain(gone);
      expect(
        fs.existsSync(path.join(REPO_ROOT, gone)),
        `the ${gone}/ directory has come back`,
      ).toBe(false);
    }
    // The move this comment used to anticipate has happened. `docs/schemas/`
    // held one test and the JSON Schema it checks; the schema is consumed by
    // nothing else, so both are test data and now live at
    // `tests/scripts/schemas/`. `docs/` holds NO test at all — it holds two
    // files — and this stays on the watch list so a test appearing there again
    // fails instead of arriving unobserved.
    const underDocs = fileEntries.map((e) => e.file).filter((f) => f.startsWith('docs/'));
    expect(underDocs, 'a test appeared under docs/, which holds no tests').toEqual([]);
  });
});
