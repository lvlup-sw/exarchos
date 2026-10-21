/**
 * Compile-time proofs for the run outcome of the kill probe.
 * Each `@ts-expect-error` asserts that a shape is a type error. If the shape compiles, the directive is unused, and `tsc` fails with TS2578.
 * `tests/tsconfig.json` checks `core/**`, so `npm run typecheck` checks this file.
 * The positive controls carry no directive, so they must compile.
 * The runtime `it` at the end only lets vitest collect the file.
 */
import { it, expect } from 'vitest';

import { assertNever } from '../../../src/contract/error-families.js';
import {
  RUN_NO_VERDICT_CAUSES,
  type RunNoVerdictCause,
  type RunOutcome,
  type TestRunFn,
} from '../../../src/verbs/gates/test-adequacy.js';

// @ts-expect-error — a boolean pass is not a run outcome, so a runner cannot fold a run with no verdict into it.
const _booleanFailure: RunOutcome = { passed: false };
void _booleanFailure;

// @ts-expect-error — a runner that returns a boolean pass is not a probe runner.
const _booleanRunner: TestRunFn = async () => ({ passed: true });
void _booleanRunner;

// @ts-expect-error — a run with a verdict is green or red, nothing else.
const _passResult: RunOutcome = { kind: 'ran', result: 'pass' };
void _passResult;

// @ts-expect-error — a run with no verdict names a cause from the closed list.
const _unknownCause: RunOutcome = { kind: 'no-verdict', cause: 'crashed', detail: 'the runner crashed' };
void _unknownCause;

// @ts-expect-error — a run with no verdict carries a detail that names the fact.
const _noDetail: RunOutcome = { kind: 'no-verdict', cause: 'timeout' };
void _noDetail;

/** A reader that handles only the `ran` member does not compile, because the `no-verdict` member reaches `assertNever`. */
function readsOnlyARun(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case 'ran':
      return outcome.result;
    default:
      // @ts-expect-error — the no-verdict member is not handled, so it is not `never` here.
      return assertNever(outcome, 'RunOutcome');
  }
}
void readsOnlyARun;

/** The positive control: a reader that handles both members compiles. */
function readsEveryEnd(outcome: RunOutcome): string {
  switch (outcome.kind) {
    case 'ran':
      return outcome.result;
    case 'no-verdict':
      return outcome.cause;
    default:
      return assertNever(outcome, 'RunOutcome');
  }
}

/** The positive controls for each member. */
const _green: RunOutcome = { kind: 'ran', result: 'green' };
const _red: RunOutcome = { kind: 'ran', result: 'red', stdout: 'out', stderr: 'err' };
const _timeout: RunOutcome = { kind: 'no-verdict', cause: 'timeout', detail: 'the limit is 120000 ms' };
const _runner: TestRunFn = async () => _green;
void _red;
void _runner;

/** The cause list and the cause type are one closed set. */
const _causes: readonly RunNoVerdictCause[] = RUN_NO_VERDICT_CAUSES;

/** The anchor test, so that vitest collects the file. The proofs above are compile-time only. */
it('RunOutcome_TypeProofs_Compile', () => {
  expect(readsEveryEnd(_timeout)).toBe('timeout');
  expect(_causes.length).toBeGreaterThan(0);
});
