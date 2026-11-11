// These tests compare one feature wave of `prepare` with a golden. A scratch capture wrote the golden
// once, before the compile path became generic over the registered definitions. No test writes it.
//
// Each case seeds the inputs that the golden holds and runs `prepare` on the live code. The capsule,
// its claim key, the definition in custody and the data of the prepared row must not move.
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

import { capsuleDigest } from '../../../../src/contract/capsule/capsule-digest.js';
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
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import type { ScopeGit } from '../../../../src/verbs/prepare/prepare-scope.js';
import {
  commitPreparedCapsule,
  findPreparedCapsule,
} from '../../../../src/verbs/prepare/prepared-record.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
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

/** Seeds the stream, prepares it once, and reads the prepared row and the bundle definition back from custody. */
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
  return { receipt: recordAt(result.data, 'receipt'), prepared, definition: found.definition };
}

describe('the golden of one feature wave of prepare', () => {
  /** The capsule that the call returns is the golden capsule, byte for byte in canonical JSON. */
  it('PrepareGolden_AFeatureWave_CompilesTheGoldenCapsule', async () => {
    const { receipt } = await capture();
    expect(canonicalJson(receipt.capsule)).toBe(canonicalJson(GOLDEN.capsule));
  });

  /** The claim key and the three digests of the call are the golden values. */
  it('PrepareGolden_AFeatureWave_RecordsTheGoldenClaimKey', async () => {
    const { receipt, prepared } = await capture();
    expect(receipt.operationId).toBe(textAt(GOLDEN.operationId, 'operationId'));
    expect(prepared.operationId).toBe(textAt(GOLDEN.operationId, 'operationId'));
    expect(prepared.requestDigest).toBe(textAt(GOLDEN.requestDigest, 'requestDigest'));
    expect(receipt.capsuleDigest).toBe(textAt(GOLDEN.capsuleDigest, 'capsuleDigest'));
    expect(receipt.definitionVersion).toBe(textAt(GOLDEN.definitionVersion, 'definitionVersion'));
  });

  /** The definition in custody and the data of the prepared row are the golden values, byte for byte in canonical JSON. */
  it('PrepareGolden_AFeatureWave_PinsTheGoldenDefinition', async () => {
    const { prepared, definition } = await capture();
    expect(canonicalJson(definition)).toBe(canonicalJson(GOLDEN.definition));
    expect(canonicalJson(prepared)).toBe(canonicalJson(GOLDEN.prepared));
  });

  /**
   * The golden capsule, committed under the golden key, answers a retry. The call returns the recorded receipt and compiles nothing.
   * So the stream holds one prepared row.
   */
  it('PrepareGolden_AClaimThatTheBaseRecorded_AnswersARetry', async () => {
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
    expect(retry.data).toEqual(recorded);
    expect(await preparedRows()).toHaveLength(1);
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
