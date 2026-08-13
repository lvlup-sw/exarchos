import { describe, it, expect } from 'vitest';
import { COMPOSITE_HANDLER_LOADERS } from '../../dispatch/core/dispatch.js';
import { EFFECT_OWNERSHIP, type EffectOwnershipRule } from '../../architecture/effect-ledger.js';
import {
  EFFECT_PROVIDERS,
  ProviderValidationError,
  assertValidProviders,
  ruleBacksProvider,
  validateEffectProviders,
  type EffectProvider,
} from './providers.js';

// ─── The effect-provider connective map, validated against the live ledger ───

describe('effect-provider map — backed by the live effect ledger', () => {
  it('every provider is backed by exactly one live EFFECT_OWNERSHIP rule', () => {
    const verdict = validateEffectProviders();
    expect(verdict.ok).toBe(true);
    expect(verdict.diagnostics).toEqual([]);
  });

  it('covers exactly the composite tools that dispatch binds a handler for', () => {
    const dispatchTools = new Set(Object.keys(COMPOSITE_HANDLER_LOADERS));
    const providerTools = new Set(EFFECT_PROVIDERS.map((p) => p.tool));
    // Every dispatchable composite tool has a provider, and no provider is
    // orphaned from dispatch — the connective map tracks the real loader set.
    expect(providerTools).toEqual(dispatchTools);
  });

  it('assertValidProviders returns the map unchanged when clean', () => {
    expect(assertValidProviders()).toBe(EFFECT_PROVIDERS);
  });
});

describe('effect-provider map — drift detection (two-way ratchet)', () => {
  const ownerFor = (tool: string): EffectProvider => {
    const p = EFFECT_PROVIDERS.find((x) => x.tool === tool);
    if (!p) throw new Error(`no provider for ${tool}`);
    return p;
  };

  it('an UNBACKED provider (owner not in the ledger) is flagged', () => {
    const bogus: EffectProvider = { ...ownerFor('exarchos_workflow'), owner: 'ghost-owner' };
    const verdict = validateEffectProviders([bogus]);
    expect(verdict.ok).toBe(false);
    expect(verdict.diagnostics[0]?.code).toBe('UNBACKED_PROVIDER');
    expect(verdict.diagnostics[0]?.tool).toBe('exarchos_workflow');
  });

  it('a provider whose area no longer matches a ledger rule is UNBACKED', () => {
    const moved: EffectProvider = { ...ownerFor('exarchos_workflow'), area: 'nowhere/' };
    const verdict = validateEffectProviders([moved]);
    expect(verdict.ok).toBe(false);
    expect(verdict.diagnostics[0]?.code).toBe('UNBACKED_PROVIDER');
  });

  it('a DUPLICATE provider for one tool is flagged (ambiguous ownership)', () => {
    const workflow = ownerFor('exarchos_workflow');
    const verdict = validateEffectProviders([workflow, workflow]);
    expect(verdict.diagnostics.some((d) => d.code === 'DUPLICATE_PROVIDER')).toBe(true);
  });

  it('assertValidProviders throws ProviderValidationError on drift', () => {
    const bogus: EffectProvider = { ...ownerFor('exarchos_event'), owner: 'ghost' };
    expect(() => assertValidProviders([bogus])).toThrow(ProviderValidationError);
  });
});

describe('ruleBacksProvider — the backing predicate', () => {
  const rule: EffectOwnershipRule = {
    effectClass: 'filesystem',
    match: 'workflow/',
    owner: 'workflow-fs',
    idempotency: 'x',
    compensation: 'y',
  };
  const provider: EffectProvider = {
    tool: 'exarchos_workflow',
    area: 'workflow/',
    owner: 'workflow-fs',
    effectClass: 'filesystem',
  };

  it('matches on (effectClass, owner, match===area)', () => {
    expect(ruleBacksProvider(rule, provider)).toBe(true);
  });

  it('rejects a class/owner/area mismatch', () => {
    expect(ruleBacksProvider({ ...rule, owner: 'other' }, provider)).toBe(false);
    expect(ruleBacksProvider({ ...rule, match: 'workflow/sub/' }, provider)).toBe(false);
    expect(ruleBacksProvider({ ...rule, effectClass: 'process' }, provider)).toBe(false);
  });

  it('the live ledger really contains each provider’s backing rule', () => {
    for (const p of EFFECT_PROVIDERS) {
      const backing = EFFECT_OWNERSHIP.filter((r) => ruleBacksProvider(r, p));
      expect(backing).toHaveLength(1);
    }
  });
});
