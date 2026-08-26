// @oracle-sources: ../../../../src/contract/compiler/descriptors.ts, the contract literals this file authors by hand and hands to the compiler as input
//
// The claim is that compilation carries an action contract through UNCHANGED.
// One authority is the compiler; the other is the input the test author wrote,
// which the compiler never sees the provenance of. Reading the expectation back
// out of the compiler would make the assertion vacuous.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EnvelopeSchema } from '../../../../src/contract/schemas/envelope.js';
import { digestText } from '../../../../src/contract/authority-digest.js';
import { canonicalJson } from '../../../../src/contract/request-context.js';
import {
  deriveActionMetaModel,
  deriveMetaModel,
} from '../../../../src/contract/compiler/meta-model.js';
import type { ActionMetaModel } from '../../../../src/contract/compiler/meta-model.js';
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
} from '../../../../src/contract/compiler/descriptors.js';
import {
  none,
  normalizeActionContract,
  type ActionContract,
  type CompositeTool,
  type ToolAction,
} from '../../../../src/registry.js';

const CONTRACT_NONE = none('read-only query has no additional obligations');

function validContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return normalizeActionContract({
    requires: CONTRACT_NONE,
    ensures: CONTRACT_NONE,
    needs: CONTRACT_NONE,
    touches: { frame: 'single-machine', resources: CONTRACT_NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: CONTRACT_NONE,
    ...overrides,
  });
}

function makeAction(overrides: Partial<ToolAction> & { name: string }): ToolAction {
  return {
    description: 'synthetic',
    schema: z.object({ x: z.string() }),
    phases: new Set<string>(),
    roles: new Set<string>(['lead']),
    outputSchema: EnvelopeSchema(z.unknown()),
    annotations: {
      safety: 'read-only',
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    },
    ...overrides,
  };
}

function makeTool(name: string, actions: readonly ToolAction[]): CompositeTool {
  return { name, description: `tool ${name}`, actions };
}

function contractedEntry(contract: ActionContract): ActionMetaModel {
  const action = Object.assign(makeAction({ name: 'probe' }), { actionContract: contract });
  return deriveActionMetaModel(makeTool('exarchos_probe', [action]), action);
}

function firstEntry(): ActionMetaModel {
  const entry = deriveMetaModel().actions[0];
  if (!entry) throw new Error('registry produced no actions');
  return entry;
}

const CONTRACT_FIELD_MUTATIONS: ReadonlyArray<readonly [string, ActionContract]> = [
  ['requires', validContract({ requires: none('a different abstention reason') })],
  [
    'ensures',
    validContract({
      ensures: {
        kind: 'declared',
        values: [{ source: 'durable-evidence', when: 'success', evidenceType: 'review-verdict' }],
      },
    }),
  ],
  ['needs', validContract({ needs: { kind: 'declared', values: ['fs:read'] } })],
  [
    'touches',
    validContract({
      touches: {
        frame: 'single-machine',
        resources: { kind: 'declared', values: [{ kind: 'path', selector: 'src/registry' }] },
      },
    }),
  ],
  [
    'executionAuthority',
    validContract({ executionAuthority: { kind: 'host', obligation: 'human-approval' } }),
  ],
  ['replay', validContract({ replay: { kind: 'reject-replay', because: 'must run once' } })],
  [
    'emissions',
    validContract({
      emissions: {
        kind: 'declared',
        values: [{ event: 'workflow.started', condition: 'always', owner: 'probe', role: 'primary' }],
      },
    }),
  ],
];

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
      ...(entry.actionContract === undefined ? {} : { actionContract: entry.actionContract }),
    };
    expect(compileDescriptor(reordered).digest).toBe(compileDescriptor(entry).digest);
  });

  it('Descriptor_ContractChange_ChangesDigest', () => {
    const baseContract = validContract();
    const entry = contractedEntry(baseContract);
    const base = compileDescriptor(entry);
    expect(base.actionContract).toEqual(baseContract);
    expect(base.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    for (const [field, mutated] of CONTRACT_FIELD_MUTATIONS) {
      const next = compileDescriptor({ ...entry, actionContract: mutated });
      expect(next.actionContract, field).toEqual(mutated);
      expect(next.digest, `${field} must move the descriptor digest`).not.toBe(base.digest);
    }
  });

  it('canonical serialization is deterministic across key insertion order', () => {
    const shuffled = validContract({
      needs: { kind: 'declared', values: ['shell:exec', 'fs:read', 'fs:write'] },
      emissions: {
        kind: 'declared',
        values: [
          { event: 'task.completed', condition: 'conditional', owner: 'b', role: 'primary' },
          { event: 'workflow.started', condition: 'always', owner: 'a', role: 'primary' },
        ],
      },
    });
    const reversed = validContract({
      needs: { kind: 'declared', values: ['fs:write', 'fs:read', 'shell:exec'] },
      emissions: {
        kind: 'declared',
        values: [
          { event: 'workflow.started', condition: 'always', owner: 'a', role: 'primary' },
          { event: 'task.completed', condition: 'conditional', owner: 'b', role: 'primary' },
        ],
      },
    });
    const left = compileDescriptor(contractedEntry(shuffled));
    const right = compileDescriptor(contractedEntry(reversed));
    expect(left.digest).toBe(right.digest);
    expect(canonicalJson(left.actionContract)).toBe(canonicalJson(right.actionContract));
    expect(digestText(canonicalJson(left.actionContract))).toBe(
      digestText(canonicalJson(reversed)),
    );
  });

  it('does not invent an action contract from annotations or autoEmits', () => {
    const annotated = makeAction({
      name: 'annotated',
      autoEmits: [{ event: 'workflow.started', condition: 'always', owner: 'annotated', role: 'primary' }],
    });
    const entry = deriveActionMetaModel(makeTool('exarchos_probe', [annotated]), annotated);
    const descriptor = compileDescriptor(entry);
    expect(entry.actionContract).toBeUndefined();
    expect(descriptor.actionContract).toBeUndefined();
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
