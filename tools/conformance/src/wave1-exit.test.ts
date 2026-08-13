// Wave 1 exit proof (task 027, DR-6 / DR-24).
//
// ── WHICH EXIT CONDITION THIS IMPLEMENTS, AND WHY ───────────────────────────
// Rev 4.7 restated task 027's exit and required the implementer to CHOOSE
// between two readings. This file takes **option 2 — the delta-pinned exit** —
// and the choice is recorded here rather than left implicit in the assertions.
//
// Option 1 was "remediate the five real Wave-1 findings, then assert the
// seeded-violation test as originally written". It is the honest reading and the
// spec calls it preferred, but it is not what Wave 1 can close on:
//
//   - `response-shape` and `phase-sequencing` carry two blocking findings each,
//     and remediating them means BINDING four representations — the wrapper type
//     to the handler payload, the runtime payload to `outputSchema`,
//     `PHASE_EXPECTED_EVENTS` to the phase machine, and Markdown phase playbooks
//     to something mechanical. Each is a DR in its own right, not a data edit.
//   - The fifth is `action-contract`'s `stale-exception`: the P05-05 reachability
//     census walks authority → representation, so it cannot see an orphan
//     representation and therefore does not discharge G5. The spec is explicit
//     that this "is real work, not a data edit".
//
// Option 2 pins the DELTA rather than the absolute: the Wave-1 blocking
// population must equal its measured baseline exactly, and a seeded violation
// must add exactly one finding attributable to the seed. That is achievable
// today and still falsifiable — a new break reddens it, and so does a
// remediation that is not also recorded here.
//
// **The third path was NOT taken.** The spec forbids moving the
// `action-contract` row to a later wave to make the count zero, because that
// erases a measured failure rather than fixing it. `action-contract` still
// declares `enforceFrom: already-enforced` below, and its finding is still in
// the baseline where it stays visible.
//
// ── WHAT "FLIP TO ENFORCE" MEANT IN PRACTICE ────────────────────────────────
// The task title says "flip all five guards from observe to enforce". Measured
// at the exit, four of the five were ALREADY blocking — tasks 013, 017, 023, 063
// and 076 wired them as they landed, which is what "observe-then-enforce within
// the same wave" is supposed to produce. What was left was not severity but
// HOSTING: G4 and G5 ran only on `mcp`-path-filtered jobs, so they were
// skipped-as-passed on exactly the PRs #1711 describes. Task 027 gave both an
// unfiltered host. See `Wave1Exit_AllGuardsOnUnfilteredPaths`.
//
// G5's SEVERITY deliberately does not flip wholesale here. Rev 3 reconciled
// three contradictory statements of its schedule into one rule — each
// authority-topology row flips at the wave that remediates it, declared as
// `enforceFrom` ON THE ROW — and flipping the census blocking at Wave 1 would
// red-line CI for four waves, which is the contradiction rev 3 removed.
//
// Two independent authorities, per DR-30: the COMMITTED rows in
// `authority-topology.ts` (what the wave declared) and the LIVE CI wiring
// resolved by `scripts/guard-inventory.ts` (what actually runs). Neither can
// observe the other; this file is where they are made to agree.
//
// `authority-census.ts` is deliberately NOT listed — it imports the topology, so
// naming it would be one authority wearing two names. DR-30's own check caught
// that when this header first listed all three, which is the invariant working.
// @oracle-sources: ./authority-topology.ts, ../../../scripts/guard-inventory.ts
import { describe, it, expect } from 'vitest';

import { runAuthorityCensus } from './authority-census.js';
import {
  AUTHORITY_TOPOLOGY,
  topologyRows,
  type AuthorityTopologyRow,
  type BoundaryRepresentation,
} from './authority-topology.js';
import { buildGuardInventory } from '../../../scripts/guard-inventory.js';

// ─── The five Wave-1 guards, transcribed from §3a ────────────────────────────

/**
 * G1–G5 and the artifact each one IS, transcribed by a human from the spec's
 * §3a guard tables. This is the SECOND authority: the guard inventory discovers
 * artifacts from the tree, and this list says which of them the wave promised.
 * A guard that the inventory cannot see fails `toContain` below rather than
 * silently dropping out of the exit proof.
 */
