import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createInMemoryResolver,
  resolveEffectiveCapabilities,
  resolvePosture,
  enforceSharedMutatingGate,
  ANTHROPIC_NATIVE_CACHING,
  POSTURE_HANDSHAKE_KEY,
  getQualityHintThreshold,
  DEFAULT_OUTPUT_TOKEN_THRESHOLD_FRACTION,
  OUTPUT_TOKENS_PER_TURN_CAP,
  mintCapabilitiesForKind,
  requireMutationCapabilities,
} from './resolver.js';
import type { CapabilityResolver, PostureResolution } from './resolver.js';
import type { Capability } from '../agents/capabilities.js';
import { KIND_OBLIGATIONS } from '../workflow/phase-kind.js';
import { getHSMDefinition } from '../workflow/state-machine.js';
import { findActionInRegistry } from '../registry.js';
import { createMcpServer } from '../adapters/mcp.js';
import { stubCompositeHandler } from '../core/dispatch.js';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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

// ─── Task 009 (#1581 DR-4): merged PLAN phase stays read-only (INV-11) ──────
//
// DR-4 collapsed the GATHER (`ideate`) phase into PLAN; the feature HSM's
// `plan` state is now the single authoring phase. INV-11 (POLA) requires the
// merged phase to stay read-only — the collapse must not silently re-tag it
// with a mutating kind/posture (e.g. promoting it to IMPLEMENT or
// SYNTHESIZE). The existing kind-only tests above pin `PLAN → read-only` in
// isolation; this test closes the loop the collapse actually put at risk —
// the *phase → kind → posture* chain for the merged `plan` state:
//   feature HSM `plan` state → kind 'PLAN' → posture 'read-only' → no fs:write.
describe('merged PLAN phase posture (Task 009, #1581 DR-4, INV-11)', () => {
  it('PostureResolver_MergedPlanPhase_ResolvesReadOnly', () => {
    const hsm = getHSMDefinition('feature');
    const planState = hsm.states['plan'];
    expect(planState).toBeDefined();
    // The merged authoring phase carries the PLAN kind — not a mutating kind.
    expect(planState?.type).toBe('atomic');
    if (planState?.type !== 'atomic') {
      throw new Error('feature HSM `plan` state must be an atomic kind-bearing phase');
    }
    expect(planState.kind).toBe('PLAN');

    // Mint the POLA bundle from the phase's own kind: read-only, with no
    // write / exec / worktree tokens — but still able to read to author.
    const bundle = mintCapabilitiesForKind(planState.kind);
    expect(bundle.posture).toBe('read-only');
    expect(bundle.capabilities.has('fs:write')).toBe(false);
    expect(bundle.capabilities.has('shell:exec')).toBe(false);
    expect(bundle.capabilities.has('isolation:worktree')).toBe(false);
    expect(bundle.capabilities.has('fs:read')).toBe(true);
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

// ─── DR-8 / INV-11 — caller-posture handshake resolution (#1688) ────────────
//
// The initialize handshake's namespaced declaration
// (`capabilities.experimental['exarchos/posture']`) resolves a LIVE caller's
// trust tier: handshake-authoritative merge with the agent-spec posture,
// read-only default when neither half declares. Unit tests pin the resolver
// semantics; the integration block below drives the REAL
// initialize → snapshot → dispatch-gate seam over the SDK's InMemoryTransport.

describe('caller-posture handshake resolution (DR-8, INV-11, #1688)', () => {
  const sharedMutatingDeclaration = {
    experimental: { [POSTURE_HANDSHAKE_KEY]: { posture: 'shared-mutating' } },
  };

  it('HandshakeMismatch_AgentSpec_HandshakeWins', () => {
    // Agent-spec half declares task-isolated: that tier is in force from
    // construction, so the shared-mutating gate DENIES (worktree-confined).
    const resolver = createInMemoryResolver([], { specPosture: 'task-isolated' });
    expect(resolver.has('isolation:worktree')).toBe(true);
    expect(resolver.getPostureResolution()).toMatchObject({
      effectivePosture: 'task-isolated',
      source: 'agent-spec',
    });
    expect(
      enforceSharedMutatingGate('exarchos_orchestrate', 'serialize_merge', 'shared-mutating', resolver),
    ).not.toBeNull();

    // Live handshake declares shared-mutating → mismatch resolves to the
    // handshake (INV-11 handshake-authoritative).
    resolver.snapshot({ capabilities: sharedMutatingDeclaration });
    const resolution = resolver.getPostureResolution();
    expect(resolution.effectivePosture).toBe('shared-mutating');
    expect(resolution.source).toBe('handshake');
    expect(resolution.handshakePosture).toBe('shared-mutating');
    expect(resolution.specPosture).toBe('task-isolated');
    expect(resolver.has('fs:write')).toBe(true);
    // The load-bearing INV-11 assertion: tier REPLACEMENT, not union — the
    // spec's isolation:worktree must NOT leak into the handshake tier (a
    // union would re-deny the shared-mutating caller on the isolation branch).
    expect(resolver.has('isolation:worktree')).toBe(false);
    expect(
      enforceSharedMutatingGate('exarchos_orchestrate', 'serialize_merge', 'shared-mutating', resolver),
    ).toBeNull();
  });

  it('HandshakeMismatch_NarrowerHandshake_StillWins', () => {
    // Handshake-authoritative even when NARROWER than the spec: the runtime
    // is the source of truth for what is actually mounted, so a read-only
    // declaration revokes the spec's shared-mutating tier.
    const resolver = createInMemoryResolver([], { specPosture: 'shared-mutating' });
    expect(
      enforceSharedMutatingGate('exarchos_orchestrate', 'serialize_merge', 'shared-mutating', resolver),
    ).toBeNull();

    resolver.snapshot({
      capabilities: { experimental: { [POSTURE_HANDSHAKE_KEY]: { posture: 'read-only' } } },
    });
    expect(resolver.has('fs:write')).toBe(false);
    // An EXPLICIT read-only declaration mints the readonly allowlist tier
    // (opt-in) — unlike the undeclared default, which enforces by absence.
    expect(resolver.has('mcp:exarchos:readonly')).toBe(true);
    const denied = enforceSharedMutatingGate(
      'exarchos_orchestrate', 'serialize_merge', 'shared-mutating', resolver,
    );
    expect(denied?.error?.code).toBe('CAPABILITY_DENIED');
  });

  it('HandshakeMalformedPosture_IgnoredFailClosed', () => {
    const resolver = createInMemoryResolver([]);

    // Unknown posture string → ignored, flagged, default tier.
    resolver.snapshot({
      capabilities: { experimental: { [POSTURE_HANDSHAKE_KEY]: { posture: 'root' } } },
    });
    expect(resolver.getPostureResolution()).toMatchObject({
      effectivePosture: 'read-only',
      source: 'default',
      invalidHandshakeDeclaration: true,
    });
    expect(resolver.has('fs:write')).toBe(false);

    // Non-object entry (bare string) → same fail-closed handling.
    resolver.snapshot({
      capabilities: { experimental: { [POSTURE_HANDSHAKE_KEY]: 'shared-mutating' } },
    });
    expect(resolver.getPostureResolution().invalidHandshakeDeclaration).toBe(true);
    expect(resolver.has('fs:write')).toBe(false);

    // Array entry → typeof [] === 'object', must still be rejected.
    resolver.snapshot({
      capabilities: { experimental: { [POSTURE_HANDSHAKE_KEY]: ['shared-mutating'] } },
    });
    expect(resolver.getPostureResolution().invalidHandshakeDeclaration).toBe(true);
    expect(resolver.has('fs:write')).toBe(false);
  });

  it('RepeatedSnapshot_LatestHandshakeWins_NoAccumulation', () => {
    const resolver = createInMemoryResolver([ANTHROPIC_NATIVE_CACHING]);
    resolver.snapshot({ capabilities: sharedMutatingDeclaration });
    expect(resolver.has('fs:write')).toBe(true);
    expect(resolver.list()).toContain('fs:write');

    // A second handshake WITHOUT a declaration reverts wholesale to the
    // default tier — posture caps never accumulate across handshakes.
    resolver.snapshot({ capabilities: {} });
    expect(resolver.has('fs:write')).toBe(false);
    expect(resolver.getPostureResolution()).toMatchObject({
      effectivePosture: 'read-only',
      source: 'default',
    });
    // Non-tier seed capabilities (cache hints) survive posture churn.
    expect(resolver.has(ANTHROPIC_NATIVE_CACHING)).toBe(true);
  });

  it('UndeclaredSnapshot_DoesNotActivateReadonlyAllowlistTier', () => {
    // The undeclared default enforces read-only by ABSENCE (no fs:write ⇒
    // shared-mutating verbs stay denied) — NOT by minting
    // `capabilitiesForPosture('read-only')`, whose mcp:exarchos:readonly
    // member would flip `enforceReadonlyGate` for every undeclared live
    // session's ordinary mutating actions (task_claim, workflow appends, …).
    const resolver = createInMemoryResolver([]);
    resolver.snapshot({ capabilities: {} });
    expect(resolver.has('mcp:exarchos:readonly')).toBe(false);
    expect(resolver.getPostureResolution().mintedCapabilities).toEqual([]);
  });

  it('SharedMutatingDenial_CarriesPostureResolutionMeta', () => {
    // INV-5b: the CAPABILITY_DENIED envelope carries the posture-resolution
    // record so a denied caller can diagnose its derived tier from the
    // error alone.
    const resolver = createInMemoryResolver([]);
    resolver.snapshot({ capabilities: {} });
    const denied = enforceSharedMutatingGate(
      'exarchos_orchestrate', 'prune_worktrees', 'shared-mutating', resolver,
    );
    expect(denied).not.toBeNull();
    expect(denied!.error?.code).toBe('CAPABILITY_DENIED');
    const meta = denied!._meta as { postureResolution?: PostureResolution };
    expect(meta.postureResolution).toMatchObject({
      effectivePosture: 'read-only',
      source: 'default',
    });
  });
});

// ─── DR-8 integration: initialize → capability-resolver → dispatch seam ─────
//
// Drives the REAL seam the unit tests above can only approximate: a live MCP
// client performs the initialize handshake over the SDK's InMemoryTransport
// pair, the server's `oninitialized` hook snapshots `getClientCapabilities()`
// into the resolver (adapters/mcp.ts), and a subsequent `tools/call` for
// `serialize_merge` crosses `enforceSharedMutatingGate` inside dispatch. The
// composite handler is a spy: its invocation (or provable non-invocation) is
// the load-bearing "gate passed / gate held" evidence.

describe('DR-8 integration — initialize handshake resolves live tiers (#1688)', () => {
  let tmpDir: string;
  let eventStore: EventStore;
  let client: Client | undefined;

  const SERIALIZE_MERGE_ARGS = {
    action: 'serialize_merge',
    featureId: 'feat-x',
    integrationRef: 'integration',
    sourceBranch: 'feat/x',
    strategy: 'squash',
  } as const;

  interface CallToolEnvelopeResult {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'posture-handshake-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      client = undefined;
    }
    eventStore.close();
    await rmrfAsync(tmpDir);
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('timed out waiting for handshake snapshot');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Connect a real Client ↔ createMcpServer pair over InMemoryTransport and
   * wait until the server-side `oninitialized` hook has snapshotted the
   * client's capabilities into `resolver` (the initialized notification is
   * fire-and-forget, so client.connect() resolving does not guarantee the
   * server has processed it yet).
   */
  async function connectClient(
    resolver: CapabilityResolver,
    clientCapabilities: Record<string, unknown>,
  ): Promise<void> {
    const snapshotSpy = vi.spyOn(resolver, 'snapshot');
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      capabilityResolver: resolver,
    };
    const server = createMcpServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client(
      { name: 'posture-handshake-test', version: '1.0.0' },
      { capabilities: clientCapabilities },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await waitFor(() => snapshotSpy.mock.calls.length > 0);
    snapshotSpy.mockRestore();
  }

  it('SharedMutatingHandshake_SerializeMerge_Executes', async () => {
    const resolver = createInMemoryResolver([]);
    await connectClient(resolver, {
      experimental: { [POSTURE_HANDSHAKE_KEY]: { posture: 'shared-mutating' } },
    });

    // INV-5b: the resolution is queryable and names the handshake as source.
    expect(resolver.getPostureResolution()).toMatchObject({
      effectivePosture: 'shared-mutating',
      source: 'handshake',
    });

    const compositeSpy = vi.fn(async () => ({
      success: true as const,
      data: { dryRun: true, integrationRef: 'integration' },
    }));
    const restore = stubCompositeHandler('exarchos_orchestrate', compositeSpy);
    try {
      const result = (await client!.callTool({
        name: 'exarchos_orchestrate',
        arguments: { ...SERIALIZE_MERGE_ARGS },
      })) as CallToolEnvelopeResult;

      // The gate let the live shared-mutating caller through: the handler
      // EXECUTED and the envelope is a success — no CAPABILITY_DENIED.
      expect(compositeSpy).toHaveBeenCalledTimes(1);
      const envelope = result.structuredContent as {
        success?: boolean;
        error?: { code?: string };
      };
      expect(envelope.success).toBe(true);
      expect(envelope.error).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('UndeclaredCaller_PostureDefault_ReadOnly', async () => {
    const resolver = createInMemoryResolver([]);
    await connectClient(resolver, {});

    expect(resolver.getPostureResolution()).toMatchObject({
      effectivePosture: 'read-only',
      source: 'default',
    });

    const compositeSpy = vi.fn(async () => ({ success: true as const, data: {} }));
    const restore = stubCompositeHandler('exarchos_orchestrate', compositeSpy);
    try {
      const result = (await client!.callTool({
        name: 'exarchos_orchestrate',
        arguments: { ...SERIALIZE_MERGE_ARGS },
      })) as CallToolEnvelopeResult;

      // Regression (#1688 acceptance): an undeclared caller stays read-only
      // — CAPABILITY_DENIED before the handler, which must never fire.
      expect(compositeSpy).not.toHaveBeenCalled();
      const envelope = result.structuredContent as {
        success?: boolean;
        error?: { code?: string };
        _meta?: Record<string, unknown>;
      };
      expect(envelope.success).toBe(false);
      expect(envelope.error?.code).toBe('CAPABILITY_DENIED');

      // INV-5b: the denial envelope carries the posture-resolution record
      // end-to-end across the MCP carrier.
      const postureResolution = envelope._meta?.['postureResolution'] as
        | { effectivePosture?: string; source?: string }
        | undefined;
      expect(postureResolution?.effectivePosture).toBe('read-only');
      expect(postureResolution?.source).toBe('default');
    } finally {
      restore();
    }
  });
});
