import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { z } from 'zod';
import { EnvelopeSchema } from '../../../../src/contract/schemas/envelope.js';
import {
  ActionContractError,
  declared,
  none,
  normalizeActionContract,
  type ActionContract,
  type CompositeTool,
  type ToolAction,
} from '../../../../src/registry.js';
import { layerCodes } from '../../../../src/contract/error-families.js';
import { CONTRACT_SURFACE_VERSION } from '../../../../src/contract/compatibility.js';
import { OUTPUT_KINDS } from '../../../../src/contract/envelope.js';
import { canonicalJson } from '../../../../src/contract/request-context.js';
import {
  ActionMetaModelSchema,
  POLICY_DIMENSIONS,
  deriveErrorCodes,
  deriveActionMetaModel,
  deriveMetaModel,
  derivePolicy,
  type ActionMetaModel,
  type MetaModel,
} from '../../../../src/contract/compiler/meta-model.js';
import { compile } from '../../../../src/contract/compiler/compile.js';
import { serializeProofFixtures } from '../../../../src/contract/compiler/fixtures.js';
import { PROOF_FIXTURES_FILE } from '../../../../src/contract/compiler/generate.js';
import {
  FIX_META_MODEL_REMEDY,
  REGENERATE_BASELINE_REMEDY,
  auditMetaModel,
  classifyContractDrift,
  observeRuntimeSurface,
  type MetaModelFinding,
  type RuntimeSurface,
} from '../../../../src/contract/compiler/runtime-authority.js';

