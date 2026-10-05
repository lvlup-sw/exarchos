// Tests for `deriveCorrelationFilters`, the filter default that the view handlers share.
// Explicit filter args win. With no args, the helper takes the `correlationId` of the active dispatch context.

import { describe, it, expect, vi } from 'vitest';
import { deriveCorrelationFilters } from '../../../../src/projections/views/tools.js';
import {
  runWithDispatchContext,
  mintDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { logger } from '../../../../src/logger.js';

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
      debugSpy.mockRestore();
    }
  });
});
