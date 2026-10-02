// The exit proof for the `wave-1` guards. It pins the delta, not the absolute count.
//
// The `wave-1` blocking population must equal its measured baseline exactly, and a seeded
// violation must add exactly one finding, attributable to the seed. A new break fails the test,
// and so does a fix that does not also update the baseline. The `action-contract` row stays
// `already-enforced`. Its named instrument discharges the claim, so it has no stale-exception.
//
// Each authority-topology row starts to block at the wave that fixes it, as its `enforceFrom`
// field declares. The census thus does not block wholesale here.
//
// Two independent authorities meet here: the committed rows in `authority-topology.ts` and the
// live CI wiring that `tools/audit/gates/guard-inventory.ts` resolves. `authority-census.ts` is
// not a source, because it imports the topology.
// @oracle-sources: ./authority-topology.ts, ../../audit/gates/guard-inventory.ts
import { describe, it, expect } from 'vitest';

import { runAuthorityCensus } from './authority-census.js';
import {
  AUTHORITY_TOPOLOGY,
  topologyRows,
  type AuthorityTopologyRow,
  type BoundaryRepresentation,
} from './authority-topology.js';
import { buildGuardInventory } from '../../audit/gates/guard-inventory.js';

/**
 * The five guards and the artifact that each one is, transcribed by hand from the guard tables.
 * The guard inventory discovers artifacts from the tree, and this list says which of them the
 * wave promised. A guard that the inventory cannot see fails the tests below.
 */
const WAVE1_GUARDS: readonly { readonly id: string; readonly artifact: string }[] = [
  { id: 'G1 — CLI derivation guard (DR-5)', artifact: 'tools/audit/core/cli-derivation-guard.ts' },
  { id: 'G2 — outputSchema non-vacuity ratchet (DR-4)', artifact: 'tools/conformance/src/output-schema-census.ts' },
  { id: 'G3 — event coupling union (DR-2)', artifact: 'tools/conformance/src/report-coupling-census.ts' },
  /**
   * G4 stays under `src/`, because production code imports `effect-ledger.ts`. A move to
   * `tools/` inverts the dependency direction between `src/` and `tools/`.
   */
  { id: 'G4 — effect ledger bijection (DR-7)', artifact: 'src/architecture/effect-ledger.ts' },
  { id: 'G5 — authority-topology census (DR-6)', artifact: 'tools/conformance/src/authority-census.ts' },
];

/**
 * Guard modules that the denominator of `buildGuardInventory` must contain. A full-inventory
 * assertion over a denominator without them proves nothing about them. The list sits beside that
 * assertion, so the two cannot drift apart.
 */
const DR9_PREVIOUSLY_DARK: readonly string[] = [
  'src/architecture/adapter-ownership-seam.ts',
  'src/architecture/effect-port-seam.ts',
  'src/architecture/audit-delivery-closure.ts',
  'tools/conformance/src/delivery-safety.ts',
  'tools/conformance/src/import-cycles.ts',
];

/**
 * The blocking finding population of the `wave-1` rows, keyed `boundary | hop | kind`. The key
 * survives a rewording of the finding prose and still tells every real break apart.
 *
 * Each of the four entries is a real defect that stays open. A fifth finding fails the build, and
 * so does a fix that leaves its entry here.
 */
const WAVE1_BLOCKING_BASELINE: readonly string[] = [
  'phase-sequencing | binding | missing',
  'phase-sequencing | binding | missing',
  'response-shape | binding | missing',
  'response-shape | binding | missing',
];

const tupleOf = (f: { boundary: string; hop: string; kind: string }): string =>
  `${f.boundary} | ${f.hop} | ${f.kind}`;

/** Rows that are already enforced or due at `wave-1`, derived from the topology. */
function wave1Rows(): readonly AuthorityTopologyRow[] {
  return topologyRows().filter(
    (r) => r.enforceFrom.kind === 'already-enforced' || r.enforceFrom.wave === 'wave-1',
  );
}

