import { describe, it, expect } from 'vitest';
import {
  createInMemoryResolver,
  resolveEffectiveCapabilities,
  resolvePosture,
  ANTHROPIC_NATIVE_CACHING,
  getQualityHintThreshold,
  DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION,
  OUTPUT_TOKENS_PER_TURN_CAP,
  mintCapabilitiesForKind,
  requireMutationCapabilities,
} from '../../../../src/workflow/capabilities/resolver.js';
import type { Capability } from '../../../../src/runtime/agents/capabilities.js';
import { KIND_OBLIGATIONS } from '../../../../src/workflow/phase-kind.js';
import { getHSMDefinition } from '../../../../src/workflow/state-machine.js';
import { findActionInRegistry } from '../../../../src/registry.js';

describe('CapabilityResolver (T017, DR-14)', () => {
  it('CapabilityResolver_AnthropicNative_ReturnsTrue', () => {
    const resolver = createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]);
    expect(resolver.has('anthropic_native_caching')).toBe(true);
  });

  it('CapabilityResolver_Unknown_ReturnsFalse', () => {
    const resolver = createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]);
    expect(resolver.has('bogus_flag')).toBe(false);
  });
});

describe('resolveEffectiveCapabilities (handshake-authoritative, ADR §2.8)', () => {
  it('Resolver_HandshakeReadonly_OverridesYamlFull', () => {
    const yaml: Capability[] = ['mcp:exarchos'];
    const handshake: Capability[] = ['mcp:exarchos:readonly'];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(effective.has('mcp:exarchos:readonly')).toBe(true);
    expect(effective.has('mcp:exarchos')).toBe(false);
  });

  it('Resolver_HandshakeFull_OverridesYamlReadonly', () => {
    const yaml: Capability[] = ['mcp:exarchos:readonly'];
    const handshake: Capability[] = ['mcp:exarchos'];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(effective.has('mcp:exarchos')).toBe(true);
    expect(effective.has('mcp:exarchos:readonly')).toBe(false);
  });

  it('Resolver_HandshakeSilent_FallsBackToYaml', () => {
    const yaml: Capability[] = ['mcp:exarchos:readonly'];
    const handshake: Capability[] = [];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(effective.has('mcp:exarchos:readonly')).toBe(true);
    expect(effective.has('mcp:exarchos')).toBe(false);
  });

  it('Resolver_HandshakeSilent_FallsBackToYamlFull', () => {
    const yaml: Capability[] = ['mcp:exarchos'];
    const handshake: Capability[] = [];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(effective.has('mcp:exarchos')).toBe(true);
    expect(effective.has('mcp:exarchos:readonly')).toBe(false);
  });

  it('Resolver_NeitherDeclaresMcp_NoMcpInEffective', () => {
    const yaml: Capability[] = ['fs:read'];
    const handshake: Capability[] = ['fs:write'];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(effective.has('mcp:exarchos')).toBe(false);
    expect(effective.has('mcp:exarchos:readonly')).toBe(false);
  });

  it('Resolver_NonMcpFamily_UnionsWithHandshakePrecedence', () => {
    const yaml: Capability[] = ['fs:read'];
    const handshake: Capability[] = ['fs:write'];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('fs:write')).toBe(true);
  });

  it('Resolver_NonMcpFamily_UnionsAcrossManyCaps', () => {
    const yaml: Capability[] = ['fs:read', 'isolation:worktree'];
    const handshake: Capability[] = ['fs:write', 'shell:exec'];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('shell:exec')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(true);
  });

  it('Resolver_EffectiveRecord_IsImmutable', () => {
    const yaml: Capability[] = ['fs:read'];
    const handshake: Capability[] = ['mcp:exarchos:readonly'];
    const effective = resolveEffectiveCapabilities(yaml, handshake);
    expect(Object.isFrozen(effective)).toBe(true);
    expect(() => {
      (effective as Set<Capability>).add('shell:exec');
    }).toThrow();
  });
});

