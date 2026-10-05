/**
 * The suite invariants: the suite must not reproduce the defect classes that
 * it exists to catch.
 *
 * Part 1 proves each detector against a positive fixture that it must flag and
 * a negative fixture that it must not flag. Part 2 runs the rules over the real
 * scan roots and prints the denominators. Each shape must match a floor of
 * real files, so a matcher that matches nothing fails.
 *
 * Scope comes from the assertion shapes, never from the annotation (see
 * `shapes.ts`). Otherwise, a deleted annotation deletes the duty.
 *
 * This file asserts census closure over a corpus, so it is in scope by its own
 * rules. Its two authorities are independent: `corpus.ts` reads the
 * repository, and `registry.ts` is hand-written data.
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
const SELF_REL = 'tests/core/integration/suite-invariants.test.ts';

/** A virtual path inside `suite-invariants/`, so the `./x.ts` authorities of the fixtures resolve. */
const FIXTURE_PATH = path.join(HERE, 'suite-invariants', '__fixture__.test.ts');

const rules = (vs: readonly Violation[]): readonly string[] => vs.map((v) => v.rule).sort();
const oracle = (src: string): readonly Violation[] =>
  checkOracleSources(FIXTURE_PATH, src, { knownDerivations: KNOWN_DERIVATIONS });

describe('DR-30 part 1 — every detector is proved able to fire and able not to', () => {
  /**
   * An in-scope test must name at least two distinct authorities, and neither
   * derives from the other. A comparison with one source cannot disagree with
   * itself.
   *
   * The rule rejects one authority, and one module in two spellings. It rejects
   * an authority that the other reaches in the real import graph. It rejects an
   * authority that does not exist, and a declared derivation pair of labels.
   * It accepts two independent modules and two non-path labels, so it does not
   * reject every input.
   */
  it('SuiteInvariant_SingleSourceComparison_IsRejected', () => {
    expect(rules(oracle(F.FIXTURE_SINGLE_AUTHORITY))).toContain('oracle-sources-too-few');

    expect(rules(oracle(F.FIXTURE_SAME_AUTHORITY_TWICE))).toContain('oracle-sources-too-few');

    expect(rules(oracle(F.FIXTURE_DERIVED_AUTHORITIES))).toContain('oracle-sources-derived');

    expect(rules(oracle(F.FIXTURE_UNRESOLVABLE_AUTHORITY))).toContain(
      'oracle-sources-unresolvable',
    );

    expect(rules(oracle(F.FIXTURE_KNOWN_DERIVED_LABELS))).toContain('oracle-sources-derived');

    expect(oracle(F.FIXTURE_INDEPENDENT_AUTHORITIES)).toEqual([]);
    expect(oracle(F.FIXTURE_OPAQUE_AUTHORITIES)).toEqual([]);
  });

  /**
   * Each blocking claim must declare the seam that its kill fixture kills. The
   * convention pairs a blocking arm with a negative twin, and the twin is the
   * kill fixture. The twin must name a seam, so a bare divider that holds only
   * the phrase is rejected. Both declaration forms are accepted.
   */
  it('SuiteInvariant_BlockingClaimWithoutKillFixture_IsRejected', () => {
    expect(rules(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITHOUT_SEAM))).toEqual([
      'blocking-claim-without-kill-fixture',
    ]);

    expect(rules(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITH_EMPTY_TWIN))).toEqual([
      'blocking-claim-without-kill-fixture',
    ]);

    expect(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITH_TWIN)).toEqual([]);
    expect(checkBlockingClaims(FIXTURE_PATH, F.FIXTURE_BLOCKING_WITH_KILL_SEAM)).toEqual([]);
  });

  /**
   * Pins the rule against evasion on a real in-scope file: this one. The first
   * assertions prove that this file is in scope and compliant. Then the test
   * removes each declaration and changes nothing else. The copy must stay in
   * scope with the same shapes, and it must report `oracle-sources-missing`.
   */
  it('SuiteInvariant_DroppingTheAnnotation_DoesNotDropTheObligation', () => {
    const self = readFileSync(SELF_ABS, 'utf8');

    expect(isInScope(self)).toBe(true);
    expect(parseOracleDeclarations(self).length).toBeGreaterThan(0);
    expect(checkOracleSources(SELF_ABS, self, { knownDerivations: KNOWN_DERIVATIONS })).toEqual([]);

    const stripped = self.split('@oracle-sources').join('@removed-annotation');
    expect(parseOracleDeclarations(stripped)).toEqual([]);

    expect(isInScope(stripped)).toBe(true);
    expect(matchedShapes(stripped)).toEqual(matchedShapes(self));
    expect(
      rules(checkOracleSources(SELF_ABS, stripped, { knownDerivations: KNOWN_DERIVATIONS })),
    ).toEqual(['oracle-sources-missing']);
  });

  /** The negative half: a source that matches no covered shape owes no annotation. */
  it('SuiteInvariant_MissingAnnotationOnInScopeFile_IsRejected', () => {
    expect(rules(oracle(F.FIXTURE_NO_ANNOTATION))).toEqual(['oracle-sources-missing']);
    expect(isInScope(F.FIXTURE_OUT_OF_SCOPE)).toBe(false);
    expect(oracle(F.FIXTURE_OUT_OF_SCOPE)).toEqual([]);
  });

  /**
   * No test asserts `passed === true` on a verdict that did not run. The
   * negative arm carries the weight: the rule must not flag a test that builds
   * such a carrier to prove that the system rejects it.
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

  /** The rule flags a synthesized dispatch context and a mocked composite module. */
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
   * The shape list is ratcheted. A deleted shape fails here. Each live shape
   * must also have a ratchet entry, so no shape exists without a floor.
   */
  it('SuiteInvariant_CoveredShapeList_CannotShrink', () => {
    const live = new Set(COVERED_SHAPES.map((s) => s.id));
    const dropped = SHAPE_RATCHET.filter((r) => !live.has(r.id)).map((r) => r.id);
    expect(dropped).toEqual([]);
    const ratcheted = new Set(SHAPE_RATCHET.map((r) => r.id));
    expect(COVERED_SHAPES.filter((s) => !ratcheted.has(s.id)).map((s) => s.id)).toEqual([]);
  });
});

