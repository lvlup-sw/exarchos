import { describe, it, expect } from 'vitest';
import { isPidAlive } from '../../utils/process.js';

describe('isPidAlive', () => {
  it('IsPidAlive_CurrentProcess_ReturnsTrue', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('IsPidAlive_DeadPid_ReturnsFalse', () => {
    // PID 999999 is extremely unlikely to be alive
    expect(isPidAlive(999999)).toBe(false);
  });

  it('IsPidAlive_InvalidPid_ReturnsFalse', () => {
    expect(isPidAlive(-1)).toBe(false);
  });
});