function makeAction(overrides: Partial<ToolAction> & { name: string }): ToolAction {
  return {
    description: 'a synthetic action',
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

const CONTRACT_NONE = none('read-only query has no additional obligations');

function validContract(overrides: Partial<ActionContract> = {}): ActionContract {
  return {
    requires: CONTRACT_NONE,
    ensures: CONTRACT_NONE,
    needs: CONTRACT_NONE,
    touches: { frame: 'single-machine', resources: CONTRACT_NONE },
    executionAuthority: { kind: 'local' },
    replay: { kind: 'safe-repeat' },
    emissions: CONTRACT_NONE,
    ...overrides,
  };
}

function withDeclaredContract(action: ToolAction, contract: unknown): ToolAction {
  return Object.assign(action, { actionContract: contract });
}

function makeTool(name: string, actions: readonly ToolAction[]): CompositeTool {
  return { name, description: `tool ${name}`, actions };
}

describe('deriveMetaModel — derived from the live registry', () => {
  it('DerivesEveryActionWithAllTenPolicyDimensions', () => {
    const mm = deriveMetaModel();
    expect(mm.surfaceVersion).toBe(CONTRACT_SURFACE_VERSION);
    expect(mm.actions.length).toBeGreaterThan(100);
    for (const entry of mm.actions) {
      expect(ActionMetaModelSchema.safeParse(entry).success).toBe(true);
      for (const dim of POLICY_DIMENSIONS) {
        expect(entry.policy).toHaveProperty(dim);
      }
      expect(entry.outputKinds).toEqual([...OUTPUT_KINDS].sort());
    }
  });

  it('IsByteStableAcrossRepeatedDerivation', () => {
    expect(canonicalJson(deriveMetaModel())).toBe(canonicalJson(deriveMetaModel()));
  });

  it('SortsActionsByActionId', () => {
    const ids = deriveMetaModel().actions.map((a) => a.actionId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('deriveErrorCodes — task-layer codes are gated on task policy', () => {
  /** `WAIT_TIMEOUT` is a task-layer code, so an action with no task policy must not carry it. */
  it('OmitsTaskLayerCodesForAPlainSynchronousAction', () => {
    const codes = deriveErrorCodes(makeAction({ name: 'plain' }));
    expect(codes).not.toContain('WAIT_TIMEOUT');
    expect(codes).toContain('HANDLER_ERROR');
    expect(codes).toContain('AUTHORIZATION_DENIED');
  });

  it('IncludesTaskLayerCodesForATaskSuitableAction', () => {
    const codes = deriveErrorCodes(makeAction({ name: 'durable', dispatch: { taskSuitable: true } }));
    for (const taskCode of layerCodes('task')) {
      expect(codes).toContain(taskCode);
    }
  });

  it('IncludesTaskLayerCodesForALongRunningAction', () => {
    const codes = deriveErrorCodes(makeAction({ name: 'slow', longRunning: true }));
    expect(codes).toContain('WAIT_TIMEOUT');
  });
});

describe('derivePolicy — faithful projection of registry semantics', () => {
  /** An action is cacheable only when it is read-only and idempotent. */
  it('MarksMutationAndCacheabilityFromAnnotations', () => {
    const readOnly = derivePolicy(makeAction({ name: 'ro' }));
    expect(readOnly.effect.mutates).toBe(false);
    expect(readOnly.cache.cacheable).toBe(true);

    const writer = derivePolicy(
      makeAction({
        name: 'rw',
        annotations: {
          safety: 'local-mutation',
          readOnly: false,
          destructive: false,
          idempotent: false,
          openWorld: false,
        },
      }),
    );
    expect(writer.effect.mutates).toBe(true);
    expect(writer.cache.cacheable).toBe(false);
  });

  it('DerivesCancellabilityFromTaskAndLongRunningFlags', () => {
    expect(derivePolicy(makeAction({ name: 'a' })).cancellation.cancellable).toBe(false);
    expect(
      derivePolicy(makeAction({ name: 'b', longRunning: true })).cancellation.cancellable,
    ).toBe(true);
    expect(
      derivePolicy(makeAction({ name: 'c', dispatch: { taskSuitable: true } })).cancellation
        .cancellable,
    ).toBe(true);
  });
});

describe('deriveMetaModel — line-ending platform stability', () => {
  /** A CRLF working tree and an LF checkout derive the same meta-model bytes. */
  it('NormalizesCrlfDescriptionsToMatchLf', () => {
    const crlf = makeTool('exarchos_probe', [
      makeAction({ name: 'probe', description: 'line one\r\nline two\r\n' }),
    ]);
    const lf = makeTool('exarchos_probe', [
      makeAction({ name: 'probe', description: 'line one\nline two' }),
    ]);
    expect(canonicalJson(deriveMetaModel([crlf]))).toBe(canonicalJson(deriveMetaModel([lf])));
    const entry = deriveActionMetaModel(crlf, crlf.actions[0]!);
    expect(entry.description).not.toContain('\r');
  });
});

/** Replace one entry, keyed by ActionId, leaving the rest of the model intact. */
function patchEntry(
  model: MetaModel,
  actionId: string,
  patch: (entry: ActionMetaModel) => ActionMetaModel,
): MetaModel {
  const actions = model.actions.map((entry) => (entry.actionId === actionId ? patch(entry) : entry));
  expect(canonicalJson(actions)).not.toBe(canonicalJson(model.actions));
  return { ...model, actions };
}

function kindsOf(findings: readonly MetaModelFinding[]): readonly string[] {
  return [...new Set(findings.map((f) => f.kind))].sort();
}

function fieldsOf(findings: readonly MetaModelFinding[], actionId: string): readonly string[] {
  return findings.filter((f) => f.actionId === actionId).map((f) => f.field);
}

/** JSON-Schema property names an entry advertises. */
function propertiesOf(entry: ActionMetaModel): readonly string[] {
  const schema = entry.inputSchema as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {});
}

/**
 * `registry.ts` is the declaration authority and `meta-model.ts` projects it, so a comparison of the two is a tautology.
 * These tests audit the meta-model against the shipped runtime surface, which no code in `meta-model.ts` authors.
 * The surface is the strict MCP registration schema, the `tools/list` description and the `describe` handler.
 * The tests prove that the audit detects a wrong meta-model and tells it from a stale baseline artifact.
 */
describe('DR-11 — the meta-model is audited against the shipped runtime surface', () => {
  /**
   * The shipped meta-model must agree with the shipped runtime surface. That first assertion fails when the derivation is wrong.
   * Each seeded defect must give findings without the baseline artifact:
   * - a policy dimension that drops the evidence which the server advertises
   * - an entry with the input schema of a sibling action, which a registry-to-registry diff cannot see
   * - an input field that the strict wire schema rejects, which also changes the published signature
   * - an action name that the wire discriminator does not accept
   * - an action that the contract omits, together with each field that only that action declares
   * - a dimension with no runtime consumer, which only a hand-authored coherence invariant covers
   */
  it('ContractCompiler_WrongMetaModel_IsDetected', async () => {
    const surface: RuntimeSurface = await observeRuntimeSurface();
    const live = deriveMetaModel();

    expect(auditMetaModel(live, surface)).toEqual([]);
    expect(live.actions.length).toBeGreaterThan(100);

    const emitter = live.actions.find((e) => e.policy.evidence.autoEmits.length > 0);
    expect(emitter).toBeDefined();
    const droppedEvidence = auditMetaModel(
      patchEntry(live, emitter!.actionId, (e) => ({
        ...e,
        policy: { ...e.policy, evidence: { autoEmits: [] } },
      })),
      surface,
    );
    expect(fieldsOf(droppedEvidence, emitter!.actionId)).toContain('policy.evidence.autoEmits');
    expect(droppedEvidence.some((f) => f.provenance === 'runtime-differential')).toBe(true);

    const tool = live.actions[0]!.tool;
    const siblings = live.actions.filter((e) => e.tool === tool);
    const donor = siblings.find(
      (e) => canonicalJson(e.inputSchema) !== canonicalJson(siblings[0]!.inputSchema),
    );
    expect(donor).toBeDefined();
    const swapped = auditMetaModel(
      patchEntry(live, siblings[0]!.actionId, (e) => ({ ...e, inputSchema: donor!.inputSchema })),
      surface,
    );
    expect(swapped.length).toBeGreaterThan(0);
    expect(fieldsOf(swapped, siblings[0]!.actionId)).toContain('inputSchema');
    expect(swapped.some((f) => f.provenance === 'runtime-differential')).toBe(true);

    const invented = auditMetaModel(
      patchEntry(live, live.actions[0]!.actionId, (e) => ({
        ...e,
        inputSchema: {
          ...e.inputSchema,
          properties: {
            ...((e.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
            __not_on_the_wire__: { type: 'string' },
          },
        },
      })),
      surface,
    );
    expect(kindsOf(invented)).toContain('wire-field-rejected');
    expect(kindsOf(invented)).toContain('wire-signature-divergence');
    expect(invented.every((f) => f.provenance === 'runtime-differential')).toBe(true);

    const renamed = auditMetaModel(
      patchEntry(live, live.actions[0]!.actionId, (e) => ({
        ...e,
        action: '__no_such_action__',
        actionId: `${e.tool}.__no_such_action__`,
      })),
      surface,
    );
    expect(kindsOf(renamed)).toContain('wire-action-unadvertised');
    expect(kindsOf(renamed)).toContain('wire-action-unmodelled');

    const orphan = live.actions[0]!;
    const dropped = auditMetaModel({ ...live, actions: live.actions.slice(1) }, surface);
    expect(kindsOf(dropped)).toContain('wire-action-unmodelled');
    expect(dropped.some((f) => f.actionId === orphan.actionId)).toBe(true);
    const orphanOnly = propertiesOf(orphan).filter(
      (p) => !live.actions.slice(1).some((e) => e.tool === orphan.tool && propertiesOf(e).includes(p)),
    );
    for (const property of orphanOnly) {
      expect(dropped.some((f) => f.field === `inputSchema.properties.${property}`)).toBe(true);
    }

    const cacheable = live.actions.find((e) => e.policy.cache.cacheable);
    expect(cacheable).toBeDefined();
    const incoherent = auditMetaModel(
      patchEntry(live, cacheable!.actionId, (e) => ({
        ...e,
        policy: { ...e.policy, cache: { cacheable: false } },
      })),
      surface,
    );
    expect(kindsOf(incoherent)).toEqual(['policy-incoherence']);
    expect(incoherent.every((f) => f.provenance === 'internal-coherence')).toBe(true);

    for (const seeded of [droppedEvidence, swapped, invented, renamed, dropped, incoherent]) {
      expect(seeded.length).toBeGreaterThan(0);
    }
  });

  /**
   * The wrong model here still compiles, so only the runtime differential tells it from a stale artifact.
   * Condition 1 is a stale baseline: the model is sound, and only the checked-in bytes are old.
   * Condition 2 is a wrong model with a baseline regenerated from it: the baseline signal passes, and the audit still fails.
   * The two conditions give different kinds and remedies, and both together give both kinds.
   * The shipped tree is clean on both axes.
   */
  it('ContractCompiler_StaleBaselineOnly_RemainsDistinguishable', async () => {
    const surface = await observeRuntimeSurface();
    const sound = deriveMetaModel();
    const soundFindings = auditMetaModel(sound, surface);
    expect(soundFindings).toEqual([]);

    const victim = sound.actions[0]!;
    const wrong = patchEntry(sound, victim.actionId, (e) => ({
      ...e,
      description: `${e.description} (not what the server advertises)`,
    }));
    const wrongFindings = auditMetaModel(wrong, surface);
    expect(wrongFindings.length).toBeGreaterThan(0);
    expect(wrongFindings.some((f) => f.provenance === 'runtime-differential')).toBe(true);

    const freshFrom = (model: MetaModel): string => {
      const outcome = compile(model);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('compile blocked');
      return serializeProofFixtures(outcome.output.proofFixtures) + '\n';
    };

    const onDisk = fs.readFileSync(PROOF_FIXTURES_FILE, 'utf8');
    const freshFromSound = freshFrom(sound);
    expect(onDisk).toBe(freshFromSound);
    const handEdited = onDisk.replace('"contractDigest"', '"contractDigestX"');
    expect(handEdited).not.toBe(freshFromSound);

    const staleOnly = classifyContractDrift({
      findings: soundFindings,
      baselineMatchesFreshCompile: handEdited === freshFromSound,
    });
    expect(staleOnly.kinds).toEqual(['stale-baseline']);
    expect(staleOnly.remedies).toEqual([REGENERATE_BASELINE_REMEDY]);
    expect(staleOnly.report).toContain('regenerate');

    const regeneratedFromWrong = freshFrom(wrong);
    expect(regeneratedFromWrong).toBe(freshFrom(wrong));
    expect(regeneratedFromWrong).not.toBe(freshFromSound);

    const wrongOnly = classifyContractDrift({
      findings: wrongFindings,
      baselineMatchesFreshCompile: regeneratedFromWrong === freshFrom(wrong),
    });
    expect(wrongOnly.baselineMatchesFreshCompile).toBe(true);
    expect(wrongOnly.kinds).toEqual(['wrong-meta-model']);
    expect(wrongOnly.remedies).toEqual([FIX_META_MODEL_REMEDY]);
    expect(wrongOnly.report).toContain('Regenerating the baseline will NOT clear this');

    expect(staleOnly.kinds).not.toEqual(wrongOnly.kinds);
    expect(staleOnly.remedies[0]).not.toBe(wrongOnly.remedies[0]);

    const both = classifyContractDrift({
      findings: wrongFindings,
      baselineMatchesFreshCompile: false,
    });
    expect([...both.kinds].sort()).toEqual(['stale-baseline', 'wrong-meta-model']);
    expect(both.remedies).toHaveLength(2);
    expect(new Set(both.remedies).size).toBe(2);

    expect(
      classifyContractDrift({
        findings: soundFindings,
        baselineMatchesFreshCompile: onDisk === freshFromSound,
      }).ok,
    ).toBe(true);
  });
});

describe('deriveMetaModel — action-contract projection', () => {
  it('DeriveMetaModel_DoesNotReconstructFromAnnotations', () => {
    const annotatedOnly = makeAction({ name: 'annotated' });
    const declared = validContract({
      emissions: {
        kind: 'declared',
        values: [
          {
            event: 'task.completed',
            condition: 'conditional',
            owner: 'contracted',
            role: 'primary',
          },
        ],
      },
    });
    const contracted = withDeclaredContract(makeAction({ name: 'contracted' }), declared);

    const annotatedEntry = deriveActionMetaModel(makeTool('exarchos_probe', [annotatedOnly]), annotatedOnly);
    const contractedEntry = deriveActionMetaModel(makeTool('exarchos_probe', [contracted]), contracted);

    expect(annotatedEntry.actionContract).toBeUndefined();
    expect(annotatedEntry.policy.actionContract).toBeUndefined();
    expect(annotatedEntry.policy.evidence.autoEmits).toEqual([]);

    expect(contractedEntry.actionContract).toEqual(normalizeActionContract(declared));
    expect(contractedEntry.policy.actionContract).toEqual(contractedEntry.actionContract);
    expect(contractedEntry.policy.evidence.autoEmits).toEqual([{ event: 'task.completed', condition: 'conditional' }]);
    expect(contractedEntry.policy.evidence.autoEmits).not.toEqual(annotatedEntry.policy.evidence.autoEmits);
  });

  it('DeriveMetaModel_ReorderedSets_IsByteStable', () => {
    const emissions = [
      { event: 'task.completed', condition: 'conditional' as const, owner: 'b', role: 'primary' as const },
      { event: 'workflow.started', condition: 'always' as const, owner: 'a', role: 'primary' as const },
    ] as const;
    const resources = [
      { kind: 'path' as const, selector: 'src/registry' },
      { kind: 'stream' as const, selector: 'feature-a' },
    ] as const;

    const forward = validContract({
      needs: { kind: 'declared', values: ['fs:write', 'shell:exec', 'fs:read'] },
      touches: { frame: 'single-machine', resources: { kind: 'declared', values: [...resources] } },
      emissions: { kind: 'declared', values: [...emissions] },
    });
    const reversed = validContract({
      needs: { kind: 'declared', values: ['fs:read', 'shell:exec', 'fs:write'] },
      touches: {
        frame: 'single-machine',
        resources: { kind: 'declared', values: [resources[1], resources[0]] },
      },
      emissions: { kind: 'declared', values: [emissions[1], emissions[0]] },
    });

    const toolA = makeTool('exarchos_probe', [withDeclaredContract(makeAction({ name: 'probe' }), forward)]);
    const toolB = makeTool('exarchos_probe', [withDeclaredContract(makeAction({ name: 'probe' }), reversed)]);
    const left = deriveMetaModel([toolA]);
    const right = deriveMetaModel([toolB]);

    expect(left.actions[0]!.actionContract).toBeDefined();
    expect(left.actions[0]!.actionContract).toEqual(normalizeActionContract(forward));
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left.actions[0]!.actionContract)).toBe(canonicalJson(normalizeActionContract(reversed)));
  });
});

describe('deriveMetaModel — emission source binding', () => {
  /**
   * `task.progressed` is a catalog event with the emission source `model`, not `auto`.
   * The derivation must reject an action that declares it as an emission, as admission does.
   */
  it('CompileContract_NonAutoEmissionSource_RejectsActionAndEvent', () => {
    const badContract = validContract({
      emissions: declared({
        event: 'task.progressed',
        condition: 'always',
        owner: 'planner',
        role: 'primary',
      }),
    });
    const action = withDeclaredContract(makeAction({ name: 'assign' }), badContract);
    const tool = makeTool('exarchos_probe', [action]);

    try {
      deriveActionMetaModel(tool, action);
      expect.fail('expected a non-auto emission source to be rejected at derivation');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionContractError);
      if (error instanceof ActionContractError) {
        expect(error.message).toContain('exarchos_probe.assign');
        expect(error.message).toContain('task.progressed');
      }
    }
    expect(() => deriveMetaModel([tool])).toThrow(/task\.progressed/);
  });

  /** Every emission in the live registry has the source `auto`, so the source check must not change the derived bytes. */
  it('CompileContract_AutoEmissionSource_RemainsByteStable', () => {
    const first = deriveMetaModel();
    const second = deriveMetaModel();
    expect(canonicalJson(first)).toBe(canonicalJson(second));

    const r1 = compile(first);
    const r2 = compile(second);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.output.serialized).toBe(r2.output.serialized);
      expect(r1.output.digest).toBe(r2.output.digest);
    }
  });
});
