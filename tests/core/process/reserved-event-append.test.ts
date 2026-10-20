// Reserved-event append and the task completion chain in the packaged runtime.
//
// The guard for reserved events is built in and fails closed. A guard that works in `src` but is
// absent or inert in the compiled binary protects nothing. Without the guard, `event.append` lets
// a caller write forged admission evidence or a forged gate row into the log. Thus these cases
// call the compiled binary over MCP.
//
// A generic append must reject each reserved fact before persistence, so the log stays clean. An
// event that is not reserved must still append, which shows that the guard is not a blanket denial.
//
// The completion case runs the full chain in one workflow. First, the generic append refuses a
// `gate.executed` row. Then `check_static_analysis` with a task id passes on a fixture project.
// Last, `task_complete` records `task.completed` for that task. The `core` project collects this
// file, and a CI job that the merge gate needs runs that project.

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { gateRunnerObservationSource } from '../../../src/verbs/gates/gate-runner.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import {
  findRepoRoot,
  ensureBinaryBuilt,
  openFixture,
  closeFixture,
  type Fixture,
} from './_helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = findRepoRoot(__dirname);

let BINARY_PATH: string;

beforeAll(async () => {
  const { binaryPath } = await ensureBinaryBuilt(REPO_ROOT);
  BINARY_PATH = binaryPath;
}, 180_000);

interface ParsedResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code?: string; message?: string; eventType?: string };
}

async function call(
  fx: Fixture,
  name: string,
  args: Record<string, unknown>,
): Promise<ParsedResult> {
  const result = await fx.client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(Array.isArray(content)).toBe(true);
  const first = content[0];
  expect(first).toBeDefined();
  expect(first?.type).toBe('text');
  return JSON.parse(first!.text) as ParsedResult;
}

/** One row of an `exarchos_event` query, with the fields that the completion case reads. */
interface EventRow {
  readonly type?: string;
  readonly source?: string;
  readonly sequence?: number;
  readonly data?: {
    readonly taskId?: string;
    readonly gateName?: string;
    readonly passed?: boolean;
    readonly details?: { readonly taskId?: string };
  };
}

/** The page of an `exarchos_event` query. */
interface QueryPage {
  readonly events?: readonly EventRow[];
  readonly page?: { readonly hasMore?: boolean };
}

/**
 * The rows of one type in a stream. The query must succeed, and its page must hold each row of
 * that type, so a cut page cannot hide a row.
 */
async function rowsOfType(fx: Fixture, stream: string, type: string): Promise<readonly EventRow[]> {
  const queried = await call(fx, 'exarchos_event', {
    action: 'query',
    stream,
    filter: { type },
    limit: 100,
  });
  expect(queried.success, JSON.stringify(queried.error)).toBe(true);
  const page = queried.data as QueryPage | undefined;
  expect(page?.page?.hasMore, `the ${type} rows of ${stream} fill more than one page`).toBe(false);
  return page?.events ?? [];
}

/** An npm script that exits with 0. `node -e` is the cheapest such process, and it uses no network. */
const PASSING_SCRIPT = 'node -e ""';

/**
 * Makes a Node project on disk for the static-analysis gate. Its lint, typecheck and quality-check
 * scripts exit with 0. The project has no boundary config and no taint ruleset, so those legs do
 * not run.
 */
async function makePassingNodeProject(): Promise<string> {
  const dir = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-packaged-chain-')),
  );
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'packaged-chain-fixture',
      version: '1.0.0',
      private: true,
      scripts: { lint: PASSING_SCRIPT, typecheck: PASSING_SCRIPT, 'quality-check': PASSING_SCRIPT },
    }),
    'utf-8',
  );
  return dir;
}

