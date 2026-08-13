import { describe, it, expect } from 'vitest';
import { deriveMetaModel } from '../compiler/meta-model.js';
import { compile } from '../compiler/compile.js';
import {
  BINDING_TABLE,
  implementationBinding,
  type CompositeHandlerLoader,
  type ImplementationBinding,
} from './binding-table.js';
import {
  deriveRegistrationFromRegistry,
  registrationActionRefs,
} from './generate-registration.js';
import {
  verifyBindings,
  assertBindingsAtStartup,
  BindingVerificationError,
  type BindingContract,
} from './verify-bindings.js';

const noopLoader: CompositeHandlerLoader = async () => async () => ({ success: true });

/** The live contract's `{ actionId, tool }` set, derived from the registry. */
function liveContract(): BindingContract {
  return { descriptors: registrationActionRefs(deriveRegistrationFromRegistry()) };
}

describe('verifyBindings — exit proof: missing/duplicate/stale/non-function fail BEFORE startup (P03-04)', () => {
  it('LiveRegistryVerifiesClean_AgainstTheCompiledContract', () => {
    const outcome = compile(deriveMetaModel());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The compiled contract is a structural BindingContract (descriptors carry
      // actionId + tool). Every ActionId must bind to exactly one handler.
      const verdict = verifyBindings(outcome.output, BINDING_TABLE);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    }
    // And the real pre-startup gate does not throw against the real table.
    expect(() => assertBindingsAtStartup()).not.toThrow();
  });

  it('MissingBinding_Fails', () => {
    // Drop the handler for one tool — every ActionId in that tool is now unbound.
    const broken = BINDING_TABLE.filter((b) => b.tool !== 'exarchos_workflow');
    const verdict = verifyBindings(liveContract(), broken);
    expect(verdict.ok).toBe(false);
    const missing = verdict.violations.filter((v) => v.kind === 'missing');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((v) => v.tool === 'exarchos_workflow')).toBe(true);
    expect(missing.some((v) => v.actionId?.startsWith('exarchos_workflow.'))).toBe(true);
    // The gate refuses startup on this table.
    expect(() => assertBindingsAtStartup(broken)).toThrow(BindingVerificationError);
  });

  it('DuplicateBinding_Fails', () => {
    const first = BINDING_TABLE[0];
    expect(first).toBeDefined();
    if (!first) return;
    const dupTable = [...BINDING_TABLE, implementationBinding(first.tool, noopLoader)];
    const verdict = verifyBindings(liveContract(), dupTable);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some((v) => v.kind === 'duplicate' && v.tool === first.tool),
    ).toBe(true);
    expect(() => assertBindingsAtStartup(dupTable)).toThrow(BindingVerificationError);
  });

  it('StaleBinding_Fails', () => {
    const staleTable = [...BINDING_TABLE, implementationBinding('exarchos_ghost', noopLoader)];
    const verdict = verifyBindings(liveContract(), staleTable);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some((v) => v.kind === 'stale' && v.tool === 'exarchos_ghost'),
    ).toBe(true);
    expect(() => assertBindingsAtStartup(staleTable)).toThrow(BindingVerificationError);
  });

  it('SerializableNonFunctionBinding_Fails', () => {
    // A table that was serialized (JSON round-trip) loses its function loaders;
    // verification rejects each as a non-serializable-binding violation.
    const forged = JSON.parse(JSON.stringify(BINDING_TABLE)) as unknown as ImplementationBinding[];
    const verdict = verifyBindings(liveContract(), forged);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'non-function')).toBe(true);
    expect(() => assertBindingsAtStartup(forged)).toThrow(BindingVerificationError);
  });

  it('CleanVerdict_ReportsGreenLight_WithNoViolations', () => {
    const verdict = verifyBindings(liveContract(), BINDING_TABLE);
    expect(verdict.ok).toBe(true);
    expect(verdict.report).toContain('bindings OK');
  });
});
