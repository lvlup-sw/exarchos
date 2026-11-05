/**
 * `settle` runs the kill probe under the terms that the capsule pins, through the real dispatcher and real git.
 *
 * Each call goes through `dispatch` with a real caller identity and capability resolver. Telemetry is at its shipped
 * default, and the observer of a claimed worktree is the shipped one. Each workflow is seeded as rows of the event store
 * only, so no case writes a state document. `prepare` pins the profile from the config of the checkout, and each test
 * runs under `node --test`. The static-analysis scripts each exit 0, so the probe alone decides.
 * Each case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 *
 * @oracle-sources: ../../src/verbs/gates/test-adequacy-handler.ts, the settle receipts of real calls, the gate evidence and its report artifact in the real event store, and a real `node --test` run in a real worktree
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { evidenceArtifactStore, resolveEvidenceArtifact } from '../../src/workflow/admission/evidence-artifact.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type FixtureFiles, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-kill-probe-profile-acceptance';
const INTEGRATION_BRANCH = 'feature/kill-probe-profile';
const TASK_ID = 'task-a';
/** The budget of one case. A case spawns git, prepares once and runs the gates of one task. */
const CASE_TIMEOUT_MS = 120_000 * WIN32_SPAWN_HEADROOM;

/** A real npm script: the cheapest process that exits 0. */
const OK = 'node -e ""';

/** A Node project whose static-analysis scripts each exit 0, and one source module at the base. */
const GREEN_PROJECT: FixtureFiles = {
  'package.json': JSON.stringify(
    { name: 'kill-probe-profile-fixture', version: '1.0.0', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } },
    null,
    2,
  ),
  'src/value.mjs': 'export const value = 1;\n',
};

/** The source change of the task. */
const CHANGED_SOURCE = 'export const value = 2;\n';

