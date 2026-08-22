import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { digestText } from '../../src/contract/authority-digest.js';
import type { AuthorityVerdict } from '../../src/contract/authority-pin.js';
import { compile } from '../../src/contract/compiler/compile.js';
import { compileDescriptor } from '../../src/contract/compiler/descriptors.js';
import { buildProofFixtures, serializeProofFixtures } from '../../src/contract/compiler/fixtures.js';
import { deriveActionMetaModel, deriveMetaModel } from '../../src/contract/compiler/meta-model.js';
import { canonicalJson } from '../../src/contract/request-context.js';
import { unregisteredActionOutputSchema } from '../../src/output-schema-declaration.js';
import {
  none,
  normalizeActionContract,
  type ActionContract,
  type CompositeTool,
  type ToolAction,
} from '../../src/registry.js';

const okVerdict: AuthorityVerdict = { ok: true, violations: [], report: 'ok (stub)' };
const OK = { verifyAuthority: () => okVerdict } as const;

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
    outputSchema: unregisteredActionOutputSchema(),
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

function withDeclaredContract(action: ToolAction, contract: unknown): ToolAction {
  return Object.assign(action, { actionContract: contract });
}

function compileContracted(contract: ActionContract) {
  const action = withDeclaredContract(makeAction({ name: 'probe' }), contract);
  const model = deriveMetaModel([makeTool('exarchos_probe', [action])]);
  const outcome = compile(model, OK);
  if (!outcome.ok) {
    throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));
  }
  return outcome.output;
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

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTypeScriptFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('action-contract descriptor binding', () => {
  it('Descriptor_ContractChange_ChangesDigest', () => {
    const baseContract = validContract();
    const action = withDeclaredContract(makeAction({ name: 'probe' }), baseContract);
    const entry = deriveActionMetaModel(makeTool('exarchos_probe', [action]), action);
    const baseDigest = compileDescriptor(entry).digest;

    for (const [field, mutated] of CONTRACT_FIELD_MUTATIONS) {
      const next = compileDescriptor({ ...entry, actionContract: mutated });
      expect(next.digest, `${field} must move the descriptor digest`).not.toBe(baseDigest);
    }
  });

  it('ProofFixture_ContainsContractDigest', () => {
    const contract = validContract({
      needs: { kind: 'declared', values: ['fs:read'] },
    });
    const output = compileContracted(contract);
    const descriptor = output.descriptors[0];
    const fixture = output.proofFixtures.actions[0];
    if (descriptor === undefined || fixture === undefined) {
      throw new Error('expected a compiled action fixture');
    }

    expect(output.proofFixtures.contractDigest).toBe(output.contractDigest);
    expect(output.proofFixtures.contractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fixture.descriptorDigest).toBe(descriptor.digest);
    expect(descriptor.actionContract).toEqual(contract);
    expect(fixture.actionContractDigest).toBe(digestText(canonicalJson(contract)));
    expect(fixture.actionContractDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('ProofFixture_RepeatedBuild_IsByteStable', () => {
    const contract = validContract({
      needs: { kind: 'declared', values: ['fs:write', 'fs:read'] },
      emissions: {
        kind: 'declared',
        values: [
          { event: 'task.completed', condition: 'always', owner: 'probe', role: 'primary' },
        ],
      },
    });
    const first = compileContracted(contract);
    const second = compileContracted(contract);
    expect(serializeProofFixtures(first.proofFixtures)).toBe(serializeProofFixtures(second.proofFixtures));
    expect(first.serialized).toBe(second.serialized);

    const rebuilt = buildProofFixtures(
      first.surfaceVersion,
      first.descriptors,
      first.schemas,
      first.contractDigest,
      first.proofFixtures.authority,
    );
    expect(serializeProofFixtures(rebuilt)).toBe(serializeProofFixtures(first.proofFixtures));
    expect(serializeProofFixtures(rebuilt)).toContain('"actionContractDigest"');
  });

  it('does not invent a contract for live actions that omit one', () => {
    const live = deriveMetaModel();
    const uncontracted = live.actions.find((entry) => entry.actionContract === undefined);
    expect(uncontracted).toBeDefined();
    if (uncontracted === undefined) throw new Error('expected an uncontracted live action');
    const descriptor = compileDescriptor(uncontracted);
    expect(descriptor.actionContract).toBeUndefined();
  });

  it('dispatch does not read compiled descriptors as runtime authority', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dispatchRoot = path.resolve(here, '../../src/dispatch');
    const offenders: string[] = [];
    for (const file of listTypeScriptFiles(dispatchRoot)) {
      const text = fs.readFileSync(file, 'utf8');
      if (
        text.includes('contract/compiler/descriptors') ||
        text.includes('compileDescriptor') ||
        text.includes('proof-fixtures')
      ) {
        offenders.push(path.relative(dispatchRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
