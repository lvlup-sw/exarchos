/**
 * Compile-time proofs for the closed results of the import-boundary leg and the taint leg, and for the static-analysis carrier.
 * Each `@ts-expect-error` asserts that a shape is a type error. If the shape compiles, the directive is unused, and `tsc` fails with TS2578.
 * `tests/tsconfig.json` checks `core/**`, so `npm run typecheck` checks this file.
 * The positive controls carry no directive, so they must compile.
 * The runtime `it` at the end only lets vitest collect the file.
 */
import { it, expect } from 'vitest';

import { assertNever } from '../../../src/contract/error-families.js';
import {
  positiveCount,
  type AdvisorySkip,
  type BoundaryLintResult,
  type PositiveCount,
  type RawIoTaintResult,
} from '../../../src/verbs/pure/static-analysis.js';
import type { StaticAnalysisCarrier } from '../../../src/verbs/gates/static-analysis.js';

// @ts-expect-error — a boundary PASS carries the count of the modules that the scan checked.
const _passWithNoCount: BoundaryLintResult = { status: 'PASS', detail: '0 modules checked' };
void _passWithNoCount;

// @ts-expect-error — a plain number is not a positive count, so a PASS cannot carry a count that no check made.
const _passWithAPlainNumber: BoundaryLintResult = { status: 'PASS', cruised: 0, detail: '0 modules checked' };
void _passWithAPlainNumber;

// @ts-expect-error — the count constructor refuses a literal 0.
const _zeroCount = positiveCount(0);
void _zeroCount;

// @ts-expect-error — the old shape, a skip with a degraded flag, is not a boundary result.
const _oldSkip: BoundaryLintResult = { status: 'SKIP', degraded: true, detail: 'dependency-cruiser gave no verdict' };
void _oldSkip;

// @ts-expect-error — a boundary result with no verdict names a cause from the closed list.
const _unknownCause: BoundaryLintResult = { status: 'NO_VERDICT', cause: 'crashed', detail: 'it crashed' };
void _unknownCause;

// @ts-expect-error — a boundary FAIL names its cause.
const _failWithNoCause: BoundaryLintResult = { status: 'FAIL', detail: '1 violation' };
void _failWithNoCause;

// @ts-expect-error — only the boundary leg scans roots, so the taint leg cannot give a zero-module result.
const _taintZeroModules: RawIoTaintResult = { status: 'NO_VERDICT', cause: 'zero-modules', detail: 'no module' };
void _taintZeroModules;

// @ts-expect-error — a taint FAIL names a cause from its closed list.
const _taintUnknownCause: RawIoTaintResult = { status: 'FAIL', cause: 'crashed', detail: 'semgrep exited 2' };
void _taintUnknownCause;

// @ts-expect-error — an advisory skip names the closed cause of its leg.
const _skipWithNoCause: AdvisorySkip = { name: 'Import boundaries', detail: 'it ran out of memory' };
void _skipWithNoCause;

// @ts-expect-error — a static-analysis carrier states its completeness, so the runner always has a mark to copy.
const _carrierWithNoCompleteness: StaticAnalysisCarrier = { verdict: 'pass', passed: true, passCount: 3, failCount: 0, skipCount: 0, report: 'PASS' };
void _carrierWithNoCompleteness;

// @ts-expect-error — a degraded carrier names each advisory check that gave no verdict.
const _degradedWithNoSkips: StaticAnalysisCarrier = { verdict: 'pass', completeness: 'degraded', passed: true, passCount: 3, failCount: 0, skipCount: 0, report: 'PASS' };
void _degradedWithNoSkips;

// @ts-expect-error — a complete carrier has no advisory check with no verdict.
const _completeWithSkips: StaticAnalysisCarrier = { verdict: 'pass', completeness: 'complete', advisorySkips: [{ name: 'Import boundaries', cause: 'signal', detail: 'SIGKILL' }], passed: true, passCount: 3, failCount: 0, skipCount: 0, report: 'PASS' };
void _completeWithSkips;

// @ts-expect-error — the carrier verdict is closed, so a status of the run is not a verdict.
const _carrierWithARunStatus: StaticAnalysisCarrier = { verdict: 'skip', completeness: 'complete', passed: false, passCount: 0, failCount: 0, skipCount: 1, report: 'SKIP' };
void _carrierWithARunStatus;

/** A reader that handles only the members with a verdict does not compile, because the other members reach `assertNever`. */
function readsOnlyAVerdict(result: BoundaryLintResult): string {
  switch (result.status) {
    case 'PASS':
    case 'FAIL':
      return result.detail;
    default:
      // @ts-expect-error — the no-verdict and the not-configured members are not handled, so they are not `never` here.
      return assertNever(result, 'BoundaryLintResult');
  }
}
void readsOnlyAVerdict;

/** The positive control: a reader that handles each member compiles. */
function readsEveryMember(result: BoundaryLintResult): string {
  switch (result.status) {
    case 'PASS':
      return String(result.cruised);
    case 'FAIL':
      return result.cause;
    case 'NO_VERDICT':
      return result.cause;
    case 'NOT_CONFIGURED':
      return result.detail;
    default:
      return assertNever(result, 'BoundaryLintResult');
  }
}

/** The positive controls for each member. A count comes only from the constructor. */
const _count: PositiveCount | undefined = positiveCount(2);
const _runtimeCount: PositiveCount | undefined = positiveCount(Number('0'));
const _pass: BoundaryLintResult | undefined =
  _count === undefined ? undefined : { status: 'PASS', cruised: _count, detail: '2 modules checked' };
const _zeroModules: BoundaryLintResult = {
  status: 'NO_VERDICT',
  cause: 'zero-modules',
  detail: 'dependency-cruiser gave no verdict: the scan checked no module',
};
const _configError: BoundaryLintResult = { status: 'FAIL', cause: 'config-or-usage', detail: 'ERROR: bad config' };
const _taintRulesetError: RawIoTaintResult = { status: 'FAIL', cause: 'ruleset-or-usage', detail: 'semgrep exited 7' };
const _taintUnknownExit: RawIoTaintResult = { status: 'FAIL', cause: 'unknown-exit', detail: 'semgrep exited 2' };
const _skip: AdvisorySkip = { name: 'Import boundaries', cause: 'out-of-memory', detail: 'it ran out of memory' };
const _degradedCarrier: StaticAnalysisCarrier = {
  verdict: 'pass',
  completeness: 'degraded',
  advisorySkips: [_skip],
  passed: true,
  passCount: 3,
  failCount: 0,
  skipCount: 0,
  report: 'PASS',
};
const _completeCarrier: StaticAnalysisCarrier = {
  verdict: 'indeterminate',
  completeness: 'complete',
  passed: false,
  passCount: 0,
  failCount: 0,
  skipCount: 0,
  report: 'SKIP',
  skipped: true,
};
void _configError;
void _taintRulesetError;
void _taintUnknownExit;
void _skip;

/** The anchor test, so that vitest collects the file. The proofs above are compile-time only. */
it('BoundaryLintResult_TypeProofs_Compile', () => {
  expect(_count).toBe(2);
  expect(_runtimeCount).toBeUndefined();
  expect(_pass === undefined ? undefined : readsEveryMember(_pass)).toBe('2');
  expect(readsEveryMember(_zeroModules)).toBe('zero-modules');
  expect(_degradedCarrier.advisorySkips).toEqual([_skip]);
  expect(_completeCarrier.advisorySkips).toBeUndefined();
});
