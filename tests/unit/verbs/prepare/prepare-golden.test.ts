// These tests compare one feature wave of `prepare` with a golden. A scratch capture wrote the golden
// once, before the compile path became generic over the registered definitions. No test writes it.
//
// Each case seeds the inputs that the golden holds and runs `prepare` on the live code. The live wave differs
// from the golden at the named paths of the full definition pin, compiler name and frozen skips.
// A recapture runs on main only, never on a feature branch.
//
// The capture uses a fake git at a fixed absent checkout, a fixed clock and a fixed catalog.
// So the golden holds no path that the platform builds.
//
// @oracle-sources: ./__fixtures__/feature-wave.prepare.golden.json, ../../../../src/verbs/prepare/handler.ts

import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capsuleDigest, contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { canonicalJson } from '../../../../src/contract/request-context.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { WorkflowPreparedData, type WorkflowPrepared } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import type { CatalogInvariant } from '../../../../src/verbs/prepare/bind-authority.js';
import { PREPARE_COMPILER_VERSION } from '../../../../src/verbs/prepare/compile-capsule.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import type { ScopeGit } from '../../../../src/verbs/prepare/prepare-scope.js';
import {
  commitPreparedCapsule,
  findPreparedCapsule,
} from '../../../../src/verbs/prepare/prepared-record.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { builtInDefinition } from '../../../../src/workflow/definitions/built-in.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The golden file that the scratch capture wrote once. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  './__fixtures__/feature-wave.prepare.golden.json',
);

/** The text of the golden file. Each case reads it at module load, so a missing golden fails each case. */
const GOLDEN_TEXT = fs.readFileSync(GOLDEN_PATH, 'utf8');

