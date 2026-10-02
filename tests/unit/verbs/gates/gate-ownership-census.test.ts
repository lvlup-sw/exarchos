import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanEvidenceEmission } from '../../../../tools/test-helpers/evidence-emission-scanner.js';
import { ADMISSION_EVENT_TYPES } from '../../../../src/workflow/admission/types.js';
import { BUILTIN_GATE_PROVIDER_REGISTRY } from '../../../../src/verbs/gates/gate-provider-registry.js';
import {
  ACKNOWLEDGED_UNRESOLVED_MODULES,
  CANONICAL_EVIDENCE_EMITTER_MODULE,
  auditEvidenceOwnership,
  collectEnforceableGates,
  runOwnershipCensus,
  scanEvidenceEmitterSites,
  scanEvidenceEmitters,
  sourceEmitsEvidence,
  witnessRunnerDurability,
  type OwnershipCensusModel,
} from '../../../../src/verbs/gates/gate-ownership-census.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const EVIDENCE_TYPE = ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED;
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../src');

/** The census's own scanner, so these tests exercise the shipped resolution. */
const emits = (source: string): boolean =>
  sourceEmitsEvidence(source, scanEvidenceEmission);

const greenModel = (
  overrides: Partial<OwnershipCensusModel> = {},
): OwnershipCensusModel => ({
  emitterSites: [{ module: CANONICAL_EVIDENCE_EMITTER_MODULE, canonical: true }],
  enforceableGates: [
    { gateClass: 'test-adequacy', actionName: 'check_test_adequacy' },
  ],
  registry: BUILTIN_GATE_PROVIDER_REGISTRY,
  durability: {
    failsClosedOnAppendFailure: true,
    successCarriesDurableEvidence: true,
  },
  ...overrides,
});

