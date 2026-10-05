import { describe, it, expect } from 'vitest';
import { isPidAlive } from '../../../src/utils/process.js';

describe('isPidAlive', () => {
  it('IsPidAlive_CurrentProcess_ReturnsTrue', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  /** The test assumes that no process has PID 999999. */
  it('IsPidAlive_DeadPid_ReturnsFalse', () => {
    expect(isPidAlive(999999)).toBe(false);
  });

  it('IsPidAlive_InvalidPid_ReturnsFalse', () => {
    expect(isPidAlive(-1)).toBe(false);
  });
});
