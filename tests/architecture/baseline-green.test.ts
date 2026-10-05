/**
 * The green baseline that each later reconciliation compares against.
 *
 * The hazard is a baseline that records failures and does not name them.
 * Unexplained failures in a baseline look the same as failures that a later
 * change causes.
 *
 * Thus the baseline lists each exclusion, and this suite checks that each one
 * still has a subject. An exclusion for a deleted file or test excuses the
 * next failure that takes its name.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
/** The root that the baseline paths resolve against. It is the repository root. */
const NESTED_ROOT = REPO_ROOT;

type Baseline = {
  tree: string;
  oracleEnvironment: string;
  referenceCiRun: { workflow: string; headSha: string; conclusion: string; url: string };
  rootSuite: { files: number; tests: number; failures: number };
  excludedFromOracle: {
    count: number;
    files: number;
    reason: string;
    byFile: Record<string, string[]>;
  };
  windowsLeg: { status: string; reason: string };
};

const baseline = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/baseline-green.json'), 'utf8'),
) as Baseline;

const entries = Object.entries(baseline.excludedFromOracle.byFile);

describe('the green baseline', () => {
  /** A second person can verify a named CI run. A green run on one machine is not an oracle. */
  it('Baseline_OracleEnvironment_IsPinnedToAReproducibleRun', () => {
    expect(baseline.oracleEnvironment).toBe('ci');
    expect(baseline.referenceCiRun.conclusion).toBe('success');
    expect(baseline.referenceCiRun.url).toMatch(/^https:\/\/github\.com\//);
    expect(baseline.referenceCiRun.headSha.length).toBeGreaterThanOrEqual(7);
  });

  it('Baseline_RootSuite_IsRecordedGreen', () => {
    expect(baseline.rootSuite.failures).toBe(0);
    expect(baseline.rootSuite.files).toBeGreaterThan(100);
    expect(baseline.rootSuite.tests).toBeGreaterThan(1000);
  });

  /** If the headline count drifts from the list, one more failure can hide behind the count. */
  it('Baseline_ExclusionHeadline_MatchesTheEnumeratedList', () => {
    const named = entries.flatMap(([, tests]) => tests);

    expect(named).toHaveLength(baseline.excludedFromOracle.count);
    expect(entries).toHaveLength(baseline.excludedFromOracle.files);
  });

  it('Baseline_EveryExclusion_NamesAFileAndAtLeastOneTest', () => {
    for (const [file, tests] of entries) {
      expect(file, 'an exclusion with no file').toBeTruthy();
      expect(tests.length, `exclusion for ${file} names no test`).toBeGreaterThan(0);
    }
  });

  /** Liveness check. An exclusion for a deleted file excludes nothing and can excuse a later failure. */
  it('Baseline_EveryExcludedFile_StillExists', () => {
    const missing = entries
      .map(([file]) => file)
      .filter((file) => !fs.existsSync(path.join(NESTED_ROOT, file)));

    expect(missing, 'excluded files no longer present').toEqual([]);
  });

  it('Baseline_EveryExcludedTest_StillExistsInItsFile', () => {
    const orphans: string[] = [];

    for (const [file, tests] of entries) {
      const source = fs.readFileSync(path.join(NESTED_ROOT, file), 'utf8');
      for (const name of tests) {
        if (!source.includes(name)) orphans.push(`${file} > ${name}`);
      }
    }

    expect(orphans, 'excluded tests no longer present in their file').toEqual([]);
  });

  /** The stated reason covers one local-only cluster. It does not cover an exclusion outside that cluster. */
  it('Baseline_ExclusionScope_IsConfinedToTheStatedSubsystem', () => {
    const outside = entries
      .map(([file]) => file)
      .filter((file) => !/merge-orchestrate|store\.race/.test(file));

    expect(outside, 'exclusions outside the merge-orchestrate cluster').toEqual([]);
  });

  /**
   * The baseline holds Linux and CI results only, so it must record the
   * Windows gap. Without that record, a Windows-only failure reads as a clean
   * baseline.
   */
  it('Baseline_WindowsLeg_IsTrackedRatherThanOmitted', () => {
    expect(baseline.windowsLeg.status).toBe('outstanding');
    expect(baseline.windowsLeg.reason.length).toBeGreaterThan(0);
  });

  /** An exclusion that states no expiry condition never expires. */
  it('Baseline_ExclusionReason_StatesWhatVoidsIt', () => {
    expect(baseline.excludedFromOracle.reason).toMatch(/CI/);
    expect(JSON.stringify(baseline.excludedFromOracle)).toMatch(/blocks|void/);
  });
});
