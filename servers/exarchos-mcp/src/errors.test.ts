import { describe, it, expect } from 'vitest';

describe('Error Taxonomy', () => {
  it('GetRecoveryStrategy_StateNotFound_ReturnsGuidance', async () => {
    const { getRecoveryStrategy } = await import('./errors.js');
    const strategy = getRecoveryStrategy('STATE_NOT_FOUND');
    expect(typeof strategy).toBe('string');
    expect(strategy.length).toBeGreaterThan(0);
  });

  it('GetRecoveryStrategy_UnknownCode_ReturnsGenericGuidance', async () => {
    const { getRecoveryStrategy } = await import('./errors.js');
    const strategy = getRecoveryStrategy('DOES_NOT_EXIST');
    expect(typeof strategy).toBe('string');
  });

  it('IsRetryable_VersionConflict_ReturnsTrue', async () => {
    const { isRetryable } = await import('./errors.js');
    expect(isRetryable('VERSION_CONFLICT')).toBe(true);
  });

  it('IsRetryable_EventAppendFailed_ReturnsTrue', async () => {
    const { isRetryable } = await import('./errors.js');
    expect(isRetryable('EVENT_APPEND_FAILED')).toBe(true);
  });

  it('IsRetryable_InvalidInput_ReturnsFalse', async () => {
    const { isRetryable } = await import('./errors.js');
    expect(isRetryable('INVALID_INPUT')).toBe(false);
  });

  it('IsRetryable_StateNotFound_ReturnsFalse', async () => {
    const { isRetryable } = await import('./errors.js');
    expect(isRetryable('STATE_NOT_FOUND')).toBe(false);
  });

  it('GetErrorCategory_AllCodesHaveCategory', async () => {
    const { getErrorCategory, ErrorCode } = await import('./errors.js');
    for (const code of Object.values(ErrorCode)) {
      const category = getErrorCategory(code);
      expect(category).toBeDefined();
      expect(typeof category).toBe('string');
    }
  });

  it('ErrorCode_ReExported_MatchesOriginal', async () => {
    const { ErrorCode } = await import('./errors.js');
    const { ErrorCode: OriginalErrorCode } = await import('./workflow/schemas.js');
    expect(ErrorCode).toEqual(OriginalErrorCode);
  });
});
