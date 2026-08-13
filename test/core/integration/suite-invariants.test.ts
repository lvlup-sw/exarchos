/**
 * DR-30 — the suite invariants, enforced mechanically (task T-40).
 *
 * "The suite must not reproduce the defect classes it exists to catch."
 *
 * ── Why this file is shaped the way it is ──────────────────────────────────
 *
 * A meta-test that walks 920 test files, matches nothing, and reports perfect
 * compliance is worse than no meta-test at all: it converts an unmeasured
 * surface into a measured-and-green one. So this file is deliberately split
 * into two halves that check each other:
 *
 *   PART 1 — DETECTOR PROOF. Every rule is run against a POSITIVE fixture that
 *            it must flag and a NEGATIVE fixture that it must not. A rule that
 *            has stopped working fails here, in the same run, before its
 *            corpus verdict is believed.
 *
 *   PART 2 — CORPUS SWEEP AND RATCHET. The rules are run over the real scan
 *            roots. Denominators are printed. Every shape must still match at
 *            least a ratcheted floor of real files, so a matcher edited into
 *            matching nothing turns this suite RED instead of green.
 *
 * ── Why scope is computed from assertion shape, never from the annotation ──
 *
 * DR-30 requires that "Removing an `@oracle-sources` annotation from an
 * in-scope test FAILS". If in-scope-ness were decided by "does this file carry
 * the annotation", deleting the annotation would delete the obligation and the
 * guard would be trivially evadable. `shapes.ts::isInScope` therefore reads
 * ONLY the file's assertion shapes; the annotation is never an input to scope,
 * only to compliance. `SuiteInvariant_DroppingTheAnnotation_DoesNotDropTheObligation`
 * pins that on this very file.
 *
 * ── This file governs itself ──────────────────────────────────────────────
 *
 * It asserts census closure over a corpus, so it is in scope by its own rules,
 * and it declares its own authorities below. Its two authorities are genuinely
 * independent: `corpus.ts` reads what the repository contains right now;
 * `registry.ts` is hand-written data that reads nothing. Neither reaches the
 * other in the import graph — which its own derived-authority check verifies.
 *
 * @oracle-sources: ./suite-invariants/corpus.ts, ./suite-invariants/registry.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus, SCAN_ROOTS, toRel } from './suite-invariants/corpus.js';
import { COVERED_SHAPES, matchedShapes, isInScope } from './suite-invariants/shapes.js';
import {
  checkOracleSources,
  checkBlockingClaims,
  checkCouldNotRunVerdicts,
  checkNoSynthesizedRoot,
  parseOracleDeclarations,
  extractTestBlocks,
  BLOCKING_CLAIM_MARKER,
  type Violation,
} from './suite-invariants/detectors.js';
import { sourceViews } from './suite-invariants/source-view.js';
import {
  ACCEPTED_GAPS,
  SHAPE_RATCHET,
  CORPUS_FLOORS,
  IN_SCOPE_FLOOR,
  BLOCKING_CLAIM_CENSUS_FLOOR,
  KNOWN_DERIVATIONS,
  LEGACY_SHAPE_DEBT,
  MAX_GAP_HORIZON_DAYS,
  REGISTER_ANCHOR,
} from './suite-invariants/registry.js';
import * as F from './suite-invariants/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_ABS = fileURLToPath(import.meta.url).replace(/\.js$/, '.ts');
const SELF_REL = 'test/core/integration/suite-invariants.test.ts';

/** A virtual path inside this directory, so `./x.ts` authorities resolve. */
const FIXTURE_PATH = path.join(HERE, 'suite-invariants', '__fixture__.test.ts');

const rules = (vs: readonly Violation[]): readonly string[] => vs.map((v) => v.rule).sort();
const oracle = (src: string): readonly Violation[] =>
  checkOracleSources(FIXTURE_PATH, src, { knownDerivations: KNOWN_DERIVATIONS });

