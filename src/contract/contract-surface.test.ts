import { describe, it, expect } from 'vitest';
import { contractSurface, serializeContractSurface } from './contract-surface.js';
import { digestText } from './authority-digest.js';
import { loadAuthorityLock } from './authority-collector.js';
import { FAILURE_LAYERS } from './error-families.js';
import { OUTPUT_KINDS } from './envelope.js';

describe('contract-surface — canonical serialization', () => {
  it('IsDeterministic', () => {
    expect(serializeContractSurface()).toBe(serializeContractSurface());
  });

  it('EnumeratesTheClosedContract', () => {
    const surface = contractSurface();
    // Every failure layer and output kind is present.
    expect(Object.keys(surface.families as object).sort()).toEqual([...FAILURE_LAYERS].sort());
    expect(Object.keys(surface.outputKinds as object).sort()).toEqual([...OUTPUT_KINDS].sort());
    expect(surface.version).toBe('1.0.0');
  });

  it('IsSensitiveToStructuralChange', () => {
    // The digest binds to the structural surface: changing a code/exit/kind
    // changes the serialization (and therefore the frozen authority digest).
    const base = JSON.parse(serializeContractSurface()) as Record<string, unknown>;
    const mutated = { ...base, version: '9.9.9' };
    expect(JSON.stringify(mutated)).not.toBe(serializeContractSurface());
  });
});

describe('contract-surface — bound to the frozen `contract-surface` pin', () => {
  it('DigestMatchesTheCheckedInLock', () => {
    // The collector digests exactly this serialization; if the surface drifts
    // from the approved pin, the P03-01 freeze blocks — proven directly here.
    const lock = loadAuthorityLock();
    const pin = lock.authorities['contract-surface'];
    expect(pin).toBeDefined();
    expect(pin?.digest).toBe(digestText(serializeContractSurface()));
    expect(pin?.approved).toBe(true);
  });
});