/** A handshake deny removes a posture grant. A handshake allow adds a capability that the posture lacks. */
describe('resolvePosture handshake-overrides-yaml (T59, DR-6 INV-3)', () => {
  it('Resolver_HandshakeOverridesYamlPosture_HandshakeWins', () => {
    const spec1 = { id: 'implementer' as const, posture: 'task-isolated' as const };
    const handshake1 = { deny: ['fs:write' as Capability] };
    const eff1 = resolvePosture(spec1, handshake1);
    expect(eff1.has('fs:write')).toBe(false);
    expect(eff1.has('fs:read')).toBe(true);
    expect(eff1.has('isolation:worktree')).toBe(true);

    const spec2 = { id: 'reviewer' as const, posture: 'read-only' as const };
    const handshake2 = { allow: ['fs:write' as Capability] };
    const eff2 = resolvePosture(spec2, handshake2);
    expect(eff2.has('fs:write')).toBe(true);
    expect(eff2.has('fs:read')).toBe(true);
  });
});

describe('resolvePosture (T33, DR-6)', () => {
  /** The handshake capability overlaps `fs:read`. The overlap must not remove any posture capability. */
  it('Resolver_ResolvePosture_MergesYamlPostureWithHandshakeCapabilities', () => {
    const spec = { id: 'implementer' as const, posture: 'task-isolated' as const };
    const runtime = { capabilities: ['fs:read'] as readonly Capability[] };

    const effective = resolvePosture(spec, runtime);

    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(true);

    expect(effective.has('fs:read')).toBe(true);
  });
});

describe('CapabilityResolver Roots handshake snapshot (#1290)', () => {
  it('CapabilityResolver_HandshakeRootsTrue_Snapshots', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isRootsDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    expect(resolver.isRootsDeclared()).toBe(true);
  });

  /** Per the MCP capability shape, `roots` without `listChanged: true` is not a declaration. */
  it('CapabilityResolver_NoRoots_ReturnsFalse', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isRootsDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { sampling: {} } });
    expect(resolver.isRootsDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { roots: {} } });
    expect(resolver.isRootsDeclared()).toBe(false);
  });

  it('CapabilityResolver_RootsCache_LifecycleIsTriState', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.getCachedRoots()).toBeUndefined();

    resolver.setCachedRoots([{ uri: 'file:///a' }, { uri: 'file:///b' }]);
    const cached = resolver.getCachedRoots();
    expect(cached).toBeDefined();
    expect(cached!.length).toBe(2);

    resolver.invalidateRootsCache();
    expect(resolver.getCachedRoots()).toBeUndefined();
  });
});

describe('CapabilityResolver Elicitation handshake snapshot (#1274)', () => {
  /** Per the MCP spec, a client declares elicitation with a `capabilities.elicitation` object of any shape. */
  it('CapabilityResolver_ElicitationDeclared_Snapshots', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isElicitationDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { elicitation: {} } });
    expect(resolver.isElicitationDeclared()).toBe(true);
  });

  it('CapabilityResolver_NoElicitation_ReturnsFalse', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isElicitationDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { sampling: {} } });
    expect(resolver.isElicitationDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    expect(resolver.isElicitationDeclared()).toBe(false);
  });
});

describe('CapabilityResolver task-support handshake snapshot (#1273)', () => {
  /** Per the MCP spec, a client declares task support with a `capabilities.tasks` object. An empty object counts. */
  it('CapabilityResolver_TaskSupportDeclared_Snapshots', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isTaskSupportDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { tasks: {} } });
    expect(resolver.isTaskSupportDeclared()).toBe(true);
  });

  it('CapabilityResolver_NoTaskSupport_ReturnsFalse', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isTaskSupportDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { sampling: {} } });
    expect(resolver.isTaskSupportDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    expect(resolver.isTaskSupportDeclared()).toBe(false);
  });
});

describe('getQualityHintThreshold (#1262)', () => {
  it('ConfigResolver_OutputTokenThreshold_ReadsExarchosYml', () => {
    const config = { qualityHints: { outputTokenThreshold: 0.6 } };
    const tokens = getQualityHintThreshold('output_tokens', config);
    expect(tokens).toBe(OUTPUT_TOKENS_PER_TURN_CAP * 0.6);
  });

  it('ConfigResolver_OutputTokenThreshold_DefaultsTo80Percent', () => {
    const tokens = getQualityHintThreshold('output_tokens', {});
    expect(DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION).toBe(0.8);
    expect(tokens).toBe(OUTPUT_TOKENS_PER_TURN_CAP * 0.8);
  });

  it('ConfigResolver_OutputTokenThreshold_UndefinedConfig_UsesDefault', () => {
    const tokens = getQualityHintThreshold('output_tokens', undefined);
    expect(tokens).toBe(OUTPUT_TOKENS_PER_TURN_CAP * 0.8);
  });
});

