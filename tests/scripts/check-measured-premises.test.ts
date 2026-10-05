/**
 * Tests for the measured-premise drift gate, `tools/audit/gates/check-measured-premises.mjs`.
 * Three properties, with one test for each:
 *   1. The checker reports drift for a document that is known to be wrong.
 *      The fixture is a committed copy of revision 3 of the spec, so the test does not call git.
 *   2. `checkMeasuredPremises` fails a run that resolves zero annotated claims.
 *      A deleted annotation block or a broken scanner must not read green.
 *   3. An unprobed proof rung is a gap, not a pass, and the report keeps the two apart.
 *
 * The first test runs the real CLI, so the derived side comes from the live `TOOL_REGISTRY` census.
 * A number from this file on that side makes the fixture and the oracle one authority.
 * The gate is a `.mjs` file with JSDoc types, and `allowJs` infers the types for the import.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

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
} from '../../tools/audit/gates/check-measured-premises.mjs';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'audit', 'gates', 'check-measured-premises.mjs');
const REV3_FIXTURE = path.join(
  REPO_ROOT,
  'tools',
  'audit',
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

async function runCli(args: string[]): Promise<{ status: number | null; report: Report; stderr: string }> {
  const result = await spawnAsync(process.execPath, [SCRIPT, ...args, '--json'], {
    cwd: REPO_ROOT,
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

/**
 * `rawTextScannerCountedFile` is a text-match predicate: it counts a file when the source holds the SDK package name.
 * The SDK scan tests compare it with the parser-based count, to show the cases that a text match gets wrong.
 */
