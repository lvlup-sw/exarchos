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
  collectModuleSpecifiers,
  countSdkImportSpecifiers,
  countCommandLiterals,
  countWithCappedShapeDeclarations,
  resolveRungProbe,
  DERIVATIONS,
  EXIT_PASS,
  EXIT_FAIL,
  EXIT_GAPS,
  // @ts-expect-error — `.mjs` gate script with JSDoc types only, deliberately not
  // compiled: `node scripts/check-measured-premises.mjs` is the failable path.
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
    // The fixture's literals are frozen (asserted above). Its DERIVED side is
    // not — it is the live tree, and the live tree legitimately moves.
    expect(new Set(vacuous.map((c) => c.literal))).toEqual(new Set([109]));
    expect(new Set(total.map((c) => c.literal))).toEqual(new Set([123]));
    expect(new Set(substantive.map((c) => c.literal))).toEqual(new Set([12]));

    // ── WHY THIS IS A PARTITION AND NOT A FIXED LIST (task 068, 2026-08-07) ──
    //
    // This block used to name which claims drift and which agree. That was a
    // claim about the LIVE TREE dressed up as a claim about the fixture, and the
    // tree falsified it in both directions at once when task 068 registered the
    // `invariants_amend` verb and its `invariant.amended` event:
    //
    //   • `output-schema-total` — the tree grew 122 -> 123, so rev 3's WRONG
    //     literal of 123 now AGREES. A stale number the tree happened to grow
    //     into. Nothing about rev 3 became more correct.
    //   • `event-types-total`  — the tree grew 170 -> 171, so rev 3's literal of
    //     170, which this test asserted was RIGHT, now drifts.
    //
    // Pinning either verdict re-creates the defect this whole program exists to
    // remove: an assertion that passes for a reason unrelated to the property it
    // names. The two properties the fixture actually has to carry are invariant
    // under tree growth, so assert exactly those two and nothing more.
    const dr4 = [...vacuous, ...total, ...substantive];
    const cli = claimsNamed(report, 'cli-handwritten-literals');
    const events = claimsNamed(report, 'event-types-total');
    expect(cli.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    const all = [...dr4, ...cli, ...events];

    // 1. NOT A PASS on a document proven wrong. At least one claim must drift,
    //    and every drift must be a real literal/derived disagreement.
    const drifted = all.filter((c) => c.verdict === 'drifted');
    expect(drifted.length, 'a document known wrong must produce at least one drift').toBeGreaterThan(
      0,
    );
    for (const claim of drifted) {
      expect(claim.literal, `${claim.name}@${claim.line}`).not.toBe(claim.derived);
    }

    // 2. NOT BLANKET REJECTION. A checker that fails every claim on a wrong
    //    document is a checker that is not reading the claims. At least one
    //    must agree — and if the tree ever drifts so that NONE does, this
    //    fixture has stopped discriminating and the failure says so rather than
    //    the fixture quietly becoming a rubber stamp.
    const agreed = all.filter((c) => c.verdict === 'agree');
    expect(
      agreed.length,
      'the fixture no longer discriminates — every claim drifts, so it cannot show the checker reads claims',
    ).toBeGreaterThan(0);
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

    // DR-7 (task 078) — and the verdict survives the PROCESS boundary. The
    // report said `gaps` all along; `exitCode` said 0, which is the only thing
    // a runner reads, so `npm run validate` recorded PASS for it. Each verdict
    // now owns a code: pass 0, fail 1, gaps 3.
    expect(report.exitCode).toBe(3);
    expect(report.exitCode).not.toBe(0);
  });

  it('MeasuredPremises_GapToleration_MovesConsequenceNeverTheVerdict', () => {
    // The CI lane tolerates gaps while the rungs are unprobed. The toleration
    // is DATED and enforced by the gate, and — the property that matters — it
    // can only change the exit code. `verdict` stays `gaps` in every arm, so no
    // caller can make this report claim a pass.
    const document = [
      '| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |',
      '|---|---|---|---|---|---|---|',
      '| Unprobed | all | Bad | 2 — types<!-- rung-probe: none --> | X | Y | Z |',
      '',
      'One claim keeps the denominator non-empty: <!-- measured: demo -->7<!-- /measured -->.',
      '',
    ].join('\n');
    const run = (extra: Record<string, unknown>): Report =>
      checkMeasuredPremises({
        documents: [{ path: 'synthetic.md', text: document }],
        derive: (name: string) => (name === 'demo' ? 7 : undefined),
        isKnownDerivation: (name: string) => name === 'demo',
        ...extra,
      }) as Report;

    const live = run({ tolerateGapsUntil: '2026-11-30', today: '2026-08-09' });
    expect(live.verdict).toBe('gaps');
    expect(live.exitCode).toBe(0);

    const expired = run({ tolerateGapsUntil: '2026-08-08', today: '2026-08-09' });
    expect(expired.verdict).toBe('gaps');
    expect(expired.exitCode).toBe(1);

    // The last tolerated day is INCLUSIVE.
    expect(run({ tolerateGapsUntil: '2026-08-09', today: '2026-08-09' }).exitCode).toBe(0);

    // Untolerated is the default, and it is the distinct gaps code.
    expect(run({ today: '2026-08-09' }).exitCode).toBe(3);

    // A toleration NEVER rescues a real failure — only `gaps`.
    const drifted = checkMeasuredPremises({
      documents: [{ path: 'synthetic.md', text: document }],
      derive: (name: string) => (name === 'demo' ? 999 : undefined),
      isKnownDerivation: (name: string) => name === 'demo',
      tolerateGapsUntil: '2099-01-01',
      today: '2026-08-09',
    }) as Report;
    expect(drifted.verdict).toBe('fail');
    expect(drifted.exitCode).toBe(1);
  });

  it('MeasuredPremises_CiLaneToleration_IsDatedAndStillLive', () => {
    // Binds the workflow's declared date to the gate that enforces it. Without
    // this, the lane's `--tolerate-gaps-until` could silently expire (turning
    // the lane red) or be dropped entirely (turning gaps back into a code
    // nobody handles) with nothing to say so.
    const ci = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const invocations = ci
      .split('\n')
      .filter((l) => l.includes('check-measured-premises.mjs') && l.includes('run:'));
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      const m = /--tolerate-gaps-until\s+(\d{4}-\d{2}-\d{2})/.exec(line);
      expect(m, `CI invokes the gate without a dated gap toleration: ${line.trim()}`).not.toBeNull();
      expect(
        m![1] > new Date().toISOString().slice(0, 10),
        `The CI lane's gap toleration expired on ${m![1]} — probe the obligation rungs or re-date it.`,
      ).toBe(true);
    }
  });

  it('MeasuredPremises_GapsVerdict_ExitsDistinctFromPass', () => {
    // Asserted against the REAL CLI on the REAL DR-27 scope, because the defect
    // was in what the process returned, not in what the pure function computed.
    // Whichever verdict today's tree produces, the code must identify it — and
    // `gaps` must never share a code with `pass`.
    const { status, report } = runCli([]);
    expect(['pass', 'gaps', 'fail']).toContain(report.verdict);
    expect(status).toBe(report.exitCode);
    if (report.verdict === 'gaps') {
      expect(status).toBe(EXIT_GAPS);
      expect(status).not.toBe(EXIT_PASS);
    } else if (report.verdict === 'pass') {
      expect(status).toBe(EXIT_PASS);
    } else {
      expect(status).toBe(EXIT_FAIL);
    }
    // Distinctness read off the PRODUCTION constants, not off local literals —
    // `new Set([0, 1, 3])` is a statement about the test file and survives any
    // renumbering of the codes it claims to be checking.
    expect(new Set([EXIT_PASS, EXIT_FAIL, EXIT_GAPS]).size).toBe(3);
  }, 300_000);

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
    //
    // The two declaration sites are wrapped in a real object literal (task 061):
    // the derivation now PARSES, and bare `outputSchema: …,` fragments are not a
    // program. The discriminating content is unchanged — the JSDoc mention and
    // the function's own definition must still not count.
    const source = [
      '/** See {@link withCappedShape}. */',
      'export function withCappedShape(outputSchema: z.ZodType): z.ZodType { return outputSchema; }',
      'export const registry = {',
      '  a: { outputSchema: withCappedShape(AOutputSchema) },',
      '  b: { outputSchema:withCappedShape(BOutputSchema) },',
      '};',
    ].join('\n');
    expect(countWithCappedShapeDeclarations(source)).toBe(2);
  });

  // ── task 061: the scanner parses specifiers, it does not match text ────────

  /**
   * The predicate `sdkImportFiles` used before task 061, restated here verbatim
   * so the SIZE of the defect is pinned and not merely its absence.
   *
   * Restating it in the test rather than keeping dead code in the gate is
   * deliberate: the superseded behaviour is a claim about history, and a claim
   * about history belongs with the assertion that history was wrong.
   */
  function rawTextScannerCountedFile(source: string): number {
    return source.includes('@modelcontextprotocol/sdk') ? 1 : 0;
  }

  const COMMENT_ONLY_MENTION = [
    '/**',
    ' * Historical note: this module used to import `@modelcontextprotocol/sdk`',
    ' * directly before the seam existed.',
    ' */',
    "import { z } from 'zod';",
    'export const marker = z.string();',
  ].join('\n');

  const REAL_IMPORT = [
    '/**',
    ' * Historical note: this module used to import `@modelcontextprotocol/sdk`',
    ' * directly before the seam existed.',
    ' */',
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { z } from 'zod';",
    'export const marker = z.string();',
  ].join('\n');

  it('SdkImportScan_PackageNamedOnlyInComment_CountsZeroWhereRawTextCountedOne', () => {
    // THE KILL FIXTURE. Two files that differ by exactly one line: one names the
    // package only in prose, the other actually imports it. A scanner that
    // measures imports must separate them; a scanner that measures text cannot.
    expect(countSdkImportSpecifiers(COMMENT_ONLY_MENTION, 'comment-only.ts')).toBe(0);
    expect(countSdkImportSpecifiers(REAL_IMPORT, 'real-import.ts')).toBe(1);

    // And the defect being closed, stated as a number rather than as a story:
    // the superseded predicate answered 1 for BOTH, so it could not tell an
    // import site from a sentence about one.
    expect(rawTextScannerCountedFile(COMMENT_ONLY_MENTION)).toBe(1);
    expect(rawTextScannerCountedFile(REAL_IMPORT)).toBe(1);
  });

  it('SdkImportScan_SpecifierInsideStringOrTemplateLiteral_IsNotAnImportSite', () => {
    // Not hypothetical: `architecture/sdk-generation-seam.test.ts` holds ten
    // SDK import STATEMENTS inside template literals — they are the lint's own
    // fixtures, the input it lints, not imports the module makes. The raw-text
    // scanner counted that file; every regex over specifiers that ignores
    // literal context counts its ten sites.
    const fixtureBearingModule = [
      "import { describe } from 'vitest';",
      'const MIXED_FIXTURE = `',
      "import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';",
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      '`;',
      'const single = "@modelcontextprotocol/sdk/types.js";',
      'export { MIXED_FIXTURE, single, describe };',
    ].join('\n');

    expect(countSdkImportSpecifiers(fixtureBearingModule, 'fixtures.test.ts')).toBe(0);
    expect(rawTextScannerCountedFile(fixtureBearingModule)).toBe(1);
  });

  it('SdkImportScan_EveryImportForm_IsResolvedNotOnlyStaticFrom', () => {
    // Totality in the other direction. Parsing removes false positives; it must
    // not buy that by introducing false negatives, so every form the tree can
    // spell an import in is asserted present. A parse that silently missed
    // `export … from` or a dynamic `import()` would UNDER-report, which is the
    // worse failure: it reads as migration progress.
    const everyForm = [
      "import a from '@modelcontextprotocol/sdk/a.js';",
      "import type { B } from '@modelcontextprotocol/sdk/b.js';",
      "import '@modelcontextprotocol/sdk/c.js';",
      "export { d } from '@modelcontextprotocol/sdk/d.js';",
      "export * from '@modelcontextprotocol/sdk/e.js';",
      "const f = await import('@modelcontextprotocol/sdk/f.js');",
      "const g = require('@modelcontextprotocol/sdk/g.js');",
      "import h = require('@modelcontextprotocol/sdk/h.js');",
      'export { a, f, g, h };',
    ].join('\n');
    expect(countSdkImportSpecifiers(everyForm, 'every-form.ts')).toBe(8);

    // Package identity is exact-or-subpath, so a differently-named package that
    // merely shares the prefix is not the v1 SDK.
    const neighbouringPackage = [
      "import x from '@modelcontextprotocol/sdk-next';",
      "import y from '@modelcontextprotocol/core';",
      'export { x, y };',
    ].join('\n');
    expect(countSdkImportSpecifiers(neighbouringPackage, 'neighbour.ts')).toBe(0);
    expect(collectModuleSpecifiers(neighbouringPackage, 'neighbour.ts')).toEqual([
      '@modelcontextprotocol/sdk-next',
      '@modelcontextprotocol/core',
    ]);
  });

  it('SdkImportScan_ScanRootResolvingNoFiles_ThrowsRatherThanReportingZero', () => {
    // Non-empty denominator, DR-26's own rule applied to DR-27's instrument. A
    // relocated `src/` resolves zero files, reports zero import sites, and reads
    // as a COMPLETED migration. The derivation must refuse to answer instead.
    const derivation = (DERIVATIONS as Record<string, { fn?: (root: string) => number }>)[
      'sdk-import-sites'
    ];
    expect(derivation?.fn).toBeTypeOf('function');
    expect(() => derivation!.fn!(path.join(REPO_ROOT, 'no-such-tree'))).toThrow(
      /scan root .* does not exist|resolved 0/,
    );

    // And the empty answer is not reachable by another door: the checker treats
    // a derivation that cannot run as a FAILURE, never as a missing number.
    const report = checkMeasuredPremises({
      documents: [
        {
          path: 'synthetic.md',
          text: [
            '| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |',
            '|---|---|---|---|---|---|---|',
            '| P | all | Bad | 2 — types<!-- rung-probe: none --> | X | Y | Z |',
            '',
            'Claim: <!-- measured: sdk-import-sites -->23<!-- /measured -->.',
            '',
          ].join('\n'),
        },
      ],
      derive: () => {
        throw new Error('scan root resolved 0 TypeScript files');
      },
      isKnownDerivation: () => true,
    }) as Report;
    expect(report.claims[0]?.verdict).toBe('derivation-unavailable');
    expect(report.verdict).toBe('fail');
  });

  it('CommandLiteralScan_CallSiteInsideStringLiteral_IsNotCounted', () => {
    // The sweep of the OTHER `kind: 'scan'` derivations required by task 061.
    // `cli-handwritten-literals` already blanked COMMENTS, but blanking
    // deliberately preserved string and template literals — so a call site
    // written inside a string still counted, and a nested template desynced the
    // hand-rolled lexer outright. Both are the same text-versus-parse class.
    const callSiteInsideAString = [
      'const doc = ".command(\'ghost\')";',
      "program.command('real');",
      'export { doc };',
    ].join('\n');
    expect(countCommandLiterals(callSiteInsideAString, 'strings.ts')).toBe(1);

    const nestedTemplate = [
      "const t = `x${`.command('ghost')`}z`;",
      "program.command('real');",
      'export { t };',
    ].join('\n');
    expect(countCommandLiterals(nestedTemplate, 'nested-template.ts')).toBe(1);
  });

  it('WithCappedShapeScan_DeclarationInsideStringLiteral_IsNotCounted', () => {
    // Same sweep, second derivation. `withcappedshape-count` shared the
    // comment-blanking predecessor and therefore shared its blind spot.
    const source = [
      'const snippet = "outputSchema: withCappedShape(GhostSchema)";',
      'const template = `outputSchema: withCappedShape(OtherGhostSchema)`;',
      'export const registry = { a: { outputSchema: withCappedShape(RealSchema) } };',
      'export { snippet, template };',
    ].join('\n');
    expect(countWithCappedShapeDeclarations(source, 'registry-like.ts')).toBe(1);
  });

  it('SourceScan_ModuleThatDoesNotParse_ThrowsRatherThanUnderCounting', () => {
    // `ts.createSourceFile` never throws: handed broken input it returns a
    // partial tree with nodes missing, so a derivation over a recovered parse
    // reports a number BELOW the truth and still reads green. An under-counting
    // premise is strictly worse than an over-counting one.
    expect(() =>
      countSdkImportSpecifiers("import { a from '@modelcontextprotocol/sdk';", 'broken.ts'),
    ).toThrow(/did not parse cleanly/);
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