describe('DR-30 part 2 — the real corpus', () => {
  const corpus = loadCorpus();
  const inScopeFiles = corpus.filter((f) => matchedShapes(f.source).length > 0);

  /**
   * Prints the denominator of each scan root. Each mandated root must hold
   * files, and no root in `CORPUS_FLOORS` can fall below its floor. The list of
   * mandated roots is pinned, so a root cannot lose its mandate without an
   * edit here. A root with no `*.test.ts` file, such as `src`, is not mandated.
   */
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

    const mandated = SCAN_ROOTS.filter((r) => r.mandatedByDr30).map((r) => r.id);
    expect(mandated).toEqual([
      'tests/unit',
      'tests/integration',
      'tests',
      'tools/evals',
      'tools/conformance',
    ]);
    for (const id of mandated) {
      expect(corpus.filter((f) => f.root === id).length).toBeGreaterThan(0);
    }

    const belowFloor = CORPUS_FLOORS.filter(
      (f) => corpus.filter((c) => c.root === f.root).length < f.floor,
    ).map((f) => `${f.root} < ${f.floor}`);
    expect(belowFloor).toEqual([]);
    expect(inScopeFiles.length).toBeGreaterThanOrEqual(IN_SCOPE_FLOOR);
  });

  /**
   * A scanner that matches nothing reports perfect compliance. Each covered
   * shape must match at least its floor of real corpus files, so a broken
   * matcher fails here.
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
   * The same floor for the kill-fixture rule. The rule has meaning only when
   * the corpus holds blocking claims.
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
   * The ratchet. Each in-scope file must declare its authorities or be a
   * registered gap with an owner and an expiry date. New debt is not on the
   * list, so it fails.
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
   * The register can only shrink. An entry is stale when its file is
   * annotated, out of scope or gone, and a stale entry fails.
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
   * The three named Class B instances must be separate entries, each with its
   * own owner and expiry date. They must not sit in the bulk backlog. Each
   * entry must name the requirement that closes it. Its files must be in the
   * corpus and match a covered shape.
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