describe('ownership census verdict', () => {
  it('OwnershipCensus_CanonicalModel_Passes', () => {
    const result = runOwnershipCensus(greenModel());
    expect(result).toEqual({ ok: true, diagnostics: [] });
  });

  it('OwnershipCensus_AlternateEmitter_FailsClosed', () => {
    const result = runOwnershipCensus(
      greenModel({
        emitterSites: [
          { module: CANONICAL_EVIDENCE_EMITTER_MODULE, canonical: true },
          { module: 'verbs/rogue-emitter.ts', canonical: false },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'ALTERNATE_EVIDENCE_EMITTER',
        module: 'verbs/rogue-emitter.ts',
      }),
    );
  });

  it('OwnershipCensus_UnregisteredProvider_FailsClosed', () => {
    const result = runOwnershipCensus(
      greenModel({
        enforceableGates: [
          { gateClass: 'test-adequacy', actionName: 'check_test_adequacy' },
          { gateClass: 'ghost-gate', actionName: 'check_ghost' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'UNREGISTERED_GATE_PROVIDER',
        gateClass: 'ghost-gate',
        actionName: 'check_ghost',
      }),
    );
  });

  it('OwnershipCensus_SuccessWithoutAppend_FailsClosed', () => {
    const result = runOwnershipCensus(
      greenModel({
        durability: {
          failsClosedOnAppendFailure: false,
          successCarriesDurableEvidence: true,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'SUCCESS_WITHOUT_DURABLE_EVIDENCE' }),
    );
  });

  it('OwnershipCensus_SuccessWithoutEvidenceReference_FailsClosed', () => {
    const result = runOwnershipCensus(
      greenModel({
        durability: {
          failsClosedOnAppendFailure: true,
          successCarriesDurableEvidence: false,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'SUCCESS_WITHOUT_DURABLE_EVIDENCE' }),
    );
  });
});

/**
 * The `EmissionDetector_*_IsAnEmitter` cases write the evidence append in the forms that this codebase uses.
 * A raw-literal match on the `type` value does not see these forms, so the census must resolve the discriminant.
 */
describe('evidence emission detection', () => {
  it('flags a direct append of an admission-evidence event', () => {
    const source = `
      async function rogue(store, streamId, record) {
        await store.append(streamId, {
          type: '${EVIDENCE_TYPE}',
          source: 'rogue',
          data: record,
        });
      }`;
    expect(emits(source)).toBe(true);
  });

  it('does not flag a query filter that references the evidence type', () => {
    const source = `
      async function reader(store, streamId) {
        return store.query(streamId, { type: '${EVIDENCE_TYPE}' });
      }`;
    expect(emits(source)).toBe(false);
  });

  it('does not flag auto-emission metadata declarations', () => {
    const source = `
      const meta = {
        autoEmits: [{ event: '${EVIDENCE_TYPE}', condition: 'always' }],
      };`;
    expect(emits(source)).toBe(false);
  });

  /** The source does not contain the evidence type string, so only a resolved discriminant can detect it. */
  it('EmissionDetector_AppendViaExportedConstant_IsAnEmitter', () => {
    const source = `
      import { ADMISSION_EVENT_TYPES } from '../workflow/admission/types.js';
      async function rogue(store, streamId, record) {
        await store.append(streamId, {
          type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
          data: record,
        });
      }`;
    expect(emits(source)).toBe(true);
    expect(source).not.toContain(EVIDENCE_TYPE);
  });

  it('EmissionDetector_AppendViaAliasedConstantImport_IsAnEmitter', () => {
    const source = `
      import { ADMISSION_EVENT_TYPES as Events } from '../workflow/admission/types.js';
      async function rogue(store, streamId, record) {
        await store.append(streamId, { type: Events.EVIDENCE_RECORDED, data: record });
      }`;
    expect(emits(source)).toBe(true);
  });

  it('EmissionDetector_AppendOfHoistedEventObject_IsAnEmitter', () => {
    const source = `
      import { ADMISSION_EVENT_TYPES } from '../workflow/admission/types.js';
      async function rogue(store, streamId, record) {
        const event = {
          type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
          data: record,
        };
        await store.append(streamId, event);
      }`;
    expect(emits(source)).toBe(true);
  });

  it('EmissionDetector_AppendViaLocalDiscriminantBinding_IsAnEmitter', () => {
    const source = `
      const EVIDENCE = '${EVIDENCE_TYPE}';
      async function rogue(store, streamId, record) {
        await store.append(streamId, { type: EVIDENCE, data: record });
      }`;
    expect(emits(source)).toBe(true);
  });

  /** A different member of the same constant table must not count as evidence. */
  it('EmissionDetector_ConstantSiblingMember_IsNotAnEmitter', () => {
    const source = `
      import { ADMISSION_EVENT_TYPES } from '../workflow/admission/types.js';
      async function waiver(store, streamId, record) {
        await store.append(streamId, {
          type: ADMISSION_EVENT_TYPES.WAIVER_RECORDED,
          data: record,
        });
      }`;
    expect(emits(source)).toBe(false);
  });

  it('EmissionDetector_EvidenceTypeInsideAComment_IsNotAnEmitter', () => {
    const source = `
      async function benign(store, streamId, record) {
        // Mentions type: '${EVIDENCE_TYPE}' in prose only.
        await store.append(streamId, { type: 'workflow.noted', data: record });
      }`;
    expect(emits(source)).toBe(false);
  });

  /**
   * A partial parse drops nodes, and a dropped append reads as a module that emits nothing.
   * Thus a parse with recovery is fatal.
   */
  it('EmissionDetector_RecoveredParse_ThrowsRatherThanReadingAsClean', () => {
    expect(() => emits('function broken( {')).toThrow(/did not parse cleanly/);
  });
});

describe('unresolvable discriminants are reported, not assumed benign', () => {
  const unreadable = `
    async function relay(store, streamId, type, data) {
      await store.append(streamId, { type, data });
    }`;

  it('UnresolvedDiscriminant_UnacknowledgedModule_FailsClosed', () => {
    const sites = scanEvidenceEmission(unreadable, {
      knownConstants: new Map(),
      fileName: 'rogue-relay.ts',
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]?.discriminant).toBeUndefined();

    const result = runOwnershipCensus(
      greenModel({
        unresolvedDiscriminants: [{ module: 'rogue-relay.ts', line: 3 }],
        acknowledgedUnresolvedModules: new Set(),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'UNRESOLVED_EVIDENCE_DISCRIMINANT',
        module: 'rogue-relay.ts',
      }),
    );
  });

  it('UnresolvedDiscriminant_AcknowledgedModule_IsAccepted', () => {
    const result = runOwnershipCensus(
      greenModel({
        unresolvedDiscriminants: [{ module: 'known-relay.ts', line: 3 }],
        acknowledgedUnresolvedModules: new Set(['known-relay.ts']),
      }),
    );
    expect(result).toEqual({ ok: true, diagnostics: [] });
  });

  it('UnresolvedAcknowledgement_CoveringNothing_IsStale', () => {
    const result = runOwnershipCensus(
      greenModel({
        unresolvedDiscriminants: [],
        acknowledgedUnresolvedModules: new Set(['repaired-relay.ts']),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'STALE_UNRESOLVED_ACKNOWLEDGEMENT',
        module: 'repaired-relay.ts',
      }),
    );
  });

  /** The check works in both directions: each acknowledged module still has an unreadable append, and no other module has one. */
  it('AcknowledgementSet_MatchesTheLiveTreeExactly', async () => {
    const { unresolvedDiscriminants } = await scanEvidenceEmitters(
      SRC_ROOT,
      scanEvidenceEmission,
    );
    const live = new Set(unresolvedDiscriminants.map((site) => site.module));
    expect([...live].sort()).toEqual([...ACKNOWLEDGED_UNRESOLVED_MODULES].sort());
  }, 60_000);
});

describe('discriminant precedence follows source order', () => {
  const discriminantOf = (objectLiteral: string): string | undefined => {
    const sites = scanEvidenceEmission(
      `async function emit(store, streamId) {
         await store.append(streamId, ${objectLiteral});
       }`,
      { knownConstants: new Map(), fileName: 'precedence-probe.ts' },
    );
    expect(sites).toHaveLength(1);
    return sites[0]?.discriminant;
  };

  /**
   * JavaScript evaluates `{ type: 'old', ...{ type: 'new' } }` to `'new'`.
   * A wrong answer here lets a rogue emitter pass the census under another name.
   */
  it('Discriminant_SpreadAfterOwnProperty_TakesTheSpread', () => {
    expect(discriminantOf("{ type: 'old', ...{ type: 'new' } }")).toBe('new');
  });

  it('Discriminant_SecondSpreadWins_NotTheFirst', () => {
    expect(discriminantOf("{ ...{ type: 'first' }, ...{ type: 'second' } }")).toBe(
      'second',
    );
  });

  it('Discriminant_OwnPropertyAfterSpread_StillWins', () => {
    expect(discriminantOf("{ ...{ type: 'base' }, type: 'override' }")).toBe('override');
  });

  it('Discriminant_SpreadWithoutTheKey_LeavesStandingValue', () => {
    expect(discriminantOf("{ type: 'keep', ...{ data: 1 } }")).toBe('keep');
  });

  /** The call can overwrite `type`, and static analysis cannot tell. Thus the census does not return the earlier value as certain. */
  it('Discriminant_UnreadableSpreadAfterOwn_IsUnresolved', () => {
    expect(discriminantOf("{ type: 'maybe-stale', ...makeBase() }")).toBeUndefined();
  });
});

describe('real evidence emitter scan', () => {
  it('finds exactly the canonical durable runner as the sole emitter', async () => {
    const sites = await scanEvidenceEmitterSites(SRC_ROOT, scanEvidenceEmission);

    expect(sites.map((site) => site.module)).toEqual([
      CANONICAL_EVIDENCE_EMITTER_MODULE,
    ]);
    expect(sites.every((site) => site.canonical)).toBe(true);
  }, 60_000);

  it('detects a planted alternate emitter under a scanned root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exarchos-census-scan-'));
    try {
      await writeFile(
        join(root, 'rogue-emitter.ts'),
        `export async function rogue(store, streamId, record) {\n` +
          `  await store.append(streamId, { type: '${EVIDENCE_TYPE}', data: record });\n` +
          `}\n`,
        'utf8',
      );
      await writeFile(
        join(root, 'benign-reader.ts'),
        `export async function read(store, streamId) {\n` +
          `  return store.query(streamId, { type: '${EVIDENCE_TYPE}' });\n` +
          `}\n`,
        'utf8',
      );

      const sites = await scanEvidenceEmitterSites(root, scanEvidenceEmission);
      expect(sites).toEqual([
        { module: 'rogue-emitter.ts', canonical: false },
      ]);

      const result = runOwnershipCensus(greenModel({ emitterSites: sites }));
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'ALTERNATE_EVIDENCE_EMITTER',
          module: 'rogue-emitter.ts',
        }),
      );
    } finally {
      await rmrfAsync(root);
    }
  });

  /** Runs the real tree walk over a rogue emitter on disk, written the way the admission consumers in this package write one. */
  it('EmitterScan_IdiomaticRogueEmitterPlantedOnDisk_IsCaught', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exarchos-census-idiom-'));
    try {
      await writeFile(
        join(root, 'idiomatic-rogue.ts'),
        `import { ADMISSION_EVENT_TYPES } from './types.js';\n` +
          `export async function rogue(store, streamId, record) {\n` +
          `  const event = { type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED, data: record };\n` +
          `  await store.append(streamId, event);\n` +
          `}\n`,
        'utf8',
      );

      const sites = await scanEvidenceEmitterSites(root, scanEvidenceEmission);
      expect(sites).toEqual([{ module: 'idiomatic-rogue.ts', canonical: false }]);

      const result = runOwnershipCensus(greenModel({ emitterSites: sites }));
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'ALTERNATE_EVIDENCE_EMITTER',
          module: 'idiomatic-rogue.ts',
        }),
      );
    } finally {
      await rmrfAsync(root);
    }
  });
});

describe('real enforceable gate coverage', () => {
  it('resolves every enforceable orchestrate gate through the single registry', () => {
    const gates = collectEnforceableGates();
    expect(gates.length).toBeGreaterThanOrEqual(9);

    for (const gate of gates) {
      const resolution = BUILTIN_GATE_PROVIDER_REGISTRY.resolve(gate.gateClass);
      expect(resolution.success, gate.gateClass).toBe(true);
    }
  });
});

describe('durable runner witness', () => {
  it('confirms success is gated on a persisted evidence append', async () => {
    const witness = await witnessRunnerDurability();
    expect(witness).toEqual({
      failsClosedOnAppendFailure: true,
      successCarriesDurableEvidence: true,
    });
  });
});

describe('exit proof — canonical evidence production', () => {
  it('passes the ownership census against the live system', async () => {
    const result = await auditEvidenceOwnership(SRC_ROOT, scanEvidenceEmission);
    expect(result).toEqual({ ok: true, diagnostics: [] });
  }, 60_000);
});
