import { describe, expect, it } from 'vitest';

import { TOOL_REGISTRY } from '../../registry.js';
import {
  BUILTIN_GATE_PROVIDER_REGISTRY,
  SUPPORTED_GATE_CLASSES,
  buildGateProviderRegistry,
  type GateProviderRegistration,
  type SupportedGateClass,
} from './gate-provider-registry.js';

const registrations = (
  ...gateClasses: readonly SupportedGateClass[]
): GateProviderRegistration[] =>
  gateClasses.map((gateClass) => ({
    gateClass,
    actionName: `check_${gateClass.replaceAll('-', '_')}`,
  }));

describe('gate provider registry', () => {
  it('GateProvider_UnknownClass_ReturnsSuggestions', () => {
    const result = BUILTIN_GATE_PROVIDER_REGISTRY.resolve('static-anlysis');

    expect(result).toEqual({
      success: false,
      error: {
        code: 'UNKNOWN_GATE_CLASS',
        message: 'Unknown gate class "static-anlysis"',
        gateClass: 'static-anlysis',
        suggestions: ['static-analysis', 'test-adequacy', 'plan-coverage'],
        validGateClasses: SUPPORTED_GATE_CLASSES,
      },
    });
  });

  it('resolves every durable GateClass exactly once in stable order', () => {
    expect(BUILTIN_GATE_PROVIDER_REGISTRY.list().map((provider) => provider.gateClass))
      .toEqual(SUPPORTED_GATE_CLASSES);

    for (const gateClass of SUPPORTED_GATE_CLASSES) {
      const result = BUILTIN_GATE_PROVIDER_REGISTRY.resolve(gateClass);
      expect(result.success, gateClass).toBe(true);
      if (result.success) {
        expect(result.data.provider.gateClass).toBe(gateClass);
      }
    }
  });

  it('rejects duplicate registrations with a structured diagnostic', () => {
    const result = buildGateProviderRegistry([
      ...registrations(...SUPPORTED_GATE_CLASSES),
      ...registrations('test-adequacy'),
    ]);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'DUPLICATE_GATE_PROVIDER',
        message: 'Gate classes must have exactly one provider',
        gateClasses: ['test-adequacy'],
      },
    });
  });

  it('rejects missing built-ins with a structured diagnostic', () => {
    const result = buildGateProviderRegistry(
      registrations(...SUPPORTED_GATE_CLASSES.filter((gateClass) => gateClass !== 'mock-boundary')),
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'MISSING_GATE_PROVIDER',
        message: 'Every supported gate class must have a provider',
        gateClasses: ['mock-boundary'],
      },
    });
  });

  it('rejects unsupported registrations with ranked safe suggestions', () => {
    const result = buildGateProviderRegistry([
      ...registrations(...SUPPORTED_GATE_CLASSES),
      {
        gateClass: 'contract-drit',
        actionName: 'check_contract_drit',
      },
    ]);

    expect(result).toEqual({
      success: false,
      error: {
        code: 'UNKNOWN_GATE_CLASS',
        message: 'Unknown gate class "contract-drit"',
        gateClass: 'contract-drit',
        suggestions: ['contract-drift', 'test-adequacy', 'mock-boundary'],
        validGateClasses: SUPPORTED_GATE_CLASSES,
      },
    });
  });

  it('canonicalizes registration order instead of inheriting caller order', () => {
    const result = buildGateProviderRegistry(
      registrations(...[...SUPPORTED_GATE_CLASSES].reverse()),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.registry.list().map(({ gateClass }) => gateClass))
        .toEqual(SUPPORTED_GATE_CLASSES);
    }
  });

  it('binds each provider to one real orchestrate action in the production registry', () => {
    const orchestrate = TOOL_REGISTRY.find((tool) => tool.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();

    const ownedActions = orchestrate!.actions.filter((action) => action.gate?.gateClass);
    expect(ownedActions).toHaveLength(SUPPORTED_GATE_CLASSES.length);

    for (const provider of BUILTIN_GATE_PROVIDER_REGISTRY.list()) {
      expect(provider.providerRef).toBe(provider.actionName);
      const matches = ownedActions.filter(
        (action) =>
          action.name === provider.actionName &&
          action.gate?.gateClass === provider.gateClass,
      );
      expect(matches, provider.gateClass).toHaveLength(1);
    }
  });
});
