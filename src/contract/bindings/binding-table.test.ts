import { describe, it, expect } from 'vitest';
import { COMPOSITE_HANDLER_LOADERS } from '../../dispatch/core/dispatch.js';
import {
  BINDING_TABLE,
  buildBindingTable,
  implementationBinding,
  isImplementationBinding,
  type CompositeHandlerLoader,
  type ImplementationBinding,
} from './binding-table.js';

const noopLoader: CompositeHandlerLoader = async () =>
  async () => ({ success: true });

describe('binding-table — non-serializable implementation bindings (P03-04)', () => {
  it('BindingTable_CoversEveryCompositeHandlerLoader_AsAFunctionReference', () => {
    // The table is DERIVED from the real loader map, one binding per tool.
    const tools = BINDING_TABLE.map((b) => b.tool).sort();
    expect(tools).toEqual(Object.keys(COMPOSITE_HANDLER_LOADERS).sort());
    for (const binding of BINDING_TABLE) {
      expect(typeof binding.load).toBe('function');
      // The held loader is the REAL dispatch loader, not a copy/name.
      expect(binding.load).toBe(COMPOSITE_HANDLER_LOADERS[binding.tool]);
    }
  });

  it('BindingTable_IsSortedByTool_ForAStableDiff', () => {
    const tools = BINDING_TABLE.map((b) => b.tool);
    expect(tools).toEqual([...tools].sort());
  });

  it('EveryLiveBinding_IsAWellFormedNonSerializableHolder', () => {
    for (const binding of BINDING_TABLE) {
      expect(isImplementationBinding(binding)).toBe(true);
    }
  });

  it('SerializableStandIn_IsRejectedByTheRuntimeGuard', () => {
    // A binding cannot survive serialization — JSON.stringify strips the
    // function `load` (and the phantom brand), so a round-tripped table is no
    // longer a valid binding. This is the runtime half of "non-serializable".
    const forged = JSON.parse(JSON.stringify(BINDING_TABLE)) as unknown[];
    expect(forged.length).toBe(BINDING_TABLE.length);
    for (const entry of forged) {
      expect(isImplementationBinding(entry)).toBe(false);
    }
    // A bare string / plain object is likewise not a binding.
    expect(isImplementationBinding('exarchos_workflow')).toBe(false);
    expect(isImplementationBinding({ tool: 'exarchos_workflow', load: 'handleWorkflow' })).toBe(false);
    expect(isImplementationBinding(null)).toBe(false);
  });

  it('BuildBindingTable_DerivesFromAnInjectedLoaderMap', () => {
    const table: readonly ImplementationBinding[] = buildBindingTable({
      exarchos_beta: noopLoader,
      exarchos_alpha: noopLoader,
    });
    expect(table.map((b) => b.tool)).toEqual(['exarchos_alpha', 'exarchos_beta']);
    for (const b of table) expect(typeof b.load).toBe('function');
  });

  it('ImplementationBinding_HoldsTheProvidedFunction', () => {
    const b = implementationBinding('exarchos_x', noopLoader);
    expect(b.tool).toBe('exarchos_x');
    expect(b.load).toBe(noopLoader);
    expect(isImplementationBinding(b)).toBe(true);
  });
});
