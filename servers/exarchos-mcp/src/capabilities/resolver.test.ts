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
} from './resolver.js';
import type { Capability } from '../agents/capabilities.js';
import { KIND_OBLIGATIONS } from '../workflow/phase-kind.js';
import { findActionInRegistry } from '../registry.js';

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

// ─── T59 / DR-6: handshake declarations override yaml posture ──────────────

describe('resolvePosture handshake-overrides-yaml (T59, DR-6 INV-3)', () => {
  it('Resolver_HandshakeOverridesYamlPosture_HandshakeWins', () => {
    // Fixture 1: posture grants fs:write; handshake explicitly denies it.
    // Effective fs:write must be false — handshake wins on conflict.
    const spec1 = { id: 'implementer' as const, posture: 'task-isolated' as const };
    const handshake1 = { deny: ['fs:write' as Capability] };
    const eff1 = resolvePosture(spec1, handshake1);
    expect(eff1.has('fs:write')).toBe(false);
    // Sanity: posture's other caps still flow through.
    expect(eff1.has('fs:read')).toBe(true);
    expect(eff1.has('isolation:worktree')).toBe(true);

    // Fixture 2: posture is read-only (no fs:write); handshake explicitly
    // allows fs:write. Effective fs:write must be true — handshake widens.
    const spec2 = { id: 'reviewer' as const, posture: 'read-only' as const };
    const handshake2 = { allow: ['fs:write' as Capability] };
    const eff2 = resolvePosture(spec2, handshake2);
    expect(eff2.has('fs:write')).toBe(true);
    expect(eff2.has('fs:read')).toBe(true);
  });
});

// ─── T33 / DR-6: resolvePosture(spec, runtime) ─────────────────────────────

describe('resolvePosture (T33, DR-6)', () => {
  it('Resolver_ResolvePosture_MergesYamlPostureWithHandshakeCapabilities', () => {
    // Spec uses posture (yaml half of yaml ⊕ handshake). Handshake adds a
    // new capability not declared in the posture mapping. Effective set
    // must contain both.
    const spec = { id: 'implementer' as const, posture: 'task-isolated' as const };
    const runtime = { capabilities: ['fs:read'] as readonly Capability[] };

    const effective = resolvePosture(spec, runtime);

    // Posture-derived caps from `task-isolated` mapping.
    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(true);

    // Handshake-declared cap (here happens to overlap fs:read; assert the
    // overlap doesn't suppress posture caps).
    expect(effective.has('fs:read')).toBe(true);
  });
});

// ─── #1290 — Roots capability snapshot (handshake-driven) ─────────────────

describe('CapabilityResolver Roots handshake snapshot (#1290)', () => {
  it('CapabilityResolver_HandshakeRootsTrue_Snapshots', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isRootsDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    expect(resolver.isRootsDeclared()).toBe(true);
  });

  it('CapabilityResolver_NoRoots_ReturnsFalse', () => {
    const resolver = createInMemoryResolver([]);
    // No snapshot or snapshot without roots capability → false.
    expect(resolver.isRootsDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { sampling: {} } });
    expect(resolver.isRootsDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { roots: {} } });
    // `roots` present but no `listChanged: true` → also false, per the
    // MCP capability shape contract. Snapshot is the load-bearing source.
    expect(resolver.isRootsDeclared()).toBe(false);
  });

  it('CapabilityResolver_RootsCache_LifecycleIsTriState', () => {
    const resolver = createInMemoryResolver([]);
    // Initially: cache miss.
    expect(resolver.getCachedRoots()).toBeUndefined();

    // Populate cache.
    resolver.setCachedRoots([{ uri: 'file:///a' }, { uri: 'file:///b' }]);
    const cached = resolver.getCachedRoots();
    expect(cached).toBeDefined();
    expect(cached!.length).toBe(2);

    // Invalidate → cache miss again.
    resolver.invalidateRootsCache();
    expect(resolver.getCachedRoots()).toBeUndefined();
  });
});

// ─── #1274 — Elicitation capability snapshot (handshake-driven) ───────────

describe('CapabilityResolver Elicitation handshake snapshot (#1274)', () => {
  it('CapabilityResolver_ElicitationDeclared_Snapshots', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isElicitationDeclared()).toBe(false);
    // Per the MCP spec, the `elicitation` capability is signaled by the
    // client as `capabilities.elicitation: {}` — the presence of the
    // object (any shape) is the declaration.
    resolver.snapshot({ capabilities: { elicitation: {} } });
    expect(resolver.isElicitationDeclared()).toBe(true);
  });

  it('CapabilityResolver_NoElicitation_ReturnsFalse', () => {
    const resolver = createInMemoryResolver([]);
    // No snapshot or snapshot without the elicitation capability → false.
    expect(resolver.isElicitationDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { sampling: {} } });
    expect(resolver.isElicitationDeclared()).toBe(false);
    resolver.snapshot({ capabilities: { roots: { listChanged: true } } });
    expect(resolver.isElicitationDeclared()).toBe(false);
  });
});

// ─── #1273 — Task-support capability snapshot (handshake-driven) ─────────

