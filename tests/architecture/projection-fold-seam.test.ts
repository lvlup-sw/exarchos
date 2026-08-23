/**
 * The guard for the class #1855 belongs to: a projection-derived answer that
 * escapes to a caller with no evidence its fold covers the durable event tail.
 *
 * The class has two instances. CB-8 served a cancelled workflow at
 * `plan-review` from a fold 500 seconds behind. The mechanism built to answer
 * CB-8 then inverted it — the answer was withheld permanently rather than
 * served stalely, on a lag of one event. Two instances make it a property of
 * the system rather than an incident, so the fix is structural: `foldToTail`
 * establishes coverage before any answer, and this guard is what keeps a
 * caller from going around it.
 *
 * The rule is DATA (`tools/audit/projection-fold-seam.json`). This file decides
 * only how the rule is enforced, so an exemption can be reviewed as an
 * allowlist entry with an owner and an expiry rather than as a code change.
 *
 * ## Why the vacuity assertions are not ceremony
 *
 * A structural guard fails open. If the walk finds nothing, the violation set
 * is empty and the guard reports pass — with no coverage at all. That shape has
 * bitten this repository repeatedly, so three assertions carry the weight:
 *
 *   1. The population is corroborated by `git ls-files`, which throws on empty.
 *   2. The seam's entry point must have real callers. A guard protecting a seam
 *      nobody uses forbids a bypass of nothing.
 *   3. The kill fixture — the pre-fix bypass, verbatim — must be REPORTED, by
 *      the same scanner that reads `src/**`, not by a parallel branch. If a
 *      refactor makes the scanner blind to that shape, this goes red here
 *      instead of going quiet in production.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { lexModule } from '../../tools/test-helpers/module-lexer.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Policy {
  readonly seam: {
    readonly module: string;
    readonly entryPoint: string;
    readonly definitionModule: string;
  };
  readonly forbiddenMembers: readonly { readonly member: string }[];
  readonly permittedMembers: readonly { readonly member: string }[];
  readonly allowlist: readonly {
    readonly file: string;
    readonly members: readonly string[];
    readonly owner: string;
    readonly expiry: string;
  }[];
  readonly killFixture: { readonly path: string; readonly expectedMember: string };
  readonly minimumCallSites: number;
  readonly minimumScannedFiles: number;
}

const POLICY: Policy = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'tools/audit/projection-fold-seam.json'), 'utf8'),
) as Policy;

interface Call {
  readonly file: string;
  readonly member: string;
  readonly line: number;
}

/**
 * Every call to a forbidden member in one file.
 *
 * Reads the LEXED source, not the raw text. The doc comments on this seam name
 * `materialize` repeatedly and the policy file quotes the member names, so a
 * raw-text scan would charge the documentation of the rule with breaking it.
 * `maskedSource` blanks comments and string bodies while preserving offsets, so
 * a line number still points at the real call.
 *
 * The leading `.` is what separates a CALL from a DECLARATION: `materializeAt<T>(`
 * inside the class is the method being defined, `this.materializeAt<T>(` is a use
 * of it.
 */
function findForbiddenCalls(relativePath: string, source: string): Call[] {
  const { maskedSource } = lexModule(source, path.basename(relativePath));
  const calls: Call[] = [];
  for (const { member } of POLICY.forbiddenMembers) {
    const pattern = new RegExp(`\\.${member}\\s*(?:<[^;()]*>\\s*)?\\(`, 'g');
    for (const match of maskedSource.matchAll(pattern)) {
      calls.push({
        file: relativePath,
        member,
        line: maskedSource.slice(0, match.index).split('\n').length,
      });
    }
  }
  return calls;
}

/** Files the seam is defined in, which necessarily use its own members. */
const EXEMPT_MODULES: ReadonlySet<string> = new Set([
  POLICY.seam.module,
  POLICY.seam.definitionModule,
]);

function isAllowlisted(call: Call): boolean {
  return POLICY.allowlist.some(
    (entry) => entry.file === call.file && entry.members.includes(call.member),
  );
}

