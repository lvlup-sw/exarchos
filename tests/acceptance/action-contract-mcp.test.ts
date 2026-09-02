import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  deriveRegistrationFromRegistry,
  generateRegistration,
} from '../../src/contract/bindings/generate-registration.js';
import { compile } from '../../src/contract/compiler/compile.js';
import { deriveMetaModel } from '../../src/contract/compiler/meta-model.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import { normalizeActionContract, TOOL_REGISTRY, type ToolAction } from '../../src/registry.js';
import {
  ACTION_CONTRACT_DIMENSIONS,
  appendCompactActionContracts,
  buildToolDescription,
  compactActionContract,
  projectCompactActionContract,
  type CompactActionContract,
} from '../../src/registry/schema-builders.js';

const VISIBLE_TOOL_NAMES = [
  'exarchos_event',
  'exarchos_orchestrate',
  'exarchos_view',
  'exarchos_workflow',
] as const;

function compiledContract() {
  const outcome = compile(deriveMetaModel());
  if (!outcome.ok) throw new Error('live contract failed to compile');
  return outcome.output;
}

function advertisedActions(): readonly { readonly toolName: string; readonly action: ToolAction }[] {
  return TOOL_REGISTRY.filter((tool) => !tool.hidden).flatMap((tool) =>
    tool.actions.map((action) => ({ toolName: tool.name, action })),
  );
}

function readDeclaredContract(action: ToolAction): unknown {
  if (!('actionContract' in action)) return undefined;
  return Reflect.get(action, 'actionContract');
}

function hasDimensionPresence(summary: CompactActionContract): boolean {
  return ACTION_CONTRACT_DIMENSIONS.every((dimension) => summary[dimension] !== undefined);
}

function makeBareAction(name: string): ToolAction {
  return {
    name,
    description: 'annotation-only fixture',
    schema: z.object({}),
    phases: new Set<string>(),
    roles: new Set<string>(['lead']),
    outputSchema: unregisteredActionOutputSchema(),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
  };
}

describe('MCP compact action-contract registration', () => {
  it('McpRegistration_ContractSummary_IsRegistryDerived', () => {
    const fromRegistry = deriveRegistrationFromRegistry();
    const fromContract = generateRegistration(compiledContract());
    expect(fromRegistry).toEqual(fromContract);

    for (const { toolName, action } of advertisedActions()) {
      const projected = projectCompactActionContract(action);
      const registered = fromRegistry.tools
        .find((entry) => entry.tool === toolName)
        ?.actions.find((entry) => entry.action === action.name);
      expect(registered, `${toolName}.${action.name} missing from registration`).toBeDefined();
      expect(registered!.contractSummary).toEqual(projected ?? null);

      const declared = readDeclaredContract(action);
      if (declared !== undefined) {
        expect(registered!.contractSummary).toEqual(
          compactActionContract(
            normalizeActionContract(declared, { annotations: action.annotations }),
          ),
        );
      }
    }

    for (const tool of TOOL_REGISTRY.filter((entry) => !entry.hidden)) {
      const advertised = appendCompactActionContracts(buildToolDescription(tool, false), tool.actions);
      expect(advertised).toContain('Action contracts:');
      for (const action of tool.actions) {
        const compact = projectCompactActionContract(action);
        if (compact === undefined) {
          expect(advertised).toContain(`- ${action.name}: absent`);
        } else {
          expect(advertised).toContain(`- ${action.name}: digest=${compact.digest}`);
        }
      }
    }
  });

  it('McpRegistration_VisibleToolCount_RemainsFour', () => {
    const visible = TOOL_REGISTRY.filter((tool) => !tool.hidden);
    expect(visible).toHaveLength(4);
    expect(visible.map((tool) => tool.name).sort()).toEqual([...VISIBLE_TOOL_NAMES].sort());

    const advertisedTools = deriveRegistrationFromRegistry().tools.filter((tool) =>
      VISIBLE_TOOL_NAMES.includes(tool.tool as (typeof VISIBLE_TOOL_NAMES)[number]),
    );
    expect(advertisedTools).toHaveLength(4);
    expect(TOOL_REGISTRY.some((tool) => tool.hidden === true)).toBe(true);
  });

  it('McpRegistration_Compact_RetainsDimensionPresence', () => {
    const manifest = deriveRegistrationFromRegistry();
    for (const { toolName, action } of advertisedActions()) {
      const registered = manifest.tools
        .find((entry) => entry.tool === toolName)
        ?.actions.find((entry) => entry.action === action.name);
      expect(registered).toBeDefined();
      const compact = projectCompactActionContract(action);
      expect(registered!.contractSummary).toEqual(compact ?? null);
      if (compact === undefined) {
        expect(registered!.contractSummary).toBeNull();
        continue;
      }
      expect(hasDimensionPresence(compact)).toBe(true);
      expect(compact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(compact)).not.toMatch(/because|description|values/);
    }

    expect(projectCompactActionContract(makeBareAction('probe'))).toBeUndefined();
  });

  it('every advertised action has one deterministic projection', () => {
    const first = deriveRegistrationFromRegistry();
    const second = deriveRegistrationFromRegistry();
    expect(first).toEqual(second);
    expect(generateRegistration(compiledContract())).toEqual(first);

    const advertisedIds = advertisedActions().map(
      ({ toolName, action }) => `${toolName}.${action.name}`,
    );
    const projections = first.tools
      .filter((tool) => VISIBLE_TOOL_NAMES.includes(tool.tool as (typeof VISIBLE_TOOL_NAMES)[number]))
      .flatMap((tool) => tool.actions);
    expect(projections.map((action) => action.actionId).sort()).toEqual([...advertisedIds].sort());
    expect(new Set(projections.map((action) => action.actionId)).size).toBe(projections.length);
  });
});