describe('CapabilityResolver task-support handshake snapshot (#1273)', () => {
  it('CapabilityResolver_TaskSupportDeclared_Snapshots', () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isTaskSupportDeclared()).toBe(false);
    // Per the MCP spec, the `tasks` capability is signaled by the
    // presence of the `capabilities.tasks` object — the empty object
    // `{}` is a valid declaration (the per-method fine grain rides on
    // `tasks.list` / `tasks.cancel` / `tasks.requests.*`).
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

// ─── #1262 — quality-hint threshold (config-resolver path) ─────────────────

describe('getQualityHintThreshold (#1262)', () => {
  it('ConfigResolver_OutputTokenThreshold_ReadsExarchosYml', () => {
    // `.exarchos.yml` carries `qualityHints.outputTokenThreshold: 0.6` —
    // the resolver returns the token-count value derived from that
    // fraction.
    const config = { qualityHints: { outputTokenThreshold: 0.6 } };
    const tokens = getQualityHintThreshold('output_tokens', config);
    expect(tokens).toBe(OUTPUT_TOKENS_PER_TURN_CAP * 0.6);
  });

  it('ConfigResolver_OutputTokenThreshold_DefaultsTo80Percent', () => {
    // No `qualityHints` key — falls back to the default fraction.
    const tokens = getQualityHintThreshold('output_tokens', {});
    expect(DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION).toBe(0.8);
    expect(tokens).toBe(OUTPUT_TOKENS_PER_TURN_CAP * 0.8);
  });

  it('ConfigResolver_OutputTokenThreshold_UndefinedConfig_UsesDefault', () => {
    // No config at all — same default.
    const tokens = getQualityHintThreshold('output_tokens', undefined);
    expect(tokens).toBe(OUTPUT_TOKENS_PER_TURN_CAP * 0.8);
  });
});

// ─── POLA capability bundle from kind.posture (DR-14, INV-11, #1546) ─────────

describe('mintCapabilitiesForKind (POLA bundle, DR-14)', () => {
  it('capabilityBundle_ReviewKind_HasNoWriteToken', () => {
    // A REVIEW phase is read-only: worktree mutation is unrepresentable.
    const bundle = mintCapabilitiesForKind('REVIEW');
    expect(bundle.posture).toBe('read-only');
    expect(bundle.capabilities.has('fs:write')).toBe(false);
    expect(bundle.capabilities.has('isolation:worktree')).toBe(false);
    expect(bundle.capabilities.has('shell:exec')).toBe(false);
    // It still carries the read-only tier (fs:read) — ≥1 capability.
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

  it('capabilityBundle_ComposesResolvePosture_HandshakeStaysAuthoritative', () => {
    // Compose, do not duplicate: a handshake deny revokes a posture grant.
    const denied = mintCapabilitiesForKind('IMPLEMENT', { deny: ['fs:write'] });
    expect(denied.capabilities.has('fs:write')).toBe(false);
  });

  it('requireMutationCapabilities_AcceptsMutatingBundle', () => {
    // Runtime companion to the compile-time guarantee: a mutating kind's bundle
    // is accepted by a mutation-requiring consumer (the type rejection of a
    // read-only bundle is proven at compile time in resolver.ts).
    const caps = requireMutationCapabilities(mintCapabilitiesForKind('IMPLEMENT'));
    expect(caps.has('fs:write')).toBe(true);
  });

  it('kindPosture_Implement_IsTaskIsolated_Per1512', () => {
    // REFACTOR guard (DR-14): IMPLEMENT runs in an isolated worktree (#1512), so
    // its posture must stay task-isolated — never shared-mutating.
    expect(KIND_OBLIGATIONS.IMPLEMENT.posture).toBe('task-isolated');
  });
});

// ─── #1305 T13 — merge_orchestrate declares shared-mutating posture ─────────
//
// merge_orchestrate mutates shared state (the integration branch, the repo's
// working tree, the event store) from the main worktree — it has no worktree
// isolation. Per the posture table (`shared-mutating` → fs:read + fs:write +
// shell:exec), its registration must declare `posture: 'shared-mutating'` so
// the resolver mints the fs:write + shell:exec write-capability set. This is
// the trust-tier source of truth that #1305 T14/T15 (read-only-caller
// rejection, transition exclusivity) build on.

describe('merge_orchestrate posture (#1305 T13)', () => {
  it('MergeOrchestrate_Posture_ResolvesSharedMutatingWriteCaps', () => {
    const action = findActionInRegistry('exarchos_orchestrate', 'merge_orchestrate');
    expect(action).toBeDefined();

    // The registration declares the shared-mutating trust tier.
    expect(action!.posture).toBe('shared-mutating');

    // Resolving that posture (empty handshake) yields the shared-mutating
    // write-capability set: fs:write + shell:exec (plus fs:read). isolation
    // :worktree is NOT in this tier — shared-mutating runs from the main
    // worktree without worktree isolation.
    const effective = resolvePosture({ posture: action!.posture }, {});
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('shell:exec')).toBe(true);
    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(false);
  });
});
