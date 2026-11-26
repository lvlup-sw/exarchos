import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPidAlive } from '../../../src/utils/process.js';

describe('isPidAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  /** `EPERM` means that the process exists and belongs to another user, so the process is alive. */
  it('IsPidAlive_KillThrowsEperm_ReturnsTrue', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    expect(isPidAlive(4242)).toBe(true);
  });

  /** `ESRCH` means that no process has the pid. */
  it('IsPidAlive_KillThrowsEsrch_ReturnsFalse', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    expect(isPidAlive(4242)).toBe(false);
  });
});
