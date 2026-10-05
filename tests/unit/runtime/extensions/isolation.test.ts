import { describe, it, expect } from 'vitest';
import { IsolationPolicySchema, evaluateIsolation } from '../../../../src/runtime/extensions/isolation.js';

describe('evaluateIsolation (P03-08 posture-boundary integration)', () => {
  /** The `task-isolated` posture grants `fs:read` and `fs:write`. */
  it('Isolation_CapabilitiesSubsetOfPosture_Contained', () => {
    const policy = IsolationPolicySchema.parse({
      allowedCapabilities: ['fs:read', 'fs:write'],
      filesystem: 'worktree',
      network: false,
    });
    expect(evaluateIsolation(policy, 'task-isolated').contained).toBe(true);
  });

  /** The `read-only` posture grants only `fs:read` and `mcp:exarchos:readonly`, so `shell:exec` is an escalation. */
  it('Isolation_CapabilityOutsidePosture_FailsClosed', () => {
    const policy = IsolationPolicySchema.parse({
      allowedCapabilities: ['fs:read', 'shell:exec'],
      filesystem: 'none',
      network: false,
    });
    const result = evaluateIsolation(policy, 'read-only');
    expect(result.contained).toBe(false);
    if (!result.contained) expect(result.detail).toContain('shell:exec');
  });

  it('Isolation_FilesystemReachWithoutFsRead_FailsClosed', () => {
    const policy = IsolationPolicySchema.parse({
      allowedCapabilities: [],
      filesystem: 'worktree',
      network: false,
    });
    const result = evaluateIsolation(policy, 'task-isolated');
    expect(result.contained).toBe(false);
    if (!result.contained) expect(result.detail).toContain('fs:read');
  });

  it('Isolation_EmptyReach_Contained', () => {
    const policy = IsolationPolicySchema.parse({
      allowedCapabilities: [],
      filesystem: 'none',
      network: false,
    });
    expect(evaluateIsolation(policy, 'read-only').contained).toBe(true);
  });
});
