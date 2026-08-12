/**
 * The green baseline every later reconciliation in the structure refactor
 * compares against.
 *
 * The danger this guards is not a failing test — it is a baseline that records
 * failures without naming them. Twenty-six unexplained failures in a baseline
 * are indistinguishable from twenty-six the refactor caused, and every oracle
 * built on top of it inherits that ambiguity.
 *
 * So the exclusions are enumerated, and each one is checked to still have a
 * subject. An exclusion whose file or test has disappeared is permanent cover
 * for whatever moves in next, which is worse than no exclusion at all.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const NESTED_ROOT = path.join(REPO_ROOT, 'servers/exarchos-mcp');

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
  it('Baseline_OracleEnvironment_IsPinnedToAReproducibleRun', () => {
    // "Green on my machine" is not an oracle. Pinning to a named CI run is
    // what makes the baseline something a second person can verify.
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

  it('Baseline_ExclusionHeadline_MatchesTheEnumeratedList', () => {
    // A headline count that drifts from the list is how "26 known failures"
    // quietly becomes cover for a 27th.
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

  it('Baseline_EveryExcludedFile_StillExists', () => {
    // The liveness tooth. An exclusion pointing at a deleted file stops
    // excluding anything and starts excusing everything.
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

  it('Baseline_ExclusionScope_IsConfinedToTheStatedSubsystem', () => {
    // The justification is that these are one local-only cluster. If an
    // exclusion appears outside it, the justification no longer covers it.
    const outside = entries
      .map(([file]) => file)
      .filter((file) => !/merge-orchestrate|store\.race/.test(file));

    expect(outside, 'exclusions outside the merge-orchestrate cluster').toEqual([]);
  });

  it('Baseline_WindowsLeg_IsTrackedRatherThanOmitted', () => {
    // Task 001 asks for Linux and Windows. Only Linux plus CI was captured, so
    // the gap is recorded — an oracle that silently covered one platform would
    // let a Windows-only breakage read as a clean baseline.
    expect(baseline.windowsLeg.status).toBe('outstanding');
    expect(baseline.windowsLeg.reason.length).toBeGreaterThan(0);
  });

  it('Baseline_ExclusionReason_StatesWhatVoidsIt', () => {
    // An exclusion with no stated expiry condition never expires.
    expect(baseline.excludedFromOracle.reason).toMatch(/CI/);
    expect(JSON.stringify(baseline.excludedFromOracle)).toMatch(/blocks|void/);
  });
});
