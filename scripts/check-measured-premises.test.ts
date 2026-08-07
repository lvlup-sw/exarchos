/**
 * Tests for the DR-27 measured-premise drift gate.
 *
 * Three properties, each pinned by exactly one test:
 *
 *   1. The checker reports the DR-4 counts of a document ALREADY KNOWN TO BE
 *      WRONG as drifted. Rev 3 of the spec asserted 109 vacuous of 123 and
 *      described 12 "typed" declarations; the tree says 112 of 122 and 10. The
 *      rev-3 text is committed as a fixture (annotations transplanted, literals
 *      untouched) so this test is hermetic — it never shells out to git.
 *
 *   2. A run that resolves ZERO annotated claims FAILS. Detection alone would
 *      be insufficient: a deleted annotation block, a renamed document, or a
 *      broken scanner all read green precisely when the instrument has stopped
 *      working.
 *
 *   3. An UNPROBED proof rung is reported as a gap and is NOT a pass. DR-0
 *      failed differently from a stale count — it asserted a rung its subject
 *      could not carry — so "nothing" has to be a reportable answer that is
 *      still distinguishable from "verified".
 *
 * Why the first test spawns the real CLI rather than injecting numbers: the
 * only interesting claim is that rev 3's literals disagree with WHAT THE TREE
 * PRODUCES TODAY. Feeding the expectation in from the test would make the
 * fixture and the oracle the same authority, which proves nothing. The two
 * authorities here are genuinely independent — a committed historical document
 * on one side, the live `TOOL_REGISTRY` census on the other.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkMeasuredPremises,
  scanMeasuredClaims,
  scanObligationRungs,
  parseClaimLiteral,
  countCommandLiterals,
  countWithCappedShapeDeclarations,
  resolveRungProbe,
  DERIVATIONS,
  // @ts-expect-error — dependency-free `.mjs` gate script with JSDoc types only,
  // deliberately not compiled: it must run in the zero-dep unfiltered CI lane.
} from './check-measured-premises.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-measured-premises.mjs');
const REV3_FIXTURE = path.join(
  REPO_ROOT,
  'scripts',
  'test-fixtures',
  'measured-premises',
  'rev3-internal-mechanics-overhaul.md',
);

interface ReportClaim {
  document: string;
  line: number;
  name: string;
  literal: number | undefined;
  derived: number | undefined;
  verdict: string;
}

interface ReportRung {
  property: string;
  rung: string;
  probe: string | undefined;
  verdict: string;
  reason?: string;
}

interface Report {
  verdict: 'pass' | 'gaps' | 'fail';
  exitCode: number;
  claims: ReportClaim[];
  rungs: ReportRung[];
  failures: string[];
  counts: {
    claimsAnnotated: number;
    claimsResolved: number;
    drifted: number;
    rungRows: number;
    rungsProbed: number;
    rungGaps: number;
    rungsUnannotated: number;
  };
}

function runCli(args: string[]): { status: number | null; report: Report; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  let report: Report;
  try {
    report = JSON.parse(result.stdout ?? '') as Report;
  } catch {
    throw new Error(
      `check-measured-premises produced no JSON report.\nstatus: ${result.status}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return { status: result.status, report, stderr: result.stderr ?? '' };
}

function claimsNamed(report: Report, name: string): ReportClaim[] {
  return report.claims.filter((c) => c.name === name);
}

describe('check-measured-premises (task 054, DR-27)', () => {
  it('MeasuredPremises_Rev3Document_ReportsDr4CountsAsDrifted', () => {
    // The fixture is rev 3's committed text with the rev-4 annotations
    // transplanted onto it and its LITERALS LEFT ALONE. Rev 3 is a document
    // proven wrong by measurement; a checker that passes on it has not been
    // shown to work.
    expect(existsSync(REV3_FIXTURE), `missing kill fixture: ${REV3_FIXTURE}`).toBe(true);
    const fixtureText = readFileSync(REV3_FIXTURE, 'utf8');
    // Guard the fixture itself: if a future edit "helpfully" corrects rev 3's
    // numbers, this test would pass for the wrong reason.
    expect(fixtureText).toContain('<!-- measured: output-schema-vacuous -->109<!-- /measured -->');
    expect(fixtureText).toContain('<!-- measured: output-schema-total -->123<!-- /measured -->');
    expect(fixtureText).toContain(
      '<!-- measured: output-schema-substantive -->12<!-- /measured -->',
    );

    const { status, report } = runCli([
      '--document',
      'scripts/test-fixtures/measured-premises/rev3-internal-mechanics-overhaul.md',
    ]);

    expect(report.verdict).toBe('fail');
    expect(status).toBe(1);

    // The three DR-4 claims must ALL be reported drifted, and the derived side
    // must come from the live census — not from anything the fixture says.
    const vacuous = claimsNamed(report, 'output-schema-vacuous');
    const total = claimsNamed(report, 'output-schema-total');
    const substantive = claimsNamed(report, 'output-schema-substantive');

    expect(vacuous.length).toBeGreaterThan(0);
    expect(total.length).toBeGreaterThan(0);
    expect(substantive.length).toBeGreaterThan(0);

    for (const claim of [...vacuous, ...total, ...substantive]) {
      expect(claim.verdict, `${claim.name}@${claim.line}`).toBe('drifted');
      expect(claim.literal).not.toBe(claim.derived);
    }
    expect(new Set(vacuous.map((c) => c.literal))).toEqual(new Set([109]));
    expect(new Set(total.map((c) => c.literal))).toEqual(new Set([123]));
    expect(new Set(substantive.map((c) => c.literal))).toEqual(new Set([12]));

    // Discrimination, not blanket rejection: rev 3 was RIGHT about the CLI
    // literal count and the event-type total, and those must still pass. A
    // checker that fails every claim on a wrong document is a checker that
    // isn't reading the claims.
    const cli = claimsNamed(report, 'cli-handwritten-literals');
    const events = claimsNamed(report, 'event-types-total');
    expect(cli.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    for (const claim of [...cli, ...events]) {
      expect(claim.verdict, `${claim.name}@${claim.line}`).toBe('agree');
    }
  }, 120_000);

  it('MeasuredPremises_ZeroAnnotationsResolved_FailsClosed', () => {
    // A document with an obligation map but not a single measured annotation.
    // Everything else about the run is healthy — which is exactly the case a
    // count-only gate would wave through.
    const document = [
      '# A document with no measured claims',
      '',
      '| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |',
      '|---|---|---|---|---|---|---|',
      '| Something is true | all | Bad | 2 — types<!-- rung-probe: fixture:package.json --> | A type | Compile error | Revert |',
      '',
    ].join('\n');

    const report = checkMeasuredPremises({
      documents: [{ path: 'synthetic.md', text: document }],
      derive: () => {
        throw new Error('derive must not be called when no claim is annotated');
      },
      isKnownDerivation: () => true,
    }) as Report;

    expect(report.counts.claimsAnnotated).toBe(0);
    expect(report.counts.claimsResolved).toBe(0);
    expect(report.verdict).toBe('fail');
    expect(report.exitCode).toBe(1);
    expect(report.failures.some((f) => f.startsWith('EMPTY_DENOMINATOR'))).toBe(true);

    // And it is the EMPTY DENOMINATOR that fails it — not an unrelated
    // complaint. The rung half of this document is healthy.
    expect(report.counts.rungRows).toBe(1);
    expect(report.counts.rungsProbed).toBe(1);
    expect(report.counts.rungGaps).toBe(0);
  });

  it('MeasuredPremises_UnprobedProofRung_ReportsGapNotPass', () => {
    // Three rows, one per rung outcome: a real probe, a declared-`none` probe,
    // and a probe naming a file that is not there. Only the first is a pass.
    const document = [
      '# Obligation map',
      '',
      '| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |',
      '|---|---|---|---|---|---|---|',
      '| Probed property | all | Bad | 3 — structural<!-- rung-probe: fixture:package.json --> | X | Y | Z |',
      '| Unprobed property | all | Bad | 2 — types<!-- rung-probe: none --> | X | Y | Z |',
      '| Dangling property | all | Bad | 1 — generation<!-- rung-probe: fixture:does/not/exist.test.ts --> | X | Y | Z |',
      '',
      'One claim keeps the denominator non-empty: <!-- measured: demo -->7<!-- /measured -->.',
      '',
    ].join('\n');

    const report = checkMeasuredPremises({
      documents: [{ path: 'synthetic.md', text: document }],
      derive: (name: string) => (name === 'demo' ? 7 : undefined),
      isKnownDerivation: (name: string) => name === 'demo',
    }) as Report;

    // The denominator is fine and nothing drifted, so the ONLY thing standing
    // between this run and a clean pass is the unprobed rungs.
    expect(report.counts.claimsResolved).toBe(1);
    expect(report.failures).toEqual([]);

    const byProperty = new Map(report.rungs.map((r) => [r.property, r]));
    expect(byProperty.get('Probed property')?.verdict).toBe('probed');

    const unprobed = byProperty.get('Unprobed property');
    expect(unprobed?.verdict).toBe('gap');
    expect(unprobed?.verdict).not.toBe('probed');
    expect(unprobed?.reason).toBe('declared-unprobed');

    // A probe pointing at a file that does not exist asserts evidence nobody
    // can inspect. That degrades to a gap with a named cause — it must not be
    // credited as a probe.
    const dangling = byProperty.get('Dangling property');
    expect(dangling?.verdict).toBe('gap');
    expect(dangling?.reason).toMatch(/probe-target-missing/);

    // The run-level verdict is `gaps` — explicitly NOT `pass`.
    expect(report.counts.rungGaps).toBe(2);
    expect(report.counts.rungsProbed).toBe(1);
    expect(report.verdict).toBe('gaps');
    expect(report.verdict).not.toBe('pass');

    // `--fail-on-gap` is the ratchet handle: the same input becomes a failure
    // once the program decides unprobed rungs may no longer accumulate.
    const strict = checkMeasuredPremises({
      documents: [{ path: 'synthetic.md', text: document }],
      derive: (name: string) => (name === 'demo' ? 7 : undefined),
      isKnownDerivation: (name: string) => name === 'demo',
      failOnGap: true,
    }) as Report;
    expect(strict.exitCode).toBe(1);
  });

  it('MeasuredPremises_UnregisteredDerivationName_FailsRatherThanSkips', () => {
    // An annotation naming a derivation nobody implements would otherwise be a
    // free pass: invent a name, assert any number. The document may not assert
    // a number nothing produces.
    const document = [
      '| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |',
      '|---|---|---|---|---|---|---|',
      '| P | all | Bad | 2 — types<!-- rung-probe: none --> | X | Y | Z |',
      '',
      'Claim: <!-- measured: no-such-derivation -->4242<!-- /measured -->.',
      '',
    ].join('\n');

    const report = checkMeasuredPremises({
      documents: [{ path: 'synthetic.md', text: document }],
      derive: () => undefined,
      isKnownDerivation: () => false,
    }) as Report;

    expect(report.claims[0]?.verdict).toBe('unknown-derivation');
    expect(report.verdict).toBe('fail');
    expect(report.failures.some((f) => f.includes('no-such-derivation'))).toBe(true);
  });

  it('MeasuredPremises_ObligationRowWithoutProbeAnnotation_FailsAsPartialMap', () => {
    // An unannotated row is not a gap — it is invisible. The map is then
    // partial, which is the rung-side analogue of the empty-denominator rule.
    const document = [
      '| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |',
      '|---|---|---|---|---|---|---|',
      '| Invisible property | all | Bad | 2 — types | X | Y | Z |',
      '',
      'Claim: <!-- measured: demo -->7<!-- /measured -->.',
      '',
    ].join('\n');

    const report = checkMeasuredPremises({
      documents: [{ path: 'synthetic.md', text: document }],
      derive: () => 7,
      isKnownDerivation: () => true,
    }) as Report;

    expect(report.counts.rungsUnannotated).toBe(1);
    expect(report.verdict).toBe('fail');
    expect(report.failures.some((f) => f.includes('no `rung-probe` annotation'))).toBe(true);
  });

  it('MeasuredPremises_LiveScope_IsTheTwoDr27DocumentsOnly', () => {
    // DR-27 scopes the gate to one spec plus the invariants catalog.
    // Generalizing to all of `docs/` is explicitly out of scope and needs its
    // own ADR, so the default scope is pinned rather than left to drift.
    const source = readFileSync(SCRIPT, 'utf8');
    const scope = source
      .slice(source.indexOf('export const DEFAULT_DOCUMENTS'))
      .slice(0, 400);
    expect(scope).toContain('docs/specs/2026-08-06-internal-mechanics-overhaul.md');
    expect(scope).toContain('.exarchos/invariants.md');
    expect(scope).not.toContain('docs/**');
  });

  it('MeasuredPremises_CommandLiteralScan_IgnoresCommentedCallSites', () => {
    // The measured claim is 11 hand-written literals in `cli.ts`, and a naive
    // `/\.command\(/` counts a JSDoc block that writes `program.command(...)`
    // in prose. A derivation tuned until it reproduces the document's number is
    // the defect DR-27 removes; this pins the comment-blind behaviour instead.
    const source = [
      '/** See `program.command("ghost")` below. */',
      "// program.command('another-ghost')",
      "program.command('real-one');",
      'program.command(derivedName);',
      "const s = 'not // a comment';",
      "program.command('real-two');",
    ].join('\n');
    expect(countCommandLiterals(source)).toBe(2);
  });

  it('MeasuredPremises_WithCappedShapeScan_CountsDeclarationsNotDefinition', () => {
    // `registry.ts` carries the function's own declaration and a JSDoc mention
    // alongside the real declaration sites. Counting bare `withCappedShape(`
    // would report the definition as a declaration.
    const source = [
      '/** See {@link withCappedShape}. */',
      'export function withCappedShape(outputSchema: z.ZodType): z.ZodType { return outputSchema; }',
      '  outputSchema: withCappedShape(AOutputSchema),',
      '  outputSchema:withCappedShape(BOutputSchema),',
    ].join('\n');
    expect(countWithCappedShapeDeclarations(source)).toBe(2);
  });

  it('MeasuredPremises_MalformedProbeDeclaration_IsRejectedNotIgnored', () => {
    expect(resolveRungProbe('none')).toEqual({ status: 'gap', reason: 'declared-unprobed' });
    expect(resolveRungProbe('fixture:package.json').status).toBe('probed');
    expect(resolveRungProbe('nonsense').status).toBe('malformed');
    expect(resolveRungProbe('fixture:').status).toBe('malformed');
    expect(resolveRungProbe('wat:something').status).toBe('malformed');
  });

  it('MeasuredPremises_AnnotationGrammar_ParsesNamesLiteralsAndRungRows', () => {
    const claims = scanMeasuredClaims(
      'a <!-- measured: x-y -->1,613<!-- /measured --> b <!--measured:z-->7<!--/measured-->',
    ) as { name: string; raw: string }[];
    expect(claims.map((c) => c.name)).toEqual(['x-y', 'z']);
    expect(parseClaimLiteral(claims[0]!.raw)).toBe(1613);
    expect(parseClaimLiteral(claims[1]!.raw)).toBe(7);
    expect(parseClaimLiteral('~90%')).toBeUndefined();

    const map = scanObligationRungs(
      [
        '| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |',
        '|---|---|---|---|---|---|---|',
        '| P | all | Bad | 2 — types<!-- rung-probe: none --> | X | Y | Z |',
      ].join('\n'),
    ) as { found: boolean; rows: { property: string; rung: string; probes: string[] }[] };
    expect(map.found).toBe(true);
    expect(map.rows).toHaveLength(1);
    expect(map.rows[0]!.property).toBe('P');
    expect(map.rows[0]!.rung).toBe('2 — types');
    expect(map.rows[0]!.probes).toEqual(['none']);
  });

  it('MeasuredPremises_EveryAnnotatedNameInScope_ResolvesToADeclaredDerivation', () => {
    // Totality across the live documents: every name the spec uses must be
    // bound. This is the one assertion that would catch a rename on the code
    // side after the annotation was already written.
    const names = new Set<string>();
    for (const relative of [
      'docs/specs/2026-08-06-internal-mechanics-overhaul.md',
      '.exarchos/invariants.md',
    ]) {
      const abs = path.join(REPO_ROOT, relative);
      if (!existsSync(abs)) continue;
      for (const claim of scanMeasuredClaims(readFileSync(abs, 'utf8')) as { name: string }[]) {
        names.add(claim.name);
      }
    }
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(Object.keys(DERIVATIONS as Record<string, unknown>)).toContain(name);
    }
  });
});
