import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ADMISSION_EVENT_TYPES } from '../../workflow/admission/types.js';
import { BUILTIN_GATE_PROVIDER_REGISTRY } from './gate-provider-registry.js';
import {
  CANONICAL_EVIDENCE_EMITTER_MODULE,
  auditEvidenceOwnership,
  collectEnforceableGates,
  runOwnershipCensus,
  scanEvidenceEmitterSites,
  sourceEmitsEvidence,
  witnessRunnerDurability,
  type OwnershipCensusModel,
} from './gate-ownership-census.js';

const EVIDENCE_TYPE = ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED;
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    expect(sourceEmitsEvidence(source)).toBe(true);
  });

  it('does not flag a query filter that references the evidence type', () => {
    const source = `
      async function reader(store, streamId) {
        return store.query(streamId, { type: '${EVIDENCE_TYPE}' });
      }`;
    expect(sourceEmitsEvidence(source)).toBe(false);
  });

  it('does not flag auto-emission metadata declarations', () => {
    const source = `
      const meta = {
        autoEmits: [{ event: '${EVIDENCE_TYPE}', condition: 'always' }],
      };`;
    expect(sourceEmitsEvidence(source)).toBe(false);
  });
});

describe('real evidence emitter scan', () => {
  it('finds exactly the canonical durable runner as the sole emitter', async () => {
    const sites = await scanEvidenceEmitterSites(SRC_ROOT);

    expect(sites.map((site) => site.module)).toEqual([
      CANONICAL_EVIDENCE_EMITTER_MODULE,
    ]);
    expect(sites.every((site) => site.canonical)).toBe(true);
  });

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

      const sites = await scanEvidenceEmitterSites(root);
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
      await rm(root, { recursive: true, force: true });
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
    const result = await auditEvidenceOwnership(SRC_ROOT);
    expect(result).toEqual({ ok: true, diagnostics: [] });
  });
});
