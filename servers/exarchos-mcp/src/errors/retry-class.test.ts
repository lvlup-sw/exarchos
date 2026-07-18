// ─── DR-10 (#1693): Retry-class contract — scoped tests ─────────────────────
//
// Pins the shared transient-vs-conflict contract:
//   - runtime backstop of the compile-time exhaustiveness guarantee,
//   - the two classes' codes + guidance text (STORAGE_BUSY → backoff,
//     CONCURRENCY_CONFLICT → re-read),
//   - fail-open default for unregistered codes,
//   - the `_meta.retryable` axis never disagreeing with the retry class
//     at the `wrapError` boundary (issue #1693 regression clause).

import { describe, it, expect } from 'vitest';
import {
  RetryClass,
  RETRY_CLASS_GUIDANCE,
  ERROR_CODE_RETRY_CLASS,
  TRANSIENT_ERROR_CODES,
  toRetryClass,
  isRetryableClass,
  isRetryableErrorCode,
  describeTransientError,
  type RetryClassValue,
} from './retry-class.js';
import { ErrorCode } from '../workflow/schemas.js';
import { ConcurrencyError } from '../event-store/concurrency-error.js';
import { StorageBusyError } from '../event-store/storage-busy-error.js';
import { wrapError, type ToolResult } from '../format.js';

const RETRY_CLASS_MEMBERS: readonly RetryClassValue[] = Object.values(RetryClass);

describe('retry-class map — exhaustiveness (DR-10)', () => {
  it('RetryClassMap_EveryErrorCode_Exhaustive', () => {
    // The compile-time guarantee is the Record<ErrorCodeValue, RetryClassValue>
    // type; this runtime backstop asserts the map and the registered taxonomy
    // agree EXACTLY — no missing rows, no orphan rows for retired codes.
    const taxonomyCodes = Object.values(ErrorCode).sort();
    const mappedCodes = Object.keys(ERROR_CODE_RETRY_CLASS).sort();
    expect(mappedCodes).toEqual(taxonomyCodes);

    for (const code of taxonomyCodes) {
      const cls = toRetryClass(code);
      expect(RETRY_CLASS_MEMBERS).toContain(cls);
    }
  });

  it('UnregisteredCode_FailsOpen_ToFatalDefault', () => {
    // Total + fail-open over the string domain: an arbitrary handler-domain
    // code resolves (never throws) to the safe do-not-auto-retry default.
    expect(toRetryClass('SOME_FUTURE_HANDLER_CODE')).toBe(RetryClass.FATAL);
    expect(isRetryableErrorCode('SOME_FUTURE_HANDLER_CODE')).toBe(false);
  });
});

