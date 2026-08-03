import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../request-context.js';
import { deriveMetaModel } from './meta-model.js';
import type { ActionMetaModel } from './meta-model.js';
import {
  compileDescriptor,
  pascalCase,
  deriveTypeNames,
  buildSchemaBundle,
  buildTypeManifest,
  actionInputSchemaRef,
  SURFACE_ERROR_SCHEMA_REF,
  SURFACE_CAPPED_SCHEMA_REF,
  SHARED_ERROR_TYPE,
} from './descriptors.js';

function firstEntry(): ActionMetaModel {
  const entry = deriveMetaModel().actions[0];
  if (!entry) throw new Error('registry produced no actions');
  return entry;
}

describe('pascalCase / deriveTypeNames', () => {
  it('PascalCasesAnActionIdAcrossSeparators', () => {
    expect(pascalCase('exarchos_workflow.init')).toBe('ExarchosWorkflowInit');
    expect(pascalCase('exarchos_view.workflow_status')).toBe('ExarchosViewWorkflowStatus');
  });

  it('DerivesStableInputOutputTypeStems', () => {
    const names = deriveTypeNames('exarchos_workflow.init');
    expect(names.input).toBe('ExarchosWorkflowInitInput');
    expect(names.output).toBe('ExarchosWorkflowInitOutput');
    expect(names.error).toBe(SHARED_ERROR_TYPE);
  });
});

describe('compileDescriptor', () => {
  it('EmbedsAContentDigestOverTheDescriptorBody', () => {
    const entry = firstEntry();
    const d = compileDescriptor(entry);
    expect(d.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.schemaRefs.input).toBe(actionInputSchemaRef(entry.actionId));
    expect(d.schemaRefs.error).toBe(SURFACE_ERROR_SCHEMA_REF);
    expect(d.schemaRefs.capped).toBe(SURFACE_CAPPED_SCHEMA_REF);
  });

  it('ChangesTheDigestWhenPolicyChanges', () => {
    const entry = firstEntry();
    const base = compileDescriptor(entry).digest;
    const mutated = compileDescriptor({
      ...entry,
      policy: {
        ...entry.policy,
        economy: { ...entry.policy.economy, budgetTokens: entry.policy.economy.budgetTokens + 1 },
      },
    }).digest;
    expect(mutated).not.toBe(base);
  });

  it('IsInsensitiveToDescriptorKeyInsertionOrder', () => {
    const entry = firstEntry();
    // Two entries with keys inserted in different order must digest identically.
    const reordered: ActionMetaModel = {
      policy: entry.policy,
      outputKinds: entry.outputKinds,
      errorCodes: entry.errorCodes,
      outputSchema: entry.outputSchema,
      inputSchema: entry.inputSchema,
      surfaceVersion: entry.surfaceVersion,
      description: entry.description,
      action: entry.action,
      tool: entry.tool,
      actionId: entry.actionId,
    };
    expect(compileDescriptor(reordered).digest).toBe(compileDescriptor(entry).digest);
  });
});

describe('buildSchemaBundle / buildTypeManifest', () => {
  it('HoistsTheSharedCarrierSchemasAndKeysActionsByActionId', () => {
    const entries = deriveMetaModel().actions;
    const bundle = buildSchemaBundle(entries);
    expect(bundle.surface).toHaveProperty(SURFACE_ERROR_SCHEMA_REF);
    expect(bundle.surface).toHaveProperty(SURFACE_CAPPED_SCHEMA_REF);
    const first = entries[0]!;
    expect(bundle.actions[first.actionId]).toBeDefined();
    expect(bundle.actions[first.actionId]!.input).toEqual(first.inputSchema);
  });

  it('BuildsAByteStableTypeManifest', () => {
    const entries = deriveMetaModel().actions;
    const a = buildTypeManifest('1.0.0', entries);
    const b = buildTypeManifest('1.0.0', entries);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(a.sharedTypes).toEqual([...a.sharedTypes].sort());
  });
});