describe('check-measured-premises (task 054, DR-27)', () => {
  /**
   * The fixture is revision 3 of the spec with annotations added and its literals unchanged.
   * The first three assertions guard those literals, so a corrected fixture cannot pass for the wrong reason.
   * The derived side is the live tree, which changes, so the test names no claim that must drift or agree.
   * It asserts only that at least one claim drifts, and that each drift is a real difference between literal and derived value.
   * `MeasuredPremises_LiveLiteral_Agrees` shows that the checker does not reject every claim.
   */
  it('MeasuredPremises_Rev3Document_ReportsDr4CountsAsDrifted', async () => {
    expect(existsSync(REV3_FIXTURE), `missing kill fixture: ${REV3_FIXTURE}`).toBe(true);
    const fixtureText = readFileSync(REV3_FIXTURE, 'utf8');
    expect(fixtureText).toContain('<!-- measured: output-schema-vacuous -->109<!-- /measured -->');
    expect(fixtureText).toContain('<!-- measured: output-schema-total -->123<!-- /measured -->');
    expect(fixtureText).toContain(
      '<!-- measured: output-schema-substantive -->12<!-- /measured -->',
    );

    const { status, report } = await runCli([
      '--document',
      'tools/audit/test-fixtures/measured-premises/rev3-internal-mechanics-overhaul.md',
    ]);

    expect(report.verdict).toBe('fail');
    expect(status).toBe(1);

    const vacuous = claimsNamed(report, 'output-schema-vacuous');
    const total = claimsNamed(report, 'output-schema-total');
    const substantive = claimsNamed(report, 'output-schema-substantive');

    expect(vacuous.length).toBeGreaterThan(0);
    expect(total.length).toBeGreaterThan(0);
    expect(substantive.length).toBeGreaterThan(0);
    expect(new Set(vacuous.map((c) => c.literal))).toEqual(new Set([109]));
    expect(new Set(total.map((c) => c.literal))).toEqual(new Set([123]));
    expect(new Set(substantive.map((c) => c.literal))).toEqual(new Set([12]));

    const dr4 = [...vacuous, ...total, ...substantive];
    const cli = claimsNamed(report, 'cli-handwritten-literals');
    const events = claimsNamed(report, 'event-types-total');
    expect(cli.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    const all = [...dr4, ...cli, ...events];

    const drifted = all.filter((c) => c.verdict === 'drifted');
    expect(drifted.length, 'a document known wrong must produce at least one drift').toBeGreaterThan(
      0,
    );
    for (const claim of drifted) {
      expect(claim.literal, `${claim.name}@${claim.line}`).not.toBe(claim.derived);
    }
  }, 120_000);

  /**
   * A checker that reports every claim as drifted fails the fixture test for the wrong reason.
   * This test takes a value that the checker derived in a fixture run and writes a one-claim document with that value.
   * The claim must agree. A hardcoded literal goes stale when the tree changes.
   */
  it('MeasuredPremises_LiveLiteral_Agrees', async () => {
    const { report: live } = await runCli(['--document', path.relative(REPO_ROOT, REV3_FIXTURE)]);
    const resolved = live.claims.find((c) => typeof c.derived === 'number');
    expect(resolved, 'no claim in the fixture resolved a derived value').toBeDefined();

    const probeDir = mkdtempSync(path.join(tmpdir(), 'measured-premises-live-'));
    const probePath = path.join(probeDir, 'live-literal.md');
    try {
      writeFileSync(
        probePath,
        `# Live-literal probe\n\nThe count is <!-- measured: ${resolved!.name} -->${resolved!.derived}<!-- /measured --> today.\n`,
        'utf8',
      );
      const { report } = await runCli(['--document', probePath]);
      const claims = claimsNamed(report, resolved!.name);
      expect(claims.length, `the probe declared no ${resolved!.name} claim`).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim.verdict, `${claim.name}@${claim.line}`).toBe('agree');
        expect(claim.literal).toBe(claim.derived);
      }
    } finally {
      rmrf(probeDir);
    }
  }, 120_000);

  /**
   * The document has an obligation map and no measured annotation, and its rung side is healthy.
   * The rung counts show that the empty denominator alone fails the run.
   */
  it('MeasuredPremises_ZeroAnnotationsResolved_FailsClosed', () => {
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

    expect(report.counts.rungRows).toBe(1);
    expect(report.counts.rungsProbed).toBe(1);
    expect(report.counts.rungGaps).toBe(0);
  });

  /**
   * Three rows: a real probe, a declared `none` probe, and a probe that names a missing file.
   * Only the first row is a pass. The other two are gaps with a named reason, and the run verdict is `gaps`.
   * Nothing drifts, so the gaps are the only difference from a pass.
   * `gaps` has its own exit code, 3, because a runner reads only the exit code. `failOnGap` changes the code to 1.
   */
  it('MeasuredPremises_UnprobedProofRung_ReportsGapNotPass', () => {
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

    expect(report.counts.claimsResolved).toBe(1);
    expect(report.failures).toEqual([]);

    const byProperty = new Map(report.rungs.map((r) => [r.property, r]));
    expect(byProperty.get('Probed property')?.verdict).toBe('probed');

    const unprobed = byProperty.get('Unprobed property');
    expect(unprobed?.verdict).toBe('gap');
    expect(unprobed?.verdict).not.toBe('probed');
    expect(unprobed?.reason).toBe('declared-unprobed');

    const dangling = byProperty.get('Dangling property');
    expect(dangling?.verdict).toBe('gap');
    expect(dangling?.reason).toMatch(/probe-target-missing/);

    expect(report.counts.rungGaps).toBe(2);
    expect(report.counts.rungsProbed).toBe(1);
    expect(report.verdict).toBe('gaps');
    expect(report.verdict).not.toBe('pass');

    const strict = checkMeasuredPremises({
      documents: [{ path: 'synthetic.md', text: document }],
      derive: (name: string) => (name === 'demo' ? 7 : undefined),
      isKnownDerivation: (name: string) => name === 'demo',
      failOnGap: true,
    }) as Report;
    expect(strict.exitCode).toBe(1);

    expect(report.exitCode).toBe(3);
    expect(report.exitCode).not.toBe(0);
  });

  /**
   * A dated toleration changes only the exit code. `verdict` stays `gaps`, so no caller can make the report claim a pass.
   * The last tolerated day is inclusive, and a run with no toleration exits with the gaps code.
   * A toleration never hides a real failure.
   */
  it('MeasuredPremises_GapToleration_MovesConsequenceNeverTheVerdict', () => {
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

    expect(run({ tolerateGapsUntil: '2026-08-09', today: '2026-08-09' }).exitCode).toBe(0);

    expect(run({ today: '2026-08-09' }).exitCode).toBe(3);

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

  /**
   * Each CI call of the gate must carry a `--tolerate-gaps-until` date that is after today.
   * Thus the test fails when the date expires, and when a call omits the flag.
   */
  it('MeasuredPremises_CiLaneToleration_IsDatedAndStillLive', () => {
    const ci = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const invocations = ci
      .split('\n')
      .filter((l) => l.includes('check-measured-premises.mjs') && l.includes('run:'));
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      const m = /--tolerate-gaps-until\s+(\d{4}-\d{2}-\d{2})/.exec(line);
      expect(m, `CI invokes the gate without a dated gap toleration: ${line.trim()}`).not.toBeNull();
      const until = m?.[1];
      expect(until, `CI invokes the gate without a dated gap toleration: ${line.trim()}`).toBeDefined();
      expect(
        until! > new Date().toISOString().slice(0, 10),
        `The CI lane's gap toleration expired on ${until} — probe the obligation rungs or re-date it.`,
      ).toBe(true);
    }
  });

  /**
   * Runs the real CLI on the default documents, because the exit code of the process is the subject.
   * The exit code must match the verdict that the current tree gives.
   * The distinctness check reads the production constants, so a change that makes two codes equal fails it.
   */
  it('MeasuredPremises_GapsVerdict_ExitsDistinctFromPass', async () => {
    const { status, report } = await runCli([]);
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
    expect(new Set([EXIT_PASS, EXIT_FAIL, EXIT_GAPS]).size).toBe(3);
  }, 300_000);

  /** An annotation with a name that no derivation implements fails. If it passed, a document can assert any number. */
  it('MeasuredPremises_UnregisteredDerivationName_FailsRatherThanSkips', () => {
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

  /** A row with no `rung-probe` annotation is not a gap. It makes the map partial, and the run fails. */
  it('MeasuredPremises_ObligationRowWithoutProbeAnnotation_FailsAsPartialMap', () => {
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

  /** The default scope is one spec and the invariants catalog. A wider scope needs its own ADR, so the test pins the scope. */
  it('MeasuredPremises_LiveScope_IsTheTwoDr27DocumentsOnly', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const scope = source
      .slice(source.indexOf('export const DEFAULT_DOCUMENTS'))
      .slice(0, 400);
    expect(scope).toContain('docs/specs/2026-08-06-internal-mechanics-overhaul.md');
    expect(scope).toContain('.exarchos/invariants.md');
    expect(scope).not.toContain('docs/**');
  });

  /** A `program.command(...)` in a JSDoc block or a line comment is not a call site, and a non-literal argument does not count. */
  it('MeasuredPremises_CommandLiteralScan_IgnoresCommentedCallSites', () => {
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

  /**
   * The JSDoc mention and the definition of `withCappedShape` do not count.
   * The two declaration sites sit in a real object literal, because the derivation parses the source.
   */
  it('MeasuredPremises_WithCappedShapeScan_CountsDeclarationsNotDefinition', () => {
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

  /**
   * The two sources differ by one line: one names the package only in a comment, and the other imports it.
   * The parser-based count tells them apart. The text-match predicate answers 1 for both.
   */
  it('SdkImportScan_PackageNamedOnlyInComment_CountsZeroWhereRawTextCountedOne', () => {
    expect(countSdkImportSpecifiers(COMMENT_ONLY_MENTION, 'comment-only.ts')).toBe(0);
    expect(countSdkImportSpecifiers(REAL_IMPORT, 'real-import.ts')).toBe(1);

    expect(rawTextScannerCountedFile(COMMENT_ONLY_MENTION)).toBe(1);
    expect(rawTextScannerCountedFile(REAL_IMPORT)).toBe(1);
  });

  /**
   * A module can hold SDK import statements inside a template literal or a string, as fixture text.
   * Those statements are not imports of the module, so the count is 0. The text-match predicate counts the file.
   */
  it('SdkImportScan_SpecifierInsideStringOrTemplateLiteral_IsNotAnImportSite', () => {
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

  /**
   * The parser must not miss an import form, because an under-count reads as migration progress.
   * The source holds each form: static, type-only, side-effect, re-export, dynamic `import()` and `require`.
   * The package match is exact or a subpath, so a package that only shares the prefix does not count.
   */
  it('SdkImportScan_EveryImportForm_IsResolvedNotOnlyStaticFrom', () => {
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

  /**
   * A scan root with no files gives zero import sites, which reads as a complete migration. Thus the derivation throws.
   * The checker reports a derivation that cannot run as a failure, not as a missing number.
   */
  it('SdkImportScan_ScanRootResolvingNoFiles_ThrowsRatherThanReportingZero', () => {
    const derivation = (DERIVATIONS as Record<string, { fn?: (root: string) => number }>)[
      'sdk-import-sites'
    ];
    expect(derivation?.fn).toBeTypeOf('function');
    expect(() => derivation!.fn!(path.join(REPO_ROOT, 'no-such-tree'))).toThrow(
      /scan root .* does not exist|resolved 0/,
    );

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

  /** A call site inside a string or a nested template literal does not count. */
  it('CommandLiteralScan_CallSiteInsideStringLiteral_IsNotCounted', () => {
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
    const source = [
      'const snippet = "outputSchema: withCappedShape(GhostSchema)";',
      'const template = `outputSchema: withCappedShape(OtherGhostSchema)`;',
      'export const registry = { a: { outputSchema: withCappedShape(RealSchema) } };',
      'export { snippet, template };',
    ].join('\n');
    expect(countWithCappedShapeDeclarations(source, 'registry-like.ts')).toBe(1);
  });

  /**
   * `ts.createSourceFile` does not throw on broken input. It returns a partial tree, and a count on that tree is too low.
   * Thus the scan throws when the module does not parse cleanly.
   */
  it('SourceScan_ModuleThatDoesNotParse_ThrowsRatherThanUnderCounting', () => {
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

  /**
   * Each measured name in the live documents must be a key of `DERIVATIONS`. This check finds a rename on the code side.
   * When the spec file is absent, the test asserts only that it found no names.
   */
  it('MeasuredPremises_EveryAnnotatedNameInScope_ResolvesToADeclaredDerivation', () => {
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
    const specPresent = existsSync(
      path.join(REPO_ROOT, 'docs/specs/2026-08-06-internal-mechanics-overhaul.md'),
    );
    if (!specPresent) {
      expect(names.size).toBe(0);
      return;
    }
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(Object.keys(DERIVATIONS as Record<string, unknown>)).toContain(name);
    }
  });
});