// ────────────────────────────────────────────────────────────────────────────
// PART 1 — DETECTOR PROOF
// ────────────────────────────────────────────────────────────────────────────

describe('DR-30 part 1 — every detector is proved able to fire and able not to', () => {
  /**
   * NAMED ACCEPTANCE TEST (T-40).
   *
   * A comparison whose two sides come from one source can never disagree with
   * itself — Class B. DR-30 makes that decidable by declaration: an in-scope
   * test must name at least two DISTINCT, NON-DERIVED authorities.
   *
   * All four rejection modes are exercised, and each is paired with an
   * acceptance so the rule is not merely "reject everything":
   *   • one authority                       → rejected
   *   • the same authority written twice    → rejected (distinctness, not arity)
   *   • two authorities, one reachable from the other in the REAL static
   *     import graph                        → rejected
   *   • an authority that does not exist    → rejected
   *   • two genuinely independent modules   → ACCEPTED
   *   • two opaque non-path labels          → ACCEPTED
   */
  it('SuiteInvariant_SingleSourceComparison_IsRejected', () => {
    expect(rules(oracle(F.FIXTURE_SINGLE_AUTHORITY))).toContain('oracle-sources-too-few');

    // Distinctness is by RESOLVED IDENTITY, not by token count: `./corpus.ts`
    // and `./corpus.js` are two spellings of one module.
    expect(rules(oracle(F.FIXTURE_SAME_AUTHORITY_TWICE))).toContain('oracle-sources-too-few');

    // A real transitive import edge: registry.ts imports legacy-shape-debt.ts.
    expect(rules(oracle(F.FIXTURE_DERIVED_AUTHORITIES))).toContain('oracle-sources-derived');

    // You may not cite an authority that does not exist.
    expect(rules(oracle(F.FIXTURE_UNRESOLVABLE_AUTHORITY))).toContain(
      'oracle-sources-unresolvable',
    );

    // Opaque labels whose derivation is DECLARED (not inferred) are rejected.
    expect(rules(oracle(F.FIXTURE_KNOWN_DERIVED_LABELS))).toContain('oracle-sources-derived');

    // ACCEPTANCE — the rule is discriminating, not blanket.
    expect(oracle(F.FIXTURE_INDEPENDENT_AUTHORITIES)).toEqual([]);
    expect(oracle(F.FIXTURE_OPAQUE_AUTHORITIES)).toEqual([]);
  });

  /**
   * NAMED ACCEPTANCE TEST (T-40).
   *
   * DR-30: "Every blocking claim declares the seam its kill fixture kills."
   * This suite's convention (T-37) is a blocking arm paired with a negative
   * twin — the twin IS the kill fixture. The rule demands the twin NAME
   * something: a decorative divider containing the phrase is not a
   * declaration, which is the case that separates this check from a grep.
   */
  it('SuiteInvariant_BlockingClaimWithoutKillFixture_IsRejected', () => {
    expect(rules(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITHOUT_SEAM))).toEqual([
      'blocking-claim-without-kill-fixture',
    ]);

    // The phrase alone does not satisfy it — the seam must be named.
    expect(rules(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITH_EMPTY_TWIN))).toEqual([
      'blocking-claim-without-kill-fixture',
    ]);

    // ACCEPTANCE — both sanctioned declaration forms.
    expect(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITH_TWIN)).toEqual([]);
    expect(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITH_KILL_SEAM)).toEqual([]);
  });

  /**
   * The anti-evasion criterion, pinned against a REAL in-scope file — this
   * one. Scope is recomputed from assertion shape after the annotation is
   * stripped; if scope were annotation-driven the stripped copy would be out
   * of scope and clean, and this assertion would be the one that notices.
   */
  it('SuiteInvariant_DroppingTheAnnotation_DoesNotDropTheObligation', () => {
    const self = readFileSync(SELF_ABS, 'utf8');

    // Precondition: this file really is in scope, and really is compliant.
    expect(isInScope(self)).toBe(true);
    expect(parseOracleDeclarations(self).length).toBeGreaterThan(0);
    expect(checkOracleSources(SELF_ABS, self, { knownDerivations: KNOWN_DERIVATIONS })).toEqual([]);

    // Now delete every declaration, changing nothing else.
    const stripped = self.split('@oracle-sources').join('@removed-annotation');
    expect(parseOracleDeclarations(stripped)).toEqual([]);

    // Still in scope — because scope came from the assertions, not the comment.
    expect(isInScope(stripped)).toBe(true);
    expect(matchedShapes(stripped)).toEqual(matchedShapes(self));
    expect(
      rules(checkOracleSources(SELF_ABS, stripped, { knownDerivations: KNOWN_DERIVATIONS })),
    ).toEqual(['oracle-sources-missing']);
  });

  it('SuiteInvariant_MissingAnnotationOnInScopeFile_IsRejected', () => {
    expect(rules(oracle(F.FIXTURE_NO_ANNOTATION))).toEqual(['oracle-sources-missing']);
    // A test that asserts none of the covered properties owes nothing.
    expect(isInScope(F.FIXTURE_OUT_OF_SCOPE)).toBe(false);
    expect(oracle(F.FIXTURE_OUT_OF_SCOPE)).toEqual([]);
  });

  /**
   * DR-30: "No test asserts `passed === true` where the verdict was 'could not
   * run'." The negative arm is the load-bearing one: a test that BUILDS a
   * could-not-run carrier to prove the system refuses it must NOT be flagged.
   */
  it('SuiteInvariant_PassedTrueOnCouldNotRunVerdict_IsRejected', () => {
    expect(rules(checkCouldNotRunVerdicts(FIXTURE_PATH, F.FIXTURE_PASSED_TRUE_INLINE))).toEqual([
      'passed-true-on-could-not-run',
    ]);
    expect(rules(checkCouldNotRunVerdicts(FIXTURE_PATH, F.FIXTURE_PASSED_TRUE_BY_BINDING))).toEqual(
      ['passed-true-on-could-not-run'],
    );
    expect(
      checkCouldNotRunVerdicts(FIXTURE_PATH, F.FIXTURE_COULD_NOT_RUN_NEGATIVE_FIXTURE),
    ).toEqual([]);
  });

  /**
   * Handed over by T-36: "no synthesized dispatch context" was enforced BY
   * CONSTRUCTION, not by assertion. Now it is an assertion.
   */
  it('SuiteInvariant_SynthesizedIntegrationRoot_IsRejected', () => {
    expect(rules(checkNoSynthesizedRoot(FIXTURE_PATH, F.FIXTURE_SYNTHESIZED_CONTEXT))).toEqual([
      'synthesized-dispatch-context',
    ]);
    expect(rules(checkNoSynthesizedRoot(FIXTURE_PATH, F.FIXTURE_MOCKED_COMPOSITE))).toEqual([
      'composite-module-mocked',
    ]);
    expect(checkNoSynthesizedRoot(FIXTURE_PATH, F.FIXTURE_HARNESS_DRIVEN)).toEqual([]);
  });

  /**
   * The shape catalogue is itself ratcheted (DR-30). Deleting a shape — the
   * cheapest way to make an inconvenient file fall out of scope — fails here.
   */
  it('SuiteInvariant_CoveredShapeList_CannotShrink', () => {
    const live = new Set(COVERED_SHAPES.map((s) => s.id));
    const dropped = SHAPE_RATCHET.filter((r) => !live.has(r.id)).map((r) => r.id);
    expect(dropped).toEqual([]);
    // Every live shape must be ratcheted too, so a shape cannot be added
    // without a floor and then quietly neutered.
    const ratcheted = new Set(SHAPE_RATCHET.map((r) => r.id));
    expect(COVERED_SHAPES.filter((s) => !ratcheted.has(s.id)).map((s) => s.id)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PART 2 — CORPUS SWEEP AND RATCHET
// ────────────────────────────────────────────────────────────────────────────

describe('DR-30 part 2 — the real corpus', () => {
  const corpus = loadCorpus();
  const inScopeFiles = corpus.filter((f) => matchedShapes(f.source).length > 0);

  /** DR-30 acceptance criterion 1: cover all three roots, report the denominator. */
  it('SuiteInvariant_ScanRootsAndDenominator_AreReportedAndRatcheted', () => {
    const perRoot = SCAN_ROOTS.map((r) => ({
      root: r.id,
      mandatedByDr30: r.mandatedByDr30,
      files: corpus.filter((f) => f.root === r.id).length,
    }));

    // eslint-disable-next-line no-console
    console.log(
      '\n── DR-30 scan denominator ──────────────────────────────────────\n' +
        perRoot.map((p) => `  ${p.root.padEnd(12)} ${String(p.files).padStart(4)}`).join('\n') +
        `\n  ${'TOTAL'.padEnd(12)} ${String(corpus.length).padStart(4)}` +
        `\n  in scope by assertion shape: ${inScopeFiles.length}` +
        `\n  annotated: ${inScopeFiles.filter((f) => parseOracleDeclarations(f.source).length > 0).length}` +
        `\n  registered as accepted gaps: ${new Set(ACCEPTED_GAPS.flatMap((g) => g.files)).size}` +
        '\n────────────────────────────────────────────────────────────────',
    );

    // All three DR-30-mandated roots are present and non-empty.
    const mandated = SCAN_ROOTS.filter((r) => r.mandatedByDr30).map((r) => r.id);
    // `tools/conformance` joined the mandated set when task 018a extracted the
    // suite out of `mcp/src`. It is mandated rather than optional because these
    // files were already governed here — dropping the mandate would have let a
    // directory move discharge DR-30 coverage.
    // The two `src` roots became one when task 019 dissolved the nested
    // package — they had already been the same directory, walked twice.
    // `tests/unit` and `tests/integration` joined when task 030 lifted the
    // co-located suites out of `src`, on the same reasoning as
    // `tools/conformance`: the files were governed before they moved.
    // `src` left the mandated set in task 030 — it holds no `*.test.ts` at all
    // now, and a root that cannot contribute cannot be required to.
    expect(mandated).toEqual([
      'tests/unit',
      'tests/integration',
      'test',
      'tools/evals',
      'tools/conformance',
    ]);
    for (const id of mandated) {
      expect(corpus.filter((f) => f.root === id).length).toBeGreaterThan(0);
    }

    // The denominator is ratcheted: a root cannot be quietly emptied.
    const belowFloor = CORPUS_FLOORS.filter(
      (f) => corpus.filter((c) => c.root === f.root).length < f.floor,
    ).map((f) => `${f.root} < ${f.floor}`);
    expect(belowFloor).toEqual([]);
    expect(inScopeFiles.length).toBeGreaterThanOrEqual(IN_SCOPE_FLOOR);
  });

  /**
   * THE ANTI-VACUITY TOOTH. A scanner that matches nothing reports perfect
   * compliance. Every covered shape must still match at least its ratcheted
   * floor of real corpus files; break a matcher and this goes red before any
   * "0 violations" verdict is believed.
   */
  it('SuiteInvariant_ShapeMatchers_AreNotVacuousAgainstTheRealCorpus', () => {
    const counts = new Map<string, number>();
    for (const f of corpus) {
      for (const id of matchedShapes(f.source)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const starved = SHAPE_RATCHET.filter(
      (r) => (counts.get(r.id) ?? 0) < r.corpusFloor,
    ).map((r) => `${r.id}: matched ${counts.get(r.id) ?? 0}, floor ${r.corpusFloor}`);
    expect(starved).toEqual([]);
  });

  /**
   * The same tooth for the kill-fixture rule: it is only meaningful if the
   * corpus actually contains blocking claims for it to police.
   */
  it('SuiteInvariant_BlockingClaimCensus_IsNotEmpty', () => {
    let blocks = 0;
    for (const f of corpus) {
      const { comments } = sourceViews(f.source);
      for (const b of extractTestBlocks(f.source)) {
        if (BLOCKING_CLAIM_MARKER.test(comments.slice(b.docStart, b.end))) blocks += 1;
      }
    }
    expect(blocks).toBeGreaterThanOrEqual(BLOCKING_CLAIM_CENSUS_FLOOR);
  });

  it('SuiteInvariant_NoBlockingClaimInTheCorpusLacksAKillFixture', () => {
    const offenders = corpus.flatMap((f) =>
      checkBlockingClaims(f.abs, f.source).map((v) => `${f.rel}:${v.line} ${v.detail}`),
    );
    expect(offenders).toEqual([]);
  });

  it('SuiteInvariant_NoTestAssertsPassedTrueOnACouldNotRunVerdict', () => {
    const offenders = corpus.flatMap((f) =>
      checkCouldNotRunVerdicts(f.abs, f.source).map((v) => `${f.rel}:${v.line} ${v.detail}`),
    );
    expect(offenders).toEqual([]);
  });

  it('SuiteInvariant_IntegrationTierDoesNotSynthesizeItsOwnRoot', () => {
    const suppressed = new Set(
      ACCEPTED_GAPS.filter(
        (g) =>
          g.suppresses.includes('synthesized-dispatch-context') ||
          g.suppresses.includes('composite-module-mocked'),
      ).flatMap((g) => g.files),
    );
    const offenders = corpus
      .filter((f) => f.rel.includes('/test/integration/'))
      .filter((f) => !suppressed.has(f.rel))
      .flatMap((f) => checkNoSynthesizedRoot(f.abs, f.source).map((v) => `${f.rel} ${v.detail}`));
    expect(offenders).toEqual([]);
  });

  /**
   * The ratchet proper. Every in-scope file must either declare its
   * authorities or be an explicitly registered, owned, expiring gap. New debt
   * is not on the list, so new debt fails.
   */
  it('SuiteInvariant_NoUnregisteredOracleSourcesDebt', () => {
    const excused = new Set(
      ACCEPTED_GAPS.filter((g) => g.suppresses.includes('oracle-sources-missing')).flatMap(
        (g) => g.files,
      ),
    );
    const unregistered = corpus
      .filter((f) => !excused.has(f.rel))
      .flatMap((f) =>
        checkOracleSources(f.abs, f.source, { knownDerivations: KNOWN_DERIVATIONS }).map(
          (v) => `${f.rel}:${v.line} [${v.rule}] ${v.detail}`,
        ),
      );
    expect(unregistered).toEqual([]);
  });

  /**
   * The ratchet may only turn one way. An entry that has been fixed, has
   * fallen out of scope, or no longer exists is STALE, and staleness is a
   * failure — there is no way to leave a closed gap parked in the register.
   */
  it('SuiteInvariant_AcceptedGapRegister_CanOnlyShrink', () => {
    const byRel = new Map(corpus.map((f) => [f.rel, f]));
    const stale: string[] = [];
    for (const gap of ACCEPTED_GAPS) {
      if (!gap.suppresses.includes('oracle-sources-missing')) continue;
      for (const rel of gap.files) {
        const f = byRel.get(rel);
        if (!f) {
          stale.push(`${gap.id}: '${rel}' no longer exists — remove the entry`);
          continue;
        }
        if (matchedShapes(f.source).length === 0) {
          stale.push(`${gap.id}: '${rel}' no longer matches any covered shape — remove the entry`);
          continue;
        }
        if (parseOracleDeclarations(f.source).length > 0) {
          stale.push(`${gap.id}: '${rel}' is now annotated — remove the entry`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it('SuiteInvariant_EveryAcceptedGapCarriesAnOwnerAndAnExpiry', () => {
    const anchor = Date.parse(REGISTER_ANCHOR);
    const horizon = anchor + MAX_GAP_HORIZON_DAYS * 86_400_000;
    const malformed = ACCEPTED_GAPS.flatMap((g) => {
      const problems: string[] = [];
      if (g.owner.trim().length === 0) problems.push('empty owner');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(g.expires)) problems.push(`bad expiry '${g.expires}'`);
      else if (Date.parse(g.expires) > horizon) {
        problems.push(`expiry '${g.expires}' is parked beyond the ${MAX_GAP_HORIZON_DAYS}-day horizon`);
      }
      if (g.why.trim().length < 40) problems.push('rationale too thin to review');
      if (g.closedBy.trim().length === 0) problems.push('no closing requirement');
      return problems.map((p) => `${g.id}: ${p}`);
    });
    expect(malformed).toEqual([]);
  });

  it('SuiteInvariant_NoAcceptedGapHasExpired', () => {
    const now = Date.now();
    const expired = ACCEPTED_GAPS.filter((g) => Date.parse(g.expires) < now).map(
      (g) => `${g.id} expired ${g.expires} (owner: ${g.owner}; closed by ${g.closedBy})`,
    );
    expect(expired).toEqual([]);
  });

  /**
   * DR-30's last acceptance criterion. The three named Class B instances must
   * be visible as INDIVIDUALLY owned, individually expiring entries — not
   * amortised into the 317-file bulk backlog where they would be, in DR-30's
   * words, "silently exempt".
   */
  it('SuiteInvariant_KnownClassBInstances_AreIndividuallyRegisteredNotBulkExempt', () => {
    const bulk = new Set(LEGACY_SHAPE_DEBT);
    const named = [
      'class-b/projection-containment',
      'class-b/contract-drift-guard',
      'class-b/oracle-fixtures',
    ];
    const byId = new Map(ACCEPTED_GAPS.map((g) => [g.id, g]));
    const problems: string[] = [];
    for (const id of named) {
      const gap = byId.get(id);
      if (!gap) {
        problems.push(`${id}: not registered at all`);
        continue;
      }
      if (gap.files.length === 0) problems.push(`${id}: registered with no files`);
      if (!/DR-\d+/.test(gap.closedBy)) problems.push(`${id}: does not name the DR that closes it`);
      for (const rel of gap.files) {
        if (bulk.has(rel)) problems.push(`${id}: '${rel}' is also in the bulk backlog`);
        const f = corpus.find((c) => c.rel === rel);
        if (!f) problems.push(`${id}: '${rel}' not found in the corpus`);
        else if (matchedShapes(f.source).length === 0) {
          problems.push(`${id}: '${rel}' matches no covered shape — the catalogue cannot see it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  /** The guard is inside the surface it governs. */
  it('SuiteInvariant_MetaTestIsInsideItsOwnScanRoot', () => {
    const self = corpus.find((f) => f.rel === SELF_REL);
    expect(self, `${SELF_REL} must be part of the scanned corpus`).toBeDefined();
    expect(matchedShapes(self?.source ?? '').length).toBeGreaterThan(0);
    expect(LEGACY_SHAPE_DEBT).not.toContain(SELF_REL);
    expect(
      checkOracleSources(self?.abs ?? '', self?.source ?? '', {
        knownDerivations: KNOWN_DERIVATIONS,
      }),
    ).toEqual([]);
  });

  /** Guards against a mis-typed path silently disabling an entry. */
  it('SuiteInvariant_EveryRegisteredFilePathResolves', () => {
    const known = new Set(corpus.map((f) => f.rel));
    const missing = ACCEPTED_GAPS.flatMap((g) =>
      g.files.filter((rel) => !known.has(rel)).map((rel) => `${g.id}: ${rel}`),
    );
    expect(missing).toEqual([]);
    expect(toRel(SELF_ABS)).toBe(SELF_REL);
  });
});