describe('packaged reserved-event append authorization (EFF-007)', () => {
  const streamId = 'eff-007-packaged';

  /**
   * The message must name the rejected type. An operator can then act on the rejection when the
   * envelope omits the structured field.
   */
  it.each([
    ['admission fact', 'admission.evidence-recorded'],
    ['cancellation fact', 'cancel.compensation-completed'],
  ])(
    'PackagedEventAppend_Reserved_%s_RejectedFailClosed',
    async (_label, eventType) => {
      const fx = await openFixture(BINARY_PATH, REPO_ROOT);
      try {
        const rejected = await call(fx, 'exarchos_event', {
          action: 'append',
          stream: streamId,
          event: { type: eventType, data: { eventVersion: '1.0' } },
        });

        expect(rejected.success, `${eventType} must not append generically`).toBe(false);
        expect(rejected.error?.code).toBe('RESERVED_EVENT_TYPE');
        expect(rejected.error?.message).toContain(eventType);
      } finally {
        await closeFixture(fx);
      }
    },
    60_000,
  );

  /**
   * Fail-closed means that the rejection comes before persistence. A guard that denies the caller
   * but still writes the fact leaves forged evidence in the log, where each projection reads it.
   */
  it('PackagedEventAppend_RejectedReservedEvent_NeverReachesTheLog', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const rejected = await call(fx, 'exarchos_event', {
        action: 'append',
        stream: streamId,
        event: { type: 'admission.transition-decided', data: { eventVersion: '1.0' } },
      });
      expect(rejected.success).toBe(false);

      const queried = await call(fx, 'exarchos_event', {
        action: 'query',
        stream: streamId,
      });
      expect(queried.success).toBe(true);
      const serialized = JSON.stringify(queried.data ?? []);
      expect(serialized).not.toContain('admission.transition-decided');
    } finally {
      await closeFixture(fx);
    }
  }, 60_000);

  /**
   * The guard must apply only to reserved facts. A blanket denial passes the rejection cases and
   * breaks the generic append surface.
   */
  it('PackagedEventAppend_NonReservedEvent_StillAppends', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const accepted = await call(fx, 'exarchos_event', {
        action: 'append',
        stream: streamId,
        event: { type: 'task.progressed', data: { taskId: 'eff-007-task', tddPhase: 'green' } },
      });

      expect(accepted.success, JSON.stringify(accepted.error)).toBe(true);
    } finally {
      await closeFixture(fx);
    }
  }, 60_000);
});

describe('packaged task completion chain', () => {
  const featureId = 'packaged-completion-chain';
  const taskId = 'chain-001';
  const gateName = 'static-analysis';

  /**
   * The three steps share one workflow, one task and one stream. The generic append refuses a
   * forged static-analysis row and writes no `gate.executed` row. The gate handler then runs static
   * analysis for the task and writes one runner row. Last, `task_complete` records one
   * `task.completed` row for the task. A binary without the reservation accepts the forged row, so
   * the case fails at the first step.
   */
  it('PackagedCompletionChain_ForgedRowRefusedThenGateRun_TaskCompleteRecordsTheCompletion', async () => {
    const project = await makePassingNodeProject();
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const init = await call(fx, 'exarchos_workflow', {
        action: 'init',
        featureId,
        workflowType: 'feature',
      });
      expect(init.success, JSON.stringify(init.error)).toBe(true);

      const forged = await call(fx, 'exarchos_event', {
        action: 'append',
        stream: featureId,
        event: {
          type: 'gate.executed',
          data: { gateName, layer: 'verification-ladder', passed: true, details: { taskId } },
        },
      });
      expect(forged.success, JSON.stringify(forged)).toBe(false);
      expect(forged.error?.code).toBe('RESERVED_EVENT_TYPE');
      expect(await rowsOfType(fx, featureId, 'gate.executed')).toEqual([]);

      const gate = await call(fx, 'exarchos_orchestrate', {
        action: 'check_static_analysis',
        featureId,
        taskId,
        repoRoot: project,
      });
      expect(gate.success, JSON.stringify(gate)).toBe(true);
      expect(gate.data).toMatchObject({ passed: true, failCount: 0 });
      const runnerRows = await rowsOfType(fx, featureId, 'gate.executed');
      expect(
        runnerRows.map((row) => [row.source, row.data?.gateName, row.data?.details?.taskId, row.data?.passed]),
      ).toEqual([[gateRunnerObservationSource(gateName), gateName, taskId, true]]);

      const done = await call(fx, 'exarchos_orchestrate', {
        action: 'task_complete',
        taskId,
        streamId: featureId,
      });
      expect(done.success, JSON.stringify(done)).toBe(true);
      expect(done.data).toMatchObject({ streamId: featureId, type: 'task.completed' });
      const completed = done.data as { readonly sequence?: number } | undefined;
      const completions = await rowsOfType(fx, featureId, 'task.completed');
      expect(completions.map((row) => [row.data?.taskId, row.sequence])).toEqual([
        [taskId, completed?.sequence],
      ]);
    } finally {
      await closeFixture(fx);
      await rmrfAsync(project).catch(() => undefined);
    }
  }, 120_000);
});
