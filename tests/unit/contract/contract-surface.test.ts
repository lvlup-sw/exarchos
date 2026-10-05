import { describe, it, expect } from 'vitest';
import { contractSurface, serializeContractSurface } from '../../../src/contract/contract-surface.js';
import { digestText } from '../../../src/contract/authority-digest.js';
import { loadAuthorityLock } from '../../../src/contract/authority-collector.js';
import { FAILURE_LAYERS } from '../../../src/contract/error-families.js';
import { OUTPUT_KINDS } from '../../../src/contract/envelope.js';

describe('contract-surface — canonical serialization', () => {
  it('IsDeterministic', () => {
    expect(serializeContractSurface()).toBe(serializeContractSurface());
  });

  it('EnumeratesTheClosedContract', () => {
    const surface = contractSurface();
    expect(Object.keys(surface.families as object).sort()).toEqual([...FAILURE_LAYERS].sort());
    expect(Object.keys(surface.outputKinds as object).sort()).toEqual([...OUTPUT_KINDS].sort());
    expect(surface.version).toBe('1.0.0');
  });

  it('IsSensitiveToStructuralChange', () => {
    const base = JSON.parse(serializeContractSurface()) as Record<string, unknown>;
    const mutated = { ...base, version: '9.9.9' };
    expect(JSON.stringify(mutated)).not.toBe(serializeContractSurface());
  });
});

describe('contract-surface — bound to the frozen `contract-surface` pin', () => {
  /**
   * The collector digests this serialization.
   * If the surface drifts from the approved pin, the authority freeze blocks generation.
   */
  it('DigestMatchesTheCheckedInLock', () => {
    const lock = loadAuthorityLock();
    const pin = lock.authorities['contract-surface'];
    expect(pin).toBeDefined();
    expect(pin?.digest).toBe(digestText(serializeContractSurface()));
    expect(pin?.approved).toBe(true);
  });
});
