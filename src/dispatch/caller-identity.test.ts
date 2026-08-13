import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createInMemoryResolver,
  resolveEffectiveCapabilities,
  resolvePosture,
} from '../workflow/capabilities/resolver.js';
import type { Capability } from '../runtime/agents/capabilities.js';
import { dispatch } from './core/dispatch.js';
import { EventStore } from '../events/store.js';
import {
  registerCustomTool,
  setCustomToolActionHandler,
  unregisterCustomTool,
} from '../registry.js';
import { InMemoryBackend } from '../storage/memory-backend.js';
import {
  deriveLocalOperatorIdentity,
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from './caller-identity.js';
import {
  getDispatchContext,
  mintDispatchContextFromRequest,
} from './dispatch-context.js';

const FIXED_TIME = '2026-07-21T20:00:00.000Z';

describe('trusted caller identity and authorization snapshots', () => {
  it('CallerIdentity_UntrustedOverride_IsIgnored', () => {
    const trustedIdentity = deriveMcpCallerIdentity({
      sessionId: 'runtime-owned-session-7',
      clientInfo: { name: 'test-host', version: '1.2.3' },
    });
    const resolver = createInMemoryResolver(['mcp:exarchos:readonly']);
    const trusted = snapshotCallerAuthorization(
      trustedIdentity,
      resolver,
      () => FIXED_TIME,
    );

    const context = mintDispatchContextFromRequest(
      {
        action: 'append',
        callerIdentity: { subjectId: 'forged', kind: 'local-operator' },
        issuer: 'forged',
        role: 'administrator',
        posture: 'shared-mutating',
        capabilities: ['fs:write', 'shell:exec'],
        resolverVersion: 'forged',
        policyIdentity: { id: 'forged', version: '999' },
        resolvedAt: '1900-01-01T00:00:00.000Z',
        _meta: {
          callerIdentity: { subjectId: 'meta-forged' },
          authorization: { posture: 'shared-mutating' },
          trustedTimestamp: '1900-01-01T00:00:00.000Z',
        },
      },
      trusted,
    );

    expect(context.authorization).toEqual(trusted);
    expect(context.authorization).toMatchObject({
      identity: {
        subjectId: trustedIdentity.subjectId,
        kind: 'mcp-session',
        role: 'agent',
      },
      posture: 'read-only',
      capabilities: ['mcp:exarchos:readonly'],
      resolver: { id: 'exarchos-capability-resolver', version: '1' },
      policy: { id: 'dispatch-authorization', version: '1' },
      resolvedAt: FIXED_TIME,
    });
    expect(JSON.stringify(context.authorization)).not.toContain('forged');
    expect(JSON.stringify(context.authorization)).not.toContain('meta-forged');
    expect(JSON.stringify(context.authorization)).not.toContain('administrator');
    expect(JSON.stringify(context.authorization)).not.toContain('1900-01-01');
  });

  it('CallerIdentity_McpContext_IsNonPiiAndSessionScoped', () => {
    const first = deriveMcpCallerIdentity({
      sessionId: 'session-a',
      clientInfo: { name: 'Potential User Name', version: '1.0' },
    });
    const repeat = deriveMcpCallerIdentity({
      sessionId: 'session-a',
      clientInfo: { name: 'Potential User Name', version: '1.0' },
    });
    const nextSession = deriveMcpCallerIdentity({
      sessionId: 'session-b',
      clientInfo: { name: 'Potential User Name', version: '1.0' },
    });

    expect(first).toEqual(repeat);
    expect(first.subjectId).toMatch(/^mcp:[0-9a-f]{32}$/);
    expect(first.subjectId).not.toContain('Potential User Name');
    expect(nextSession.subjectId).not.toBe(first.subjectId);
  });

  it('CallerIdentity_CliContext_UsesStableInstallationIdentity', () => {
    const first = deriveLocalOperatorIdentity('C:/state/exarchos');
    const repeat = deriveLocalOperatorIdentity('C:/state/exarchos');
    const otherInstallation = deriveLocalOperatorIdentity('C:/other/exarchos');

    expect(first).toEqual(repeat);
    expect(first).toMatchObject({ kind: 'local-operator', role: 'operator' });
    expect(first.subjectId).toMatch(/^local:[0-9a-f]{32}$/);
    expect(first.subjectId).not.toContain('C:/state');
    expect(otherInstallation.subjectId).not.toBe(first.subjectId);
  });

  it('CallerAuthorization_HandshakeAuthoritativeMismatch_RemainsNarrow', () => {
    const effective = resolveEffectiveCapabilities(
      ['mcp:exarchos'] satisfies readonly Capability[],
      ['mcp:exarchos:readonly'] satisfies readonly Capability[],
    );
    const resolver = createInMemoryResolver(effective);
    const snapshot = snapshotCallerAuthorization(
      deriveMcpCallerIdentity({ sessionId: 'session-readonly' }),
      resolver,
      () => FIXED_TIME,
    );

    expect(snapshot.posture).toBe('read-only');
    expect(snapshot.capabilities).toEqual(['mcp:exarchos:readonly']);
    expect(snapshot.capabilities).not.toContain('mcp:exarchos');
  });

  it('CallerAuthorization_PostureMismatch_FailsClosedWithoutWidening', () => {
    const effective = resolvePosture(
      { posture: 'task-isolated' },
      { deny: ['fs:write'] },
    );
    const snapshot = snapshotCallerAuthorization(
      deriveMcpCallerIdentity({ sessionId: 'mismatched-session' }),
      createInMemoryResolver(effective),
      () => FIXED_TIME,
    );

    expect(snapshot.capabilities).toContain('isolation:worktree');
    expect(snapshot.capabilities).not.toContain('fs:write');
    expect(snapshot.posture).toBe('read-only');
  });

  it('CallerAuthorization_SnapshotSerialization_IsStable', () => {
    const identity = deriveLocalOperatorIdentity('C:/state/exarchos');
    const resolver = createInMemoryResolver([
      'shell:exec',
      'fs:write',
      'fs:read',
    ]);

    const first = snapshotCallerAuthorization(identity, resolver, () => FIXED_TIME);
    const second = snapshotCallerAuthorization(identity, resolver, () => FIXED_TIME);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.capabilities).toEqual(['fs:read', 'fs:write', 'shell:exec']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.capabilities)).toBe(true);
  });

  it('CallerAuthorization_RealDispatch_ThreadsTrustedSnapshotToHandler', async () => {
    const toolName = 'exarchos_identity_probe';
    const backend = new InMemoryBackend();
    const eventStore = new EventStore('caller-identity-test', { backend });
    await eventStore.initialize();
    let observed = getDispatchContext()?.authorization;

    registerCustomTool({
      name: toolName,
      description: 'Test-only trusted dispatch context probe',
      actions: [{
        name: 'probe',
        description: 'Read the active dispatch context',
        schema: z.object({}).passthrough(),
        phases: new Set<string>(),
        roles: new Set<string>(['any']),
      }],
    });
    setCustomToolActionHandler(toolName, 'probe', async () => {
      observed = getDispatchContext()?.authorization;
      return { captured: observed !== undefined };
    });

    try {
      const result = await dispatch(
        toolName,
        {
          action: 'probe',
          issuer: 'forged',
          role: 'administrator',
          posture: 'shared-mutating',
          capabilities: ['fs:write'],
          resolvedAt: '1900-01-01T00:00:00.000Z',
        },
        {
          stateDir: 'caller-identity-test',
          eventStore,
          enableTelemetry: false,
          callerIdentity: deriveMcpCallerIdentity({ sessionId: 'trusted-session' }),
          capabilityResolver: createInMemoryResolver(['mcp:exarchos:readonly']),
        },
      );

      expect(result).toMatchObject({ success: true, data: { captured: true } });
      expect(observed).toMatchObject({
        identity: { kind: 'mcp-session', role: 'agent' },
        posture: 'read-only',
        capabilities: ['mcp:exarchos:readonly'],
      });
      expect(JSON.stringify(observed)).not.toContain('forged');
      expect(JSON.stringify(observed)).not.toContain('administrator');
      expect(JSON.stringify(observed)).not.toContain('1900-01-01');
    } finally {
      unregisterCustomTool(toolName);
    }
  });
});