/** The prefix of each temporary state directory. The capture used the same prefix, and the golden must not hold it. */
const STATE_PREFIX = 'prepare-golden-state-';

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Returns the value as a list, or throws with its path. */
function listAt(value: unknown, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} is not a list`);
  return value;
}

/** Returns the value as a string, or throws with its path. */
function textAt(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  return value;
}

/** The parsed golden. */
const GOLDEN = recordAt(JSON.parse(GOLDEN_TEXT), 'golden');

/** The inputs of the capture, as the golden holds them. */
const INPUTS = recordAt(GOLDEN.inputs, 'inputs');

const STREAM = textAt(INPUTS.streamId, 'inputs.streamId');
const WORKFLOW_TYPE = textAt(INPUTS.workflowType, 'inputs.workflowType');
const REPO_ROOT = textAt(INPUTS.repoRoot, 'inputs.repoRoot');
const REPOSITORY = textAt(INPUTS.repository, 'inputs.repository');
const BASE_COMMIT = textAt(INPUTS.baseCommit, 'inputs.baseCommit');
const COMPILED_AT = textAt(INPUTS.compiledAt, 'inputs.compiledAt');

/** The catalog of the capture, by id and summary. */
const CATALOG: readonly CatalogInvariant[] = listAt(INPUTS.catalog, 'inputs.catalog').map((entry, index) => {
  const invariant = recordAt(entry, `inputs.catalog.${index}`);
  return {
    id: textAt(invariant.id, `inputs.catalog.${index}.id`),
    summary: textAt(invariant.summary, `inputs.catalog.${index}.summary`),
  };
});

/**
 * The paths at which a live wave differs from the golden. The pin of the full definition moves the digests,
 * the claim key and the bundle reference, and the definition gains the `exarchos` key. The compiler name moves twice.
 */
const NAMED_DELTA: readonly string[] = [
  '.capsule.identity.definitionVersion',
  '.capsule.provenance.compilerVersion',
  '.capsule.provenance.sources[0].digest',
  '.capsule.settlementContract',
  '.capsuleDigest',
  '.definition',
  '.definitionVersion',
  '.operationId',
  '.prepared.bundleRefs[0].digest.value',
  '.prepared.capsuleDigest',
  '.prepared.compilerVersion',
  '.prepared.definitionVersion',
  '.prepared.operationId',
  '.prepared.requestDigest',
  '.requestDigest',
];

/**
 * Returns each path at which two JSON values differ, sorted.
 * A record whose key set differs gives its own path, and the walk also goes into the keys that both sides hold.
 * A list whose length differs gives its own path. Each other leaf that differs gives its path.
 */
function differingPaths(left: unknown, right: unknown, at = ''): string[] {
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    const shared = leftKeys.filter((key) => key in right);
    const own = shared.length === leftKeys.length && shared.length === rightKeys.length ? [] : [at];
    return [...own, ...shared.flatMap((key) => differingPaths(left[key], right[key], `${at}.${key}`))].sort();
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [at];
    return left.flatMap((item, index) => differingPaths(item, right[index], `${at}[${index}]`)).sort();
  }
  return canonicalJson(left) === canonicalJson(right) ? [] : [at];
}

/** The golden without its inputs: the part that one live capture gives. */
function goldenWave(): Record<string, unknown> {
  const { inputs: _inputs, ...wave } = GOLDEN;
  return wave;
}

/** The capabilities of the calling runtime of the capture. */
const CAPABILITIES: readonly string[] = listAt(INPUTS.capabilities, 'inputs.capabilities').map((entry, index) =>
  textAt(entry, `inputs.capabilities.${index}`),
);

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), STATE_PREFIX));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** The three git reads of the scope. The repository is the fixed absent checkout, and the base resolves to the fixed commit. */
function scopeGit(): ScopeGit {
  return {
    observe: async () => ({ kind: 'repository', toplevel: REPO_ROOT, repository: REPOSITORY }),
    commitOf: async (_checkout, ref) =>
      ref.startsWith('refs/tags/') ? { kind: 'absent' } : { kind: 'commit', commit: BASE_COMMIT },
    isAncestor: async () => ({ kind: 'ancestor' }),
  };
}

/** The wiring of each call. */
function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** The dispatch context of the calling runtime, with the capabilities of the capture. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: textAt(INPUTS.sessionId, 'inputs.sessionId') });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/**
 * Seeds the feature stream of the capture in its phase, with the artifacts, the integration branch and the plan of the golden.
 * It returns the sequence of the last seeded row.
 */
async function seed(): Promise<number> {
  const artifacts = recordAt(INPUTS.artifacts, 'inputs.artifacts');
  await store.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: WORKFLOW_TYPE } });
  await store.append(STREAM, {
    type: 'workflow.transition',
    data: { from: textAt(INPUTS.fromPhase, 'inputs.fromPhase'), to: textAt(INPUTS.phase, 'inputs.phase') },
  });
  await store.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        ...Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [`artifacts.${key}`, value])),
        'synthesis.integrationBranch': textAt(INPUTS.integrationBranch, 'inputs.integrationBranch'),
        tasks: listAt(INPUTS.plan, 'inputs.plan'),
      },
    },
  });
  const rows = await store.query(STREAM);
  return rows[rows.length - 1]?.sequence ?? 0;
}

/** One `prepare` call of the seeded stream, with the seams of the capture. */
async function prepareOnce(): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handlePrepare({ featureId: STREAM, repoRoot: REPO_ROOT }, stateDir, wiring(), {
      catalogInvariants: () => CATALOG,
      now: () => COMPILED_AT,
      scopeGit: scopeGit(),
    }),
  );
}

/** The data of each `workflow.prepared` row of the stream, each parsed through the row schema. */
async function preparedRows(): Promise<WorkflowPrepared[]> {
  const rows = await store.query(STREAM);
  return rows.filter((row) => row.type === 'workflow.prepared').map((row) => WorkflowPreparedData.parse(row.data));
}

/** What one capture gives: the receipt data of the call, the data of its one prepared row, and the definition in custody. */
interface Capture {
  readonly receipt: Record<string, unknown>;
  readonly prepared: WorkflowPrepared;
  readonly definition: unknown;
}

/**
 * Seeds the stream, prepares it once, and reads the prepared row and the bundle definition back from custody.
 * It asserts that the live wave differs from the golden at exactly the named paths.
 */
async function capture(): Promise<Capture> {
  await seed();
  const result = await prepareOnce();
  expect(result.success, JSON.stringify(result.error)).toBe(true);
  const rows = await preparedRows();
  expect(rows).toHaveLength(1);
  const [prepared] = rows;
  if (prepared === undefined) throw new Error('the call recorded no prepared row');
  const found = await findPreparedCapsule(wiring(), STREAM, prepared.capsuleVersion);
  if (!found.found) throw new Error('the prepared capsule is not in custody');
  const receipt = recordAt(result.data, 'receipt');
  const live = {
    operationId: receipt.operationId,
    requestDigest: prepared.requestDigest,
    capsuleDigest: receipt.capsuleDigest,
    definitionVersion: receipt.definitionVersion,
    capsule: receipt.capsule,
    definition: found.definition,
    prepared,
  };
  expect(differingPaths(JSON.parse(canonicalJson(live)), goldenWave())).toStrictEqual([...NAMED_DELTA].sort());
  return { receipt, prepared, definition: found.definition };
}

/** The definition without its `exarchos` key. */
function kernelPart(definition: unknown): Record<string, unknown> {
  const { exarchos: _extension, ...kernel } = recordAt(definition, 'definition');
  return kernel;
}

describe('the golden of one feature wave of prepare', () => {
  /**
   * The capsule that the call returns differs from the golden capsule at the named paths.
   * The capsule names the compiler of this build and the pinned digest of the full definition.
   */
  it('PrepareGolden_AFeatureWave_CompilesTheGoldenCapsule', async () => {
    const { receipt } = await capture();
    expect(differingPaths(JSON.parse(canonicalJson(receipt.capsule)), GOLDEN.capsule, '.capsule')).toStrictEqual(
      NAMED_DELTA.filter((at) => at.startsWith('.capsule.')),
    );
    const capsule = ExarchosCapsuleV1Schema.parse(receipt.capsule);
    expect(capsule.provenance.compilerVersion).toBe(PREPARE_COMPILER_VERSION);
    expect(capsule.settlementContract.skipPhases).toStrictEqual([]);
    await expect(preparedRows().then(([row]) => row?.planRecordDigest)).resolves.toBeUndefined();
    expect(capsule.identity.definitionVersion).toBe(receipt.definitionVersion);
    expect(capsule.provenance.sources[0]).toStrictEqual({ sourceId: 'workflow-definition', digest: receipt.definitionVersion });
  });

  /** The claim key and the three digests of the call move from the golden values, and the row and the receipt agree on each. */
  it('PrepareGolden_AFeatureWave_RecordsTheGoldenClaimKey', async () => {
    const { receipt, prepared } = await capture();
    expect(receipt.operationId).not.toBe(textAt(GOLDEN.operationId, 'operationId'));
    expect(prepared.operationId).toBe(receipt.operationId);
    expect(prepared.requestDigest).toBe(`sha256:${textAt(receipt.operationId, 'operationId').slice('prepare:'.length)}`);
    expect(receipt.capsuleDigest).toBe(capsuleDigest(ExarchosCapsuleV1Schema.parse(receipt.capsule)));
    expect(receipt.definitionVersion).not.toBe(textAt(GOLDEN.definitionVersion, 'definitionVersion'));
  });

  /**
   * The definition in custody is the golden kernel with the `exarchos` extension of the feature definition.
   * The prepared row names the digest of that full definition.
   */
  it('PrepareGolden_AFeatureWave_PinsTheGoldenDefinition', async () => {
    const { prepared, definition } = await capture();
    expect(canonicalJson(kernelPart(definition))).toBe(canonicalJson(GOLDEN.definition));
    expect(recordAt(definition, 'definition').exarchos).toStrictEqual(builtInDefinition('feature').exarchos);
    expect(prepared.definitionVersion).toBe(contentDigest(definition));
    expect(prepared.compilerVersion).toBe(PREPARE_COMPILER_VERSION);
  });

  /**
   * The golden capsule of the earlier compiler, committed under the golden key, does not answer a retry of this build.
   * The claim key holds the compiler name and the definition digest, so the retry compiles capsule version 2 under a new key.
   */
  it('PrepareGolden_AFiveClaim_DoesNotAnswerASixRetry', async () => {
    const tail = await seed();
    const capsule = ExarchosCapsuleV1Schema.parse(GOLDEN.capsule);
    const definition = WorkflowDefinitionV1Schema.parse(GOLDEN.definition);
    expect(capsuleDigest(capsule)).toBe(textAt(GOLDEN.capsuleDigest, 'capsuleDigest'));

    const recorded = await runWithDispatchContext(correlation(), () =>
      commitPreparedCapsule(wiring(), {
        streamId: STREAM,
        operationId: textAt(GOLDEN.operationId, 'operationId'),
        requestDigest: textAt(GOLDEN.requestDigest, 'requestDigest'),
        workflowType: WORKFLOW_TYPE,
        capsule,
        definition,
        expectedSequence: tail,
        announce: capsule.graph.tasks.map((task) => ({ taskId: task.taskId, title: task.title })),
      }),
    );

    const retry = await prepareOnce();
    expect(retry.success, JSON.stringify(retry.error)).toBe(true);
    const receipt = recordAt(retry.data, 'receipt');
    expect(receipt.operationId).not.toBe(recorded.operationId);
    expect(receipt.capsuleVersion).toBe(2);
    expect((await preparedRows()).map((row) => [row.capsuleVersion, row.compilerVersion])).toStrictEqual([
      [1, 'exarchos-prepare-5'],
      [2, PREPARE_COMPILER_VERSION],
    ]);
  });

  /**
   * The golden holds no path of a temporary directory. Each absolute path in it is the fixed checkout or a path under it.
   * The capsule of a live capture holds no path of its own state directory.
   */
  it('PrepareGolden_TheGolden_HoldsNoTemporaryPath', async () => {
    const temporary = tmpdir();
    expect(GOLDEN_TEXT).not.toContain(STATE_PREFIX);
    expect(GOLDEN_TEXT).not.toContain(temporary);
    expect(GOLDEN_TEXT).not.toContain(JSON.stringify(temporary).slice(1, -1));

    const absolute: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(value)) absolute.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (isRecord(value)) Object.values(value).forEach(collect);
    };
    collect(GOLDEN);
    expect(absolute.length).toBeGreaterThanOrEqual(4);
    expect(absolute.filter((value) => value !== REPO_ROOT && !value.startsWith(`${REPO_ROOT}/`))).toEqual([]);

    const { receipt } = await capture();
    const live = canonicalJson(receipt.capsule);
    expect(live).not.toContain(stateDir);
    expect(live).not.toContain(JSON.stringify(stateDir).slice(1, -1));
  });
});
