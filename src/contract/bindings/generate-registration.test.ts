import { describe, it, expect } from 'vitest';
import { deriveMetaModel } from '../compiler/meta-model.js';
import { compile } from '../compiler/compile.js';
import {
  generateRegistration,
  deriveRegistrationFromRegistry,
  serializeRegistration,
  registrationActionRefs,
  REGISTRATION_VERSION,
} from './generate-registration.js';

function compiledContract() {
  const outcome = compile(deriveMetaModel());
  if (!outcome.ok) throw new Error('live contract failed to compile');
  return outcome.output;
}

describe('generate-registration — deterministic MCP discovery projection (P03-04)', () => {
  it('GeneratedRegistration_IsByteStableAcrossRepeatedGeneration', () => {
    const contract = compiledContract();
    const a = serializeRegistration(generateRegistration(contract));
    const b = serializeRegistration(generateRegistration(contract));
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    // Line-ending-normalized — canonical JSON never emits a raw carriage return.
    expect(a.includes('\r')).toBe(false);
  });

  it('ContractDerived_And_RegistryDerived_RegistrationsAgreeByteForByte', () => {
    // Generation is FROM the compiled contract; the cheap registry-derived path
    // the startup gate uses must project the identical manifest — otherwise the
    // gate would verify against a different ActionId set than the contract.
    const fromContract = serializeRegistration(generateRegistration(compiledContract()));
    const fromRegistry = serializeRegistration(deriveRegistrationFromRegistry());
    expect(fromRegistry).toBe(fromContract);
  });

  it('RegistrationTools_AndActions_AreSortedDeterministically', () => {
    const manifest = generateRegistration(compiledContract());
    expect(manifest.registrationVersion).toBe(REGISTRATION_VERSION);
    const toolNames = manifest.tools.map((t) => t.tool);
    expect(toolNames).toEqual([...toolNames].sort());
    for (const tool of manifest.tools) {
      const actionIds = tool.actions.map((a) => a.actionId);
      expect(actionIds).toEqual([...actionIds].sort());
      for (const action of tool.actions) {
        expect(action.actionId).toBe(`${tool.tool}.${action.action}`);
      }
    }
  });

  it('RegistrationActionRefs_CoverEveryCompiledActionId', () => {
    const contract = compiledContract();
    const refs = registrationActionRefs(generateRegistration(contract));
    const refIds = refs.map((r) => r.actionId).sort();
    const contractIds = contract.descriptors.map((d) => d.actionId).sort();
    expect(refIds).toEqual(contractIds);
    for (const ref of refs) {
      expect(ref.actionId.startsWith(`${ref.tool}.`)).toBe(true);
    }
  });
});
