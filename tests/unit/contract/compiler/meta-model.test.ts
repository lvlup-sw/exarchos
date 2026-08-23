import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { z } from 'zod';
import { EnvelopeSchema } from '../../../../src/contract/schemas/envelope.js';
import {
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

// ─── Test fixtures — synthetic registry entries ──────────────────────────────

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
      // Every derived entry is a valid meta-model entry …
      expect(ActionMetaModelSchema.safeParse(entry).success).toBe(true);
      // … and carries all ten policy dimensions.
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
  it('OmitsTaskLayerCodesForAPlainSynchronousAction', () => {
    const codes = deriveErrorCodes(makeAction({ name: 'plain' }));
    // WAIT_TIMEOUT belongs to the task layer; a non-task action must not claim it.
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
  it('MarksMutationAndCacheabilityFromAnnotations', () => {
    const readOnly = derivePolicy(makeAction({ name: 'ro' }));
    expect(readOnly.effect.mutates).toBe(false);
    expect(readOnly.cache.cacheable).toBe(true); // readOnly && idempotent

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
  it('NormalizesCrlfDescriptionsToMatchLf', () => {
    const crlf = makeTool('exarchos_probe', [
      makeAction({ name: 'probe', description: 'line one\r\nline two\r\n' }),
    ]);
    const lf = makeTool('exarchos_probe', [
      makeAction({ name: 'probe', description: 'line one\nline two' }),
    ]);
    // A CRLF working tree and an LF checkout derive a byte-identical meta-model.
    expect(canonicalJson(deriveMetaModel([crlf]))).toBe(canonicalJson(deriveMetaModel([lf])));
    const entry = deriveActionMetaModel(crlf, crlf.actions[0]!);
    expect(entry.description).not.toContain('\r');
  });
});

// ─── DR-11 / T-16 — the compiler-vs-registry authority differential ──────────
//
// `registry.ts` is the declaration authority and `meta-model.ts` projects it,
// so a guard that compares the meta-model back against `TOOL_REGISTRY` the way
// the meta-model was derived from it is a tautology. These two tests instead
// audit the meta-model against the SHIPPED RUNTIME SURFACE (the strict MCP
// registration schema, the `tools/list` description, and the `describe`
// handler) — a projection authored outside `meta-model.ts` — and prove the
// resulting signal is (a) able to go red on a genuinely wrong meta-model and
// (b) distinguishable from a merely stale baseline artifact.

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

describe('DR-11 — the meta-model is audited against the shipped runtime surface', () => {
  it('ContractCompiler_WrongMetaModel_IsDetected', async () => {
    const surface: RuntimeSurface = await observeRuntimeSurface();
    const live = deriveMetaModel();

    // ── Arm 1: the SHIPPED meta-model agrees with the shipped runtime surface.
    // This is the arm that goes red when the derivation in `meta-model.ts` is
    // wrong — it is anchored to reality, not to a self-derived baseline.
    expect(auditMetaModel(live, surface)).toEqual([]);
    expect(live.actions.length).toBeGreaterThan(100);

    // ── Arm 2: each class of wrongness is actually detected. A meta-model that
    // is wrong (not a baseline that is stale) trips the guard.

    // (a) A policy dimension projected wrongly — the contract would claim the
    //     action emits no evidence while the server tells clients it does.
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

    // (b) An entry bound to the WRONG action's input schema (a swap inside one
    //     tool — the failure mode a registry-vs-registry diff cannot see).
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

    // (c) An input field the real (strict) wire schema would reject — a client
    //     that followed the compiled contract would be refused by the server.
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
    // The signature the contract would publish also stops matching the one the
    // running server publishes, so the divergence shows on two axes.
    expect(kindsOf(invented)).toContain('wire-signature-divergence');
    expect(invented.every((f) => f.provenance === 'runtime-differential')).toBe(true);

    // (d) An action name the wire discriminator does not accept.
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

    // (e) An action the runtime advertises but the contract omits entirely.
    const orphan = live.actions[0]!;
    const dropped = auditMetaModel({ ...live, actions: live.actions.slice(1) }, surface);
    expect(kindsOf(dropped)).toContain('wire-action-unmodelled');
    expect(dropped.some((f) => f.actionId === orphan.actionId)).toBe(true);
    // Every field only that action declared is now unmodelled too — the
    // coverage direction reports the omission from both sides.
    const orphanOnly = propertiesOf(orphan).filter(
      (p) => !live.actions.slice(1).some((e) => e.tool === orphan.tool && propertiesOf(e).includes(p)),
    );
    for (const property of orphanOnly) {
      expect(dropped.some((f) => f.field === `inputSchema.properties.${property}`)).toBe(true);
    }

    // (f) A dimension with no independent runtime consumer still has a
    //     hand-authored invariant behind it (weaker, and labelled as such).
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

    // Every seeded wrongness produced findings; none of them needed the
    // baseline artifact to exist, let alone to be fresh.
    for (const seeded of [droppedEvidence, swapped, invented, renamed, dropped, incoherent]) {
      expect(seeded.length).toBeGreaterThan(0);
    }
  });

  it('ContractCompiler_StaleBaselineOnly_RemainsDistinguishable', async () => {
    const surface = await observeRuntimeSurface();
    const sound = deriveMetaModel();
    const soundFindings = auditMetaModel(sound, surface);
    expect(soundFindings).toEqual([]);

    // A wrong meta-model that still COMPILES cleanly — so the only thing that
    // can tell it apart from a stale artifact is the runtime differential.
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

    // ── Condition 1: a merely STALE (here: hand-edited) baseline artifact.
    // The model is sound; only the checked-in bytes are out of date.
    const onDisk = fs.readFileSync(PROOF_FIXTURES_FILE, 'utf8');
    const freshFromSound = freshFrom(sound);
    expect(onDisk).toBe(freshFromSound); // the shipped tree is in sync
    const handEdited = onDisk.replace('"contractDigest"', '"contractDigestX"');
    expect(handEdited).not.toBe(freshFromSound);

    const staleOnly = classifyContractDrift({
      findings: soundFindings,
      baselineMatchesFreshCompile: handEdited === freshFromSound,
    });
    expect(staleOnly.kinds).toEqual(['stale-baseline']);
    expect(staleOnly.remedies).toEqual([REGENERATE_BASELINE_REMEDY]);
    expect(staleOnly.report).toContain('regenerate');

    // ── Condition 2: a WRONG meta-model whose baseline was just regenerated
    // FROM it. Regeneration launders a stale artifact; it cannot launder a
    // wrong model — the baseline signal is green and the guard is still red.
    const regeneratedFromWrong = freshFrom(wrong);
    expect(regeneratedFromWrong).toBe(freshFrom(wrong)); // regeneration is stable
    expect(regeneratedFromWrong).not.toBe(freshFromSound);

    const wrongOnly = classifyContractDrift({
      findings: wrongFindings,
      baselineMatchesFreshCompile: regeneratedFromWrong === freshFrom(wrong),
    });
    expect(wrongOnly.baselineMatchesFreshCompile).toBe(true);
    expect(wrongOnly.kinds).toEqual(['wrong-meta-model']);
    expect(wrongOnly.remedies).toEqual([FIX_META_MODEL_REMEDY]);
    expect(wrongOnly.report).toContain('Regenerating the baseline will NOT clear this');

    // ── The two conditions are separable, not one indistinguishable failure.
    expect(staleOnly.kinds).not.toEqual(wrongOnly.kinds);
    expect(staleOnly.remedies[0]).not.toBe(wrongOnly.remedies[0]);

    // ── And they compose: both conditions at once enumerate both, separately.
    const both = classifyContractDrift({
      findings: wrongFindings,
      baselineMatchesFreshCompile: false,
    });
    expect([...both.kinds].sort()).toEqual(['stale-baseline', 'wrong-meta-model']);
    expect(both.remedies).toHaveLength(2);
    expect(new Set(both.remedies).size).toBe(2);

    // ── The shipped tree is clean on BOTH axes.
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