/** A test that fails when the revert takes the source change away. It imports the source from `source`, and it appends one line to `marker` on each run. */
function killingTest(source: string, marker: string): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "import assert from 'node:assert';",
    `import { value } from '${source}';`,
    '',
    "test('value is 2', () => {",
    `  appendFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
    '  assert.strictEqual(value, 2);',
    '});',
    '',
  ].join('\n');
}

/** The number of runs that a killing test recorded in `marker`. */
async function recordedRuns(marker: string): Promise<number> {
  return (await readFile(marker, 'utf-8')).split('\n').filter((line) => line.length > 0).length;
}

/** A config of the checkout with a glob that no seed holds, and a probe that takes the files as its arguments. */
const PINNED_CHECKS_CONFIG =
  "verification:\n  tests:\n    globs:\n      - 'checks/**/*.check.mjs'\n    probe:\n      command: node --test\n      files: as-arguments\n";

/** The config that the worktree writes in place of the pinned config. Under it, no changed file is a test. */
const EMPTIED_GLOBS_CONFIG = 'verification:\n  tests:\n    globs: []\n';

/** A config of the checkout whose probe takes no file list. */
const UNSCOPED_PROBE_CONFIG = 'verification:\n  tests:\n    probe:\n      command: node --test\n      files: none\n';

let stateDir: string;
let eventStore: EventStore;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'kill-probe-profile-acceptance-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** A scoped repository whose checkout commits `config` as its `.exarchos.yml`. */
async function repositoryWith(config: string): Promise<ScopedRepository> {
  const repository = await scopedRepository({
    integrationBranch: INTEGRATION_BRANCH,
    files: { ...GREEN_PROJECT, '.exarchos.yml': config },
  });
  scratchDirs.push(repository.root);
  return repository;
}

/** The dispatch context of an agent, as the composition root builds it, with telemetry at its shipped default. */
function agentContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'kill-probe-profile-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

async function call(action: string, args: Record<string, unknown>): Promise<unknown> {
  const result = CallResultSchema.parse(await dispatch('exarchos_orchestrate', { action, ...args }, agentContext()));
  expect(result.success, JSON.stringify(result)).toBe(true);
  return result.data;
}

/** The fields of a settle receipt that the cases read. */
const SettledView = z.object({
  outcome: z.string(),
  acceptedTasks: z.array(z.string()),
  verification: z.array(
    z.object({
      outcome: z.string(),
      qualifiers: z
        .array(
          z.object({
            gate: z.string(),
            mark: z.string(),
            advisorySkips: z.array(z.object({ name: z.string(), cause: z.string() })).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

type Settled = z.infer<typeof SettledView>;

/** Seeds one medium-tier task in `delegate`, prepares from the checkout, and settles a claim on the worktree of the task. */
async function settleTheTask(repository: ScopedRepository, taskFiles: FixtureFiles): Promise<{ readonly settled: Settled; readonly capsuleVersion: number }> {
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        tasks: [{ id: TASK_ID, title: TASK_ID, status: 'pending', blockedBy: [], riskTier: 'medium', boundaryTouching: false }],
      },
    },
  });
  const prepared = z
    .object({ capsuleVersion: z.number().int() })
    .parse(await call('prepare', { featureId: STREAM, repoRoot: repository.checkout }));
  const worktreePath = await repository.worktreeFor(TASK_ID, taskFiles);
  const settled = SettledView.parse(
    await call('settle', {
      featureId: STREAM,
      capsuleVersion: prepared.capsuleVersion,
      batchId: 'batch-kill-probe-profile',
      claims: [{ taskId: TASK_ID, fields: { worktreePath }, evidence: [] }],
    }),
  );
  return { settled, capsuleVersion: prepared.capsuleVersion };
}

/** The evidence record of the kill probe. */
const ProbeEvidenceView = z.object({
  evidence: z.object({
    requirementId: z.string(),
    verdict: z.string(),
    artifactRefs: z.array(z.unknown()),
  }),
});

/** The report that the run of the kill probe stored with its evidence. */
async function probeReport(): Promise<string> {
  const rows = await eventStore.query(STREAM, { type: 'admission.evidence-recorded' });
  const records = rows
    .map((row) => ProbeEvidenceView.safeParse(row.data))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((record) => record.evidence.requirementId === 'verification-ladder:test-adequacy');
  expect(records).toHaveLength(1);
  expect(records[0]?.evidence.verdict).toBe('pass');
  return String(await resolveEvidenceArtifact(evidenceArtifactStore(stateDir), records[0]?.evidence.artifactRefs[0]));
}

describe('settle runs the kill probe under the pinned terms', () => {
  /**
   * The worktree empties its test globs, and the pin holds. The probe classifies with the glob of the checkout, runs the check file, and sees the kill.
   * The killing assertion: with the task reverted, the gate classifies with the co-located defaults. The file is then source, and the probe blocks with `no-new-tests`.
   */
  it('Settle_AWorktreeThatEmptiesItsTestGlobs_IsProbedWithThePinnedGlobs', async () => {
    const repository = await repositoryWith(PINNED_CHECKS_CONFIG);
    const marker = path.join(repository.root, 'runs.log');

    const { settled, capsuleVersion } = await settleTheTask(repository, {
      '.exarchos.yml': EMPTIED_GLOBS_CONFIG,
      'src/value.mjs': CHANGED_SOURCE,
      'checks/a.check.mjs': killingTest('../src/value.mjs', marker),
    });

    expect(capsuleVersion).toBe(1);
    expect(settled.outcome).toBe('settled');
    expect(settled.acceptedTasks).toEqual([TASK_ID]);
    expect(await recordedRuns(marker)).toBe(2);
    expect(await probeReport()).toContain('pinned by capsule v1');
  }, CASE_TIMEOUT_MS);

  /**
   * The checkout pins a probe of the `none` form, so the verdict rests on two runs of the whole command. The task is accepted on that verdict,
   * and the trace states the degraded mark of the probe. With the task reverted, the gate does not read the key, and the trace holds no such mark.
   */
  it('Settle_AnUnscopedRun_GivesADegradedQualifierInTheTrace', async () => {
    const repository = await repositoryWith(UNSCOPED_PROBE_CONFIG);
    const marker = path.join(repository.root, 'runs.log');

    const { settled } = await settleTheTask(repository, {
      'src/value.mjs': CHANGED_SOURCE,
      'src/value.test.mjs': killingTest('./value.mjs', marker),
    });

    expect(settled.outcome).toBe('settled');
    expect(settled.acceptedTasks).toEqual([TASK_ID]);
    expect(await recordedRuns(marker)).toBe(2);
    expect(settled.verification.map((trace) => trace.qualifiers?.filter((qualifier) => qualifier.gate === 'test-adequacy'))).toEqual([
      [{ gate: 'test-adequacy', mark: 'degraded', advisorySkips: [{ name: 'Scoped run', cause: 'unscoped-run' }] }],
    ]);
  }, CASE_TIMEOUT_MS);
});