describe('mintCapabilitiesForKind (POLA bundle, DR-14)', () => {
  it('capabilityBundle_ReviewKind_HasNoWriteToken', () => {
    const bundle = mintCapabilitiesForKind('REVIEW');
    expect(bundle.posture).toBe('read-only');
    expect(bundle.capabilities.has('fs:write')).toBe(false);
    expect(bundle.capabilities.has('isolation:worktree')).toBe(false);
    expect(bundle.capabilities.has('shell:exec')).toBe(false);
    expect(bundle.capabilities.has('fs:read')).toBe(true);
  });

  it('capabilityBundle_PlanAndGatherKinds_HaveNoWriteToken', () => {
    for (const kind of ['PLAN', 'GATHER'] as const) {
      expect(mintCapabilitiesForKind(kind).capabilities.has('fs:write')).toBe(false);
    }
  });

  it('capabilityBundle_ImplementKind_HasWriteTokenWithinWorktree', () => {
    const bundle = mintCapabilitiesForKind('IMPLEMENT');
    expect(bundle.posture).toBe('task-isolated');
    expect(bundle.capabilities.has('fs:write')).toBe(true);
    expect(bundle.capabilities.has('isolation:worktree')).toBe(true);
  });

  it('capabilityBundle_SynthesizeKind_HasWriteToken', () => {
    const bundle = mintCapabilitiesForKind('SYNTHESIZE');
    expect(bundle.posture).toBe('shared-mutating');
    expect(bundle.capabilities.has('fs:write')).toBe(true);
  });

  /** The bundle comes from `resolvePosture`, so a handshake deny removes a posture grant. */
  it('capabilityBundle_ComposesResolvePosture_HandshakeStaysAuthoritative', () => {
    const denied = mintCapabilitiesForKind('IMPLEMENT', { deny: ['fs:write'] });
    expect(denied.capabilities.has('fs:write')).toBe(false);
  });

  /** This test is the runtime half of a type check. `resolver.ts` proves at compile time that a read-only bundle fails. */
  it('requireMutationCapabilities_AcceptsMutatingBundle', () => {
    const caps = requireMutationCapabilities(mintCapabilitiesForKind('IMPLEMENT'));
    expect(caps.has('fs:write')).toBe(true);
  });

  /** IMPLEMENT runs in an isolated worktree, so its posture must stay `task-isolated` and never `shared-mutating`. */
  it('kindPosture_Implement_IsTaskIsolated_Per1512', () => {
    expect(KIND_OBLIGATIONS.IMPLEMENT.posture).toBe('task-isolated');
  });
});

/**
 * The feature HSM `plan` state is the single authoring phase, and it must stay read-only.
 * The test checks the chain from the `plan` state to kind `PLAN` to posture `read-only`, with no `fs:write`.
 */
describe('merged PLAN phase posture (Task 009, #1581 DR-4, INV-11)', () => {
  it('PostureResolver_MergedPlanPhase_ResolvesReadOnly', () => {
    const hsm = getHSMDefinition('feature');
    const planState = hsm.states['plan'];
    expect(planState).toBeDefined();
    expect(planState?.type).toBe('atomic');
    if (planState?.type !== 'atomic') {
      throw new Error('feature HSM `plan` state must be an atomic kind-bearing phase');
    }
    expect(planState.kind).toBe('PLAN');

    const bundle = mintCapabilitiesForKind(planState.kind);
    expect(bundle.posture).toBe('read-only');
    expect(bundle.capabilities.has('fs:write')).toBe(false);
    expect(bundle.capabilities.has('shell:exec')).toBe(false);
    expect(bundle.capabilities.has('isolation:worktree')).toBe(false);
    expect(bundle.capabilities.has('fs:read')).toBe(true);
  });
});

/**
 * `merge_orchestrate` changes shared state from the main worktree, without worktree isolation.
 * Its registration must declare `posture: 'shared-mutating'`, so the resolver mints `fs:write` and `shell:exec`.
 * That tier holds no `isolation:worktree`.
 */
describe('merge_orchestrate posture (#1305 T13)', () => {
  it('MergeOrchestrate_Posture_ResolvesSharedMutatingWriteCaps', () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'merge_orchestrate');
    expect(action).toBeDefined();

    expect(action!.posture).toBe('shared-mutating');

    const effective = resolvePosture({ posture: action!.posture }, {});
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('shell:exec')).toBe(true);
    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(false);
  });
});