function scanSource(): { files: string[]; calls: Call[] } {
  const files = listTrackedFiles(REPO_ROOT, {
    extensions: ['.ts'],
    exclude: (relative) => !relative.startsWith('src/') || relative.endsWith('.d.ts'),
  });
  const calls = files.flatMap((file) =>
    findForbiddenCalls(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')),
  );
  return { files, calls };
}

describe('projection fold seam', () => {
  it('ProjectionFoldSeam_NoSourceFile_BypassesTheTailCoveringFold', () => {
    const { files, calls } = scanSource();

    // (1) Denominator. An empty walk makes every assertion below vacuously
    // true, which is precisely how this guard would fail open.
    expect(
      files.length,
      'the guard scanned an implausibly small population — the walk is broken, not the code',
    ).toBeGreaterThanOrEqual(POLICY.minimumScannedFiles);

    const violations = calls
      .filter((call) => !EXEMPT_MODULES.has(call.file))
      .filter((call) => !isAllowlisted(call));

    expect(
      violations,
      'a cached fold was obtained outside `foldToTail`, so its answer carries no ' +
        'evidence that it covers the durable event tail. Route it through ' +
        `${POLICY.seam.module}, or add an allowlist entry with an owner and an expiry.`,
    ).toEqual([]);
  });

  it('ProjectionFoldSeam_EntryPoint_HasRealCallers', () => {
    // (2) A guard that forbids bypassing a seam nobody calls forbids nothing.
    const callers = listTrackedFiles(REPO_ROOT, {
      extensions: ['.ts'],
      exclude: (relative) => !relative.startsWith('src/'),
    }).filter((file) => {
      if (file === POLICY.seam.module) return false;
      const { maskedSource } = lexModule(
        readFileSync(path.join(REPO_ROOT, file), 'utf8'),
        path.basename(file),
      );
      return new RegExp(`\\b${POLICY.seam.entryPoint}\\s*(?:<[^;()]*>\\s*)?\\(`).test(maskedSource);
    });

    expect(
      callers.length,
      `${POLICY.seam.entryPoint} has no production caller — the seam is dead and the ` +
        'guard above is protecting nothing',
    ).toBeGreaterThanOrEqual(POLICY.minimumCallSites);
  });

  it('ProjectionFoldSeam_KillFixture_IsReportedByTheSameScanner', () => {
    // (3) The self-test. The pre-fix bypass, run through the SAME function that
    // reads `src/**`. A scanner that has gone blind fails here.
    const fixture = readFileSync(path.join(REPO_ROOT, POLICY.killFixture.path), 'utf8');
    const reported = findForbiddenCalls(POLICY.killFixture.path, fixture);

    expect(
      reported.map((call) => call.member),
      'the kill fixture is the evidence that this guard detects the real defect shape',
    ).toContain(POLICY.killFixture.expectedMember);
  });

  it('ProjectionFoldSeam_BoundedReadMembers_AreExemptByNameNotByOversight', () => {
    // A bounded read (`asOf`, correlation-filtered) answers as of an explicit
    // bound by design; forcing tail coverage on it would break the bounded-read
    // contract itself. The exemption has to be a decision recorded in the
    // policy, not a member the scanner happens not to look for.
    const forbidden = new Set(POLICY.forbiddenMembers.map((entry) => entry.member));
    const permitted = POLICY.permittedMembers.map((entry) => entry.member);

    expect(permitted, 'the policy records no permitted members at all').not.toEqual([]);
    for (const member of permitted) {
      expect(forbidden.has(member), `${member} is both forbidden and permitted`).toBe(false);
    }
    expect(permitted).toContain('materializeFresh');

    // And the exemption is load-bearing: bounded reads really do still call it.
    const bounded = findForbiddenCalls(
      'probe.ts',
      'const view = materializer.materializeFresh<T>(VIEW, bounded);',
    );
    expect(bounded, 'a permitted member must not be reported as a violation').toEqual([]);
  });

  it('ProjectionFoldSeam_AllowlistEntries_CarryAnOwnerAndAnUnexpiredDate', () => {
    for (const entry of POLICY.allowlist) {
      expect(entry.owner, `${entry.file} has no owner`).toBeTruthy();
      expect(entry.expiry, `${entry.file} has no expiry`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        Date.parse(entry.expiry),
        `the allowlist entry for ${entry.file} expired on ${entry.expiry}`,
      ).toBeGreaterThan(Date.now());
    }
  });
});