const WAVE1_GUARDS: readonly { readonly id: string; readonly artifact: string }[] = [
  { id: 'G1 — CLI derivation guard (DR-5)', artifact: 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts' },
  { id: 'G2 — outputSchema non-vacuity ratchet (DR-4)', artifact: 'tools/conformance/src/output-schema-census.ts' },
  { id: 'G3 — event coupling union (DR-2)', artifact: 'tools/conformance/src/report-coupling-census.ts' },
  // G4 stayed in the subject tree: `effect-ledger.ts` has seven production
  // consumers, so task 018a could not extract it without inverting the
  // dependency direction between `src/` and `tools/`.
  { id: 'G4 — effect ledger bijection (DR-7)', artifact: 'servers/exarchos-mcp/src/architecture/effect-ledger.ts' },
  { id: 'G5 — authority-topology census (DR-6)', artifact: 'tools/conformance/src/authority-census.ts' },
];

/**
 * The Wave-1 BLOCKING finding population, measured by task 025 and re-measured
 * at the exit. Keyed `boundary | hop | kind` — stable under rewording of a
 * finding's prose, which a full-message key is not, while still distinguishing
 * every real break.
 *
 * Five entries, and each one is a real defect this wave did not close. They are
 * listed so that a SIXTH reddens the build, and so that remediating one of these
 * also reddens it — a baseline that only catches growth lets a fix land
 * unrecorded, and this program's whole thesis is that unrecorded state drifts.
 */
const WAVE1_BLOCKING_BASELINE: readonly string[] = [
  'action-contract | enforcement | stale-exception',
  'phase-sequencing | binding | missing',
  'phase-sequencing | binding | missing',
  'response-shape | binding | missing',
  'response-shape | binding | missing',
];

const tupleOf = (f: { boundary: string; hop: string; kind: string }): string =>
  `${f.boundary} | ${f.hop} | ${f.kind}`;

/** Rows whose `enforceFrom` is due at Wave 1 — DERIVED, never transcribed. */
function wave1Rows(): readonly AuthorityTopologyRow[] {
  return topologyRows().filter(
    (r) => r.enforceFrom.kind === 'already-enforced' || r.enforceFrom.wave === 'wave-1',
  );
}

describe('Wave 1 exit — the five guards (task 027, DR-6 / DR-24)', () => {
  it('Wave1Exit_AllFiveGuards_BlockOnSeededViolation', () => {
    // ── 1. The census, at Wave 1, over the shipped composition ───────────────
    // The real `AUTHORITY_TOPOLOGY`, not a fixture. Anything proven here is
    // proven about the rows the tree ships.
    const live = runAuthorityCensus(topologyRows(), { atWave: 'wave-1' });

    // The table is well-formed FIRST. A census over a malformed table reports
    // findings about the table instead of about the tree, and would satisfy
    // every assertion below for the wrong reason.
    expect(live.totality.ok, JSON.stringify(live.totality)).toBe(true);
    expect(live.evaluatedRows).toBe(live.rowCount);
    expect(live.rowCount).toBeGreaterThan(0);

    // Non-empty denominators: a census whose hops ranged over nothing is silent,
    // and silence is not closure.
    expect(live.representationCount).toBeGreaterThan(0);
    expect(live.bindingSubjectCount).toBeGreaterThan(0);

    // ── 2. The Wave-1 blocking population EQUALS its baseline ────────────────
    const blockingTuples = live.blocking.map(tupleOf).sort();
    expect(blockingTuples).toEqual([...WAVE1_BLOCKING_BASELINE].sort());

    // Every blocking finding belongs to a row that is actually due at Wave 1 —
    // otherwise `blocking` would be reporting a later wave's debt as this wave's.
    const dueBoundaries = new Set(wave1Rows().map((r) => r.boundary));
    for (const f of live.blocking) {
      expect(dueBoundaries.has(f.boundary), `${f.boundary} is due at wave-1`).toBe(true);
    }

    // The `action-contract` row was NOT relabelled to a later wave to make the
    // count zero — the third path the spec forbids. Task 025 left it at
    // `already-enforced` precisely so the finding stays visible.
    expect(AUTHORITY_TOPOLOGY['action-contract'].enforceFrom.kind).toBe('already-enforced');
    expect(blockingTuples).toContain('action-contract | enforcement | stale-exception');

    // ── 3. THE SEEDED VIOLATION — the guard still bites ──────────────────────
    // A baseline assertion alone passes on a census that has stopped looking.
    // Seed ONE new unbound representation into a Wave-1-due row and require the
    // blocking population to grow by exactly one, attributable to the seed.
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

    // …and the extra one is THE SEED, not an unrelated break the reshape caused.
    const newFindings = seeded.blocking.filter(
      (f) => !live.blocking.some((b) => b.subject === f.subject && b.hop === f.hop),
    );
    expect(newFindings).toHaveLength(1);
    expect(newFindings[0]?.subject).toBe(seededRepresentation.id);
    expect(newFindings[0]?.boundary).toBe('response-shape');

    // ── 4. SENSITIVITY CONTROL — the count moves DOWN on a real fix too ──────
    // Without this, the baseline is a one-way ratchet that a remediation would
    // silently satisfy. Bind one of the live unbound representations and the
    // blocking population must shrink by exactly one.
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

  it('Wave1Exit_EachGuardSelfTest_RunsInSameCiJob', () => {
    // DR-24: guard-execution failure must not pass as success. A guard invoked
    // DIRECTLY in a job whose self-test runs somewhere else can go green because
    // it silently failed to execute; hosting both in one job means a broken
    // guard reddens the same job that was supposed to run it.
    const inventory = buildGuardInventory();

    for (const guard of WAVE1_GUARDS) {
      const record = inventory.guards.find((g) => g.artifact === guard.artifact);
      expect(record, `${guard.id} is absent from the guard inventory`).toBeDefined();
      if (record === undefined) continue;

      const directJobs = record.hosts.filter((h) => h.via === 'direct').map((h) => h.job);
      const selfTestJobs = new Set(record.hosts.filter((h) => h.via === 'self-test').map((h) => h.job));

      // Every guard has a self-test hosted SOMEWHERE. For G3/G4/G5 the test file
      // IS the guard (they are pure libraries), so this is how they execute at
      // all — which is why the assertion is stated over all five rather than
      // only over the ones with a separate entrypoint.
      expect(selfTestJobs.size, `${guard.id} has no self-test host`).toBeGreaterThan(0);

      // And where a guard IS invoked directly, its self-test shares that job.
      for (const job of directJobs) {
        expect(selfTestJobs.has(job), `${guard.id}: direct in "${job}" but no self-test there`).toBe(true);
      }
    }
  });

  it('Wave1Exit_AllGuardsOnUnfilteredPaths', () => {
    // #1711: a path-filtered gate is SKIPPED-AS-PASSED on the PRs it polices. A
    // guard hosted only on `mcp`-filtered jobs does not run on a workflow-only
    // or scripts-only PR — and a skipped job reports success.
    //
    // This was live at the exit, not hypothetical: G4 (`effect-ledger`) and G5
    // (`authority-census`) were `pathFilteredOnly: true`, hosted only by
    // `test-mcp` and `test-windows`. Task 027 added an unfiltered `grep-gates`
    // host for both. The other three already had one.
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

  it('Wave1Exit_NoGuardIsUnreachable', () => {
    // The whole-inventory companion: Wave 1 promised "every guard reachable from
    // a CI job, or a recorded expiring reason why not" (DR-24). At the exit the
    // exemption list is EMPTY — task 076 discharged its last member.
    //
    // Asserted over the FULL inventory, not just the five: a wave that wires its
    // headline guards while leaving others dark has not closed DR-24.
    const inventory = buildGuardInventory();
    const unreachable = inventory.guards.filter((g) => g.enforcement === 'unreachable');
    expect(unreachable.map((g) => g.artifact)).toEqual([]);
    expect(inventory.guards.length).toBeGreaterThan(WAVE1_GUARDS.length);
  });
});
