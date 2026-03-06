import { describe, it, expect } from 'vitest';
import { executeGuard } from './guards.js';
import type { GuardDefinition } from './guards.js';

describe('Custom Guard Execution', () => {
  it('ExecuteGuard_CommandSucceeds_GuardPasses', async () => {
    const guard: GuardDefinition = { command: 'echo ok' };

    const result = await executeGuard(guard);

    expect(result.passed).toBe(true);
    expect(result.output).toBe('ok');
  });

  it('ExecuteGuard_CommandFails_GuardFails', async () => {
    const guard: GuardDefinition = { command: 'exit 1' };

    const result = await executeGuard(guard);

    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('ExecuteGuard_Timeout_GuardFails', async () => {
    const guard: GuardDefinition = { command: 'sleep 10', timeout: 100 };

    const result = await executeGuard(guard);

    expect(result.passed).toBe(false);
    expect(result.error).toBe('timeout');
  }, 10_000);

  it('ExecuteGuard_CommandNotFound_GuardFailsGracefully', async () => {
    const guard: GuardDefinition = {
      command: 'nonexistent_command_xyz_12345',
      description: 'Test guard with nonexistent command',
    };

    const result = await executeGuard(guard);

    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('timeout');
  });
});
