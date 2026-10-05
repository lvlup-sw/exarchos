/**
 * The guard against a projection-derived answer that reaches a caller with no
 * evidence that its fold covers the durable event tail.
 *
 * `foldToTail` establishes coverage before any answer, and this guard stops a
 * caller that goes around it. The rule is data in
 * `tools/audit/projection-fold-seam.json`. Thus an exemption is an allowlist
 * entry with an owner and an expiry, and not a code change.
 *
 * A structural guard that finds nothing reports a pass. Three assertions
 * prevent that. `git ls-files` corroborates the population. The entry point of
 * the seam must have real callers. The scanner that reads `src/` must also
 * report the kill fixture.
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
    readonly why: string;
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
 * Each call to a forbidden member in one file.
 *
 * The scan reads the lexed source and not the raw text, because the doc
 * comments on the seam name the members. `maskedSource` blanks comments and
 * string bodies and keeps offsets, so a line number points at the real call.
 * The leading `.` separates a call from a declaration. `this.materializeAt<T>(`
 * is a call, and `materializeAt<T>(` in the class is the definition.
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

/** The files that define the seam. They use its members by necessity. */
const EXEMPT_MODULES: ReadonlySet<string> = new Set([
  POLICY.seam.module,
  POLICY.seam.definitionModule,
]);

function isAllowlisted(call: Call): boolean {
  return POLICY.allowlist.some(
    (entry) => entry.file === call.file && entry.members.includes(call.member),
  );
}

async function scanSource(): Promise<{ files: string[]; calls: Call[] }> {
  const files = await listTrackedFiles(REPO_ROOT, {
    extensions: ['.ts'],
    exclude: (relative) => !relative.startsWith('src/') || relative.endsWith('.d.ts'),
  });
  const calls = files.flatMap((file) =>
    findForbiddenCalls(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')),
  );
  return { files, calls };
}

describe('projection fold seam', () => {
  /** The population assertion is the denominator. An empty walk makes the violation assertion vacuously true. */
  it('ProjectionFoldSeam_NoSourceFile_BypassesTheTailCoveringFold', async () => {
    const { files, calls } = await scanSource();

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

  /** A guard for a seam that nothing calls forbids nothing. */
  it('ProjectionFoldSeam_EntryPoint_HasRealCallers', async () => {
    const callers = (
      await listTrackedFiles(REPO_ROOT, {
        extensions: ['.ts'],
        exclude: (relative) => !relative.startsWith('src/'),
      })
    ).filter((file) => {
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

  /** The self-test. The fixture holds the bypass, and the function that scans `src/` must report it. */
  it('ProjectionFoldSeam_KillFixture_IsReportedByTheSameScanner', () => {
    const fixture = readFileSync(path.join(REPO_ROOT, POLICY.killFixture.path), 'utf8');
    const reported = findForbiddenCalls(POLICY.killFixture.path, fixture);

    expect(
      reported.map((call) => call.member),
      'the kill fixture is the evidence that this guard detects the real defect shape',
    ).toContain(POLICY.killFixture.expectedMember);
  });

  /**
   * A bounded read (`asOf`, or filtered by correlation) answers as of an explicit
   * bound, so tail coverage does not apply to it. The policy must record that
   * exemption by name. The last assertion proves that the scanner does not
   * report a call of a permitted member.
   */
  it('ProjectionFoldSeam_BoundedReadMembers_AreExemptByNameNotByOversight', () => {
    const forbidden = new Set(POLICY.forbiddenMembers.map((entry) => entry.member));
    const permitted = POLICY.permittedMembers.map((entry) => entry.member);

    expect(permitted, 'the policy records no permitted members at all').not.toEqual([]);
    for (const member of permitted) {
      expect(forbidden.has(member), `${member} is both forbidden and permitted`).toBe(false);
    }
    expect(permitted).toContain('materializeFresh');

    const bounded = findForbiddenCalls(
      'probe.ts',
      'const view = materializer.materializeFresh<T>(VIEW, bounded);',
    );
    expect(bounded, 'a permitted member must not be reported as a violation').toEqual([]);
  });

  /** An entry with an owner and a date but no `why` records who accepted the risk and not what the risk is. */
  it('ProjectionFoldSeam_AllowlistEntries_CarryARationaleOwnerAndUnexpiredDate', () => {
    for (const entry of POLICY.allowlist) {
      expect(entry.why, `${entry.file} records no reason the seam does not fit`).toBeTruthy();
      expect(entry.owner, `${entry.file} has no owner`).toBeTruthy();
      expect(entry.expiry, `${entry.file} has no expiry`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        Date.parse(entry.expiry),
        `the allowlist entry for ${entry.file} expired on ${entry.expiry}`,
      ).toBeGreaterThan(Date.now());
    }
  });
});
