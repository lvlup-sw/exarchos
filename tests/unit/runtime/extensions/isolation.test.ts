import { describe, it, expect } from 'vitest';
import { IsolationPolicySchema, evaluateIsolation } from '../../../../src/runtime/extensions/isolation.js';

describe('evaluateIsolation (P03-08 posture-boundary integration)', () => {
  it('Isolation_CapabilitiesSubsetOfPosture_Contained', () => {
    const policy = IsolationPolicySchema.parse({
      allowedCapabilities: ['fs:read', 'fs:write'],
      filesystem: 'worktree',
      network: false,
    });
    // task-isolated grants fs:read + fs:write + shell:exec + isolation:worktree.
    expect(evaluateIsolation(policy, 'task-isolated').contained).toBe(true);
  });

  it('Isolation_CapabilityOutsidePosture_FailsClosed', () => {
    const policy = IsolationPolicySchema.parse({
      allowedCapabilities: ['fs:read', 'shell:exec'],
      filesystem: 'none',
      network: false,
    });
    // read-only grants only fs:read + mcp:exarchos:readonly — shell:exec escalates.
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