describe('Wave 1 exit — the five guards (task 027, DR-6 / DR-24)', () => {
  /**
   * Runs the census on the shipped topology, not a fixture. The topology must be well-formed and
   * the denominators non-empty, or the census reports on the table instead of the tree. Every
   * blocking finding must belong to a row due at `wave-1`.
   *
   * A seeded unbound representation must add exactly one blocking finding, the seed itself.
   * Binding the unbound representations of `response-shape` must shrink the population, so the
   * baseline is not a one-way ratchet.
   */
  it('Wave1Exit_AllFiveGuards_BlockOnSeededViolation', () => {
    const live = runAuthorityCensus(topologyRows(), { atWave: 'wave-1' });

    expect(live.totality.ok, JSON.stringify(live.totality)).toBe(true);
    expect(live.evaluatedRows).toBe(live.rowCount);
    expect(live.rowCount).toBeGreaterThan(0);

    expect(live.representationCount).toBeGreaterThan(0);
    expect(live.bindingSubjectCount).toBeGreaterThan(0);

    const blockingTuples = live.blocking.map(tupleOf).sort();
    expect(blockingTuples).toEqual([...WAVE1_BLOCKING_BASELINE].sort());

    const dueBoundaries = new Set(wave1Rows().map((r) => r.boundary));
    for (const f of live.blocking) {
      expect(dueBoundaries.has(f.boundary), `${f.boundary} is due at wave-1`).toBe(true);
    }

    expect(AUTHORITY_TOPOLOGY['action-contract'].enforceFrom.kind).toBe('already-enforced');
    expect(blockingTuples).not.toContain('action-contract | enforcement | stale-exception');

    const victim = wave1Rows().find((r) => r.boundary === 'response-shape');
    if (victim === undefined) throw new Error('unreachable: response-shape is a wave-1 row');

    const seededRepresentation: BoundaryRepresentation = {
      id: 'a seeded representation that nothing derives (task 027 kill fixture)',
      binding: { kind: 'unbound', why: 'seeded by the Wave-1 exit proof; no derivation exists' },
    };
    const seededRows = topologyRows().map((r) =>
      r.boundary === victim.boundary
        ? { ...r, representations: [...r.representations, seededRepresentation] }
        : r,
    );

    const seeded = runAuthorityCensus(seededRows, { atWave: 'wave-1' });
    expect(seeded.totality.ok).toBe(true);
    expect(seeded.blocking.length).toBe(live.blocking.length + 1);

    const newFindings = seeded.blocking.filter(
      (f) => !live.blocking.some((b) => b.subject === f.subject && b.hop === f.hop),
    );
    expect(newFindings).toHaveLength(1);
    expect(newFindings[0]?.subject).toBe(seededRepresentation.id);
    expect(newFindings[0]?.boundary).toBe('response-shape');

    const boundRows = topologyRows().map((r) => {
      if (r.boundary !== 'response-shape') return r;
      return {
        ...r,
        representations: r.representations.map((rep) =>
          rep.binding.kind === 'unbound'
            ? { ...rep, binding: { kind: 'bound' as const, boundTo: 'outputSchema', how: 'seeded control' } }
            : rep,
        ),
      };
    });
    const remediated = runAuthorityCensus(boundRows, { atWave: 'wave-1' });
    expect(remediated.blocking.length).toBeLessThan(live.blocking.length);
    expect(remediated.blocking.map((f) => f.boundary)).not.toContain('response-shape');
  });

  /**
   * The blocking population must not carry the stale-exception of `action-contract`, and the row
   * stays `already-enforced`. A deferral of the row to hide the finding is forbidden. A seeded
   * violation on another row still adds a finding, so the guard is not silent.
   */
  it('Wave1Exit_NoActionContractStaleException', () => {
    const live = runAuthorityCensus(topologyRows(), { atWave: 'wave-1' });
    expect(AUTHORITY_TOPOLOGY['action-contract'].enforceFrom.kind).toBe('already-enforced');
    expect(live.blocking.map(tupleOf)).not.toContain('action-contract | enforcement | stale-exception');
    expect(WAVE1_BLOCKING_BASELINE).not.toContain('action-contract | enforcement | stale-exception');

    const victim = wave1Rows().find((r) => r.boundary === 'response-shape');
    if (victim === undefined) throw new Error('unreachable: response-shape is a wave-1 row');
    const seededRepresentation: BoundaryRepresentation = {
      id: 'a seeded representation that nothing derives (wave-1 action-contract control)',
      binding: { kind: 'unbound', why: 'seeded to prove the Wave-1 guard still bites' },
    };
    const seededRows = topologyRows().map((r) =>
      r.boundary === victim.boundary
        ? { ...r, representations: [...r.representations, seededRepresentation] }
        : r,
    );
    const seeded = runAuthorityCensus(seededRows, { atWave: 'wave-1' });
    expect(seeded.blocking.length).toBe(live.blocking.length + 1);
    expect(seeded.blocking.some((f) => f.subject === seededRepresentation.id)).toBe(true);
    expect(seeded.blocking.map(tupleOf)).not.toContain(
      'action-contract | enforcement | stale-exception',
    );
  });

  /**
   * A guard failure must not pass as success. A guard that runs directly in a job must have its
   * self-test in the same job. A broken guard then fails the job that runs it. Each of the five
   * guards needs a self-test host, because for G3, G4 and G5 the test file is the guard.
   */
  it('Wave1Exit_EachGuardSelfTest_RunsInSameCiJob', () => {
    const inventory = buildGuardInventory();

    for (const guard of WAVE1_GUARDS) {
      const record = inventory.guards.find((g) => g.artifact === guard.artifact);
      expect(record, `${guard.id} is absent from the guard inventory`).toBeDefined();
      if (record === undefined) continue;

      const directJobs = record.hosts.filter((h) => h.via === 'direct').map((h) => h.job);
      const selfTestJobs = new Set(record.hosts.filter((h) => h.via === 'self-test').map((h) => h.job));

      expect(selfTestJobs.size, `${guard.id} has no self-test host`).toBeGreaterThan(0);

      for (const job of directJobs) {
        expect(selfTestJobs.has(job), `${guard.id}: direct in "${job}" but no self-test there`).toBe(true);
      }
    }
  });

  /**
   * A path-filtered job is skipped as passed on the pull requests that it polices. Each of the
   * five guards thus needs a host with no path filter, and its enforcement must be `blocks`.
   */
  it('Wave1Exit_AllGuardsOnUnfilteredPaths', () => {
    const inventory = buildGuardInventory();

    for (const guard of WAVE1_GUARDS) {
      const record = inventory.guards.find((g) => g.artifact === guard.artifact);
      expect(record, `${guard.id} is absent from the guard inventory`).toBeDefined();
      if (record === undefined) continue;

      const unfiltered = record.hosts.filter((h) => h.pathFilterKeys.length === 0);
      expect(
        unfiltered.length,
        `${guard.id} is hosted only on path-filtered jobs — it is skipped-as-passed on the PRs it polices (#1711)`,
      ).toBeGreaterThan(0);
      expect(record.pathFilteredOnly, `${guard.id} pathFilteredOnly`).toBe(false);
      expect(record.enforcement, `${guard.id} enforcement`).toBe('blocks');
    }
  });

  const assertNoGuardIsUnreachable = (guards: readonly { artifact: string; enforcement: string }[]): void => {
    const unreachable = guards.filter((g) => g.enforcement === 'unreachable');
    if (unreachable.length > 0) {
      throw new Error(
        `guard(s) unreachable from any CI job: ${unreachable.map((g) => g.artifact).join(', ')}`,
      );
    }
  };

  /**
   * Every guard in the full inventory must be reachable from a CI job, not only the five headline
   * guards. The denominator must also contain every module in `DR9_PREVIOUSLY_DARK`, or the claim
   * ranges over a set without them.
   */
  it('Wave1Exit_NoGuardIsUnreachable', () => {
    const inventory = buildGuardInventory();
    expect(() => assertNoGuardIsUnreachable(inventory.guards)).not.toThrow();
    expect(inventory.guards.length).toBeGreaterThan(WAVE1_GUARDS.length);

    const artifacts = new Set(inventory.guards.map((g) => g.artifact));
    for (const dark of DR9_PREVIOUSLY_DARK) {
      expect(artifacts, `${dark} is outside the set this proof ranges over`).toContain(dark);
    }
  });

  /**
   * The kill probe for `Wave1Exit_NoGuardIsUnreachable`. It unwires a guard outside the five
   * headline guards and puts the inventory through `assertNoGuardIsUnreachable`, the predicate of
   * that test. The failure message must name the unwired guard.
   */
  it('Wave1Exit_UnreachableGuardOutsideTheFiveHeadlineGuards_StillFailsTheExit', () => {
    const inventory = buildGuardInventory();
    const subject = inventory.guards.find(
      (g) => g.artifact === 'src/architecture/adapter-ownership-seam.ts',
    );
    expect(subject, 'the probe needs a real subject from the widened denominator').toBeDefined();
    if (subject === undefined) return;
    expect(WAVE1_GUARDS.map((g) => g.artifact)).not.toContain(subject.artifact);

    const unwired = inventory.guards.map((g) =>
      g.artifact === subject.artifact ? { ...g, hosts: [], enforcement: 'unreachable' as const } : g,
    );
    expect(unwired.filter((g) => g.enforcement === 'unreachable').map((g) => g.artifact)).toEqual([
      subject.artifact,
    ]);

    expect(() => assertNoGuardIsUnreachable(unwired)).toThrow(subject.artifact);
  });
});
