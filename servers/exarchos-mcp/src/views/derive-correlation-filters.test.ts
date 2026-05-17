// Wave 2 (#1448, item 2) — deriveCorrelationFilters helper.
//
// Pins the explicit-args-win + AsyncLocalStorage-default contract for the
// telemetry view handlers. The helper centralises the inline filter spread
// block that currently appears in 6 handlers (Task 5 will refactor each
// handler to call this helper). The default branch (no args + active
// dispatch context) lets agents get auto-scoped telemetry without manually
// threading the correlation tuple back into every view call.

import { describe, it, expect, vi } from 'vitest';
import { deriveCorrelationFilters } from './tools.js';
import {
  runWithDispatchContext,
  mintDispatchContext,
} from '../dispatch/dispatch-context.js';
import { logger } from '../logger.js';

describe('deriveCorrelationFilters', () => {
  it('DeriveCorrelationFilters_ExplicitArgs_PassesThroughUnchanged', () => {
    expect(deriveCorrelationFilters({ correlationId: 'cor-x' })).toEqual({
      correlationId: 'cor-x',
    });
    expect(deriveCorrelationFilters({ operationId: 'op-x' })).toEqual({
      operationId: 'op-x',
    });
    expect(deriveCorrelationFilters({ causationId: 'cau-x' })).toEqual({
      causationId: 'cau-x',
    });
    expect(
      deriveCorrelationFilters({
        operationId: 'op',
        correlationId: 'cor',
        causationId: 'cau',
      }),
    ).toEqual({ operationId: 'op', correlationId: 'cor', causationId: 'cau' });
  });

  it('DeriveCorrelationFilters_NoArgsNoContext_ReturnsEmpty', () => {
    expect(deriveCorrelationFilters({})).toEqual({});
  });

  it('DeriveCorrelationFilters_NoArgsWithContext_DefaultsCorrelationId', () => {
    const ctx = mintDispatchContext({ correlationId: 'ctx-cor-1' });
    const result = runWithDispatchContext(ctx, () =>
      deriveCorrelationFilters({}),
    );
    expect(result).toEqual({ correlationId: 'ctx-cor-1' });
  });

  it('DeriveCorrelationFilters_AnyExplicitArg_DoesNotDefault', () => {
    const ctx = mintDispatchContext({ correlationId: 'ctx-cor-1' });
    const result = runWithDispatchContext(ctx, () =>
      deriveCorrelationFilters({ operationId: 'op-explicit' }),
    );
    expect(result).toEqual({ operationId: 'op-explicit' });
    expect(result).not.toHaveProperty('correlationId');
  });

  it('DeriveCorrelationFilters_NoArgsWithContext_LogsCtxDefault', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const ctx = mintDispatchContext({ correlationId: 'ctx-cor-x' });
      runWithDispatchContext(ctx, () => deriveCorrelationFilters({}));
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'ctx-default',
          correlationId: 'ctx-cor-x',
        }),
        expect.stringContaining('deriveCorrelationFilters'),
      );
    } finally {
      // Always restore — a failing assertion above must not leak the
      // logger.debug spy into sibling tests.
      debugSpy.mockRestore();
    }
  });
});