describe('retry-class contract — transient vs conflict discrimination', () => {
  it('StorageBusy_RetryClass_BackoffGuidance', () => {
    // STORAGE_BUSY is the transient class: retry the SAME intent after
    // backing off.
    expect(toRetryClass(TRANSIENT_ERROR_CODES.STORAGE_BUSY)).toBe(RetryClass.BACKOFF);
    expect(isRetryableErrorCode(TRANSIENT_ERROR_CODES.STORAGE_BUSY)).toBe(true);

    const guidance = RETRY_CLASS_GUIDANCE[RetryClass.BACKOFF];
    expect(guidance.toLowerCase()).toMatch(/back off/);
    expect(guidance.toLowerCase()).toMatch(/same operation/);

    // Typed-error discrimination used by the orchestrate catch sites.
    const err = new StorageBusyError({
      streamId: 's',
      attempts: 5,
      cause: new Error('SQLITE_BUSY'),
    });
    const desc = describeTransientError(err);
    expect(desc).toBeDefined();
    expect(desc!.code).toBe('STORAGE_BUSY');
    expect(desc!.retryClass).toBe(RetryClass.BACKOFF);
    expect(desc!.summary).toBe('hit storage contention');
    expect(desc!.guidance).toBe(guidance);
    expect(desc!.causeMessage).toBe(err.message);

    // wrapError (site 1) consumes the same map: envelope guidance and class
    // stamp derive from the shared contract, not local prose.
    const envelope = wrapError(err) as ToolResult;
    const e = envelope.error as unknown as Record<string, unknown>;
    expect(e.retryClass).toBe(RetryClass.BACKOFF);
    const fix = e.suggestedFix as { params: { reason: string } };
    expect(fix.params.reason).toBe(guidance);
    const metaBlock = envelope._meta as Record<string, unknown>;
    expect(metaBlock.retryClass).toBe(RetryClass.BACKOFF);
  });

  it('ConcurrencyConflict_RetryClass_ReReadGuidance', () => {
    // CONCURRENCY_CONFLICT is the conflict class: re-read state and
    // re-derive intent before retrying — the original read is stale.
    expect(toRetryClass(TRANSIENT_ERROR_CODES.CONCURRENCY_CONFLICT)).toBe(RetryClass.RE_READ);
    expect(isRetryableErrorCode(TRANSIENT_ERROR_CODES.CONCURRENCY_CONFLICT)).toBe(true);

    const guidance = RETRY_CLASS_GUIDANCE[RetryClass.RE_READ];
    expect(guidance.toLowerCase()).toMatch(/re-read/);
    expect(guidance.toLowerCase()).toMatch(/re-derive/);

    const err = new ConcurrencyError({
      streamId: 'feature/foo',
      reducerId: 'merge-orchestrator@v1',
      expectedVersion: 42,
      actualVersion: 47,
    });
    const desc = describeTransientError(err);
    expect(desc).toBeDefined();
    expect(desc!.code).toBe('CONCURRENCY_CONFLICT');
    expect(desc!.retryClass).toBe(RetryClass.RE_READ);
    expect(desc!.summary).toBe('lost OCC race');
    expect(desc!.guidance).toBe(guidance);
    expect(desc!.causeMessage).toBe(err.message);

    const envelope = wrapError(err) as ToolResult;
    const e = envelope.error as unknown as Record<string, unknown>;
    expect(e.retryClass).toBe(RetryClass.RE_READ);
    const fix = e.suggestedFix as { params: { reason: string } };
    expect(fix.params.reason).toBe(guidance);
    const metaBlock = envelope._meta as Record<string, unknown>;
    expect(metaBlock.retryClass).toBe(RetryClass.RE_READ);
  });

  it('TransientDescriptor_DistinctCodes_ForSiblingErrors', () => {
    // The two sibling typed errors must never collapse into one code or
    // one class — that conflation is the defect DR-10 exists to prevent.
    const c = describeTransientError(
      new ConcurrencyError({ streamId: 's', reducerId: 'r@v1', expectedVersion: 1, actualVersion: 2 }),
    );
    const s = describeTransientError(
      new StorageBusyError({ streamId: 's', attempts: 5, cause: new Error('SQLITE_BUSY') }),
    );
    expect(c!.code).not.toBe(s!.code);
    expect(c!.retryClass).not.toBe(s!.retryClass);
    // Non-transient errors pass through undescribed so catch sites rethrow.
    expect(describeTransientError(new Error('boom'))).toBeUndefined();
    expect(describeTransientError('not-an-error')).toBeUndefined();
  });
});

describe('retry-class vs _meta.retryable — single source of retry truth', () => {
  it('RetryableMeta_NeverDisagreesWithRetryClass', () => {
    // Issue #1693 regression clause: the legacy `_meta.retryable` boolean
    // and the DR-10 retry class must agree at the wrapError boundary for
    // every branch — typed transient, typed conflict, and the generic
    // fallthrough.
    const samples: unknown[] = [
      new ConcurrencyError({ streamId: 's', reducerId: 'r@v1', expectedVersion: 1, actualVersion: 2 }),
      new StorageBusyError({ streamId: 's', attempts: 5, cause: new Error('SQLITE_BUSY') }),
      new Error('unclassified fault'),
      'string-shaped failure',
    ];
    for (const sample of samples) {
      const envelope = wrapError(sample) as ToolResult;
      const metaBlock = envelope._meta as Record<string, unknown>;
      const cls = metaBlock.retryClass as RetryClassValue;
      expect(RETRY_CLASS_MEMBERS).toContain(cls);
      expect(metaBlock.retryable).toBe(isRetryableClass(cls));
    }
  });
});
