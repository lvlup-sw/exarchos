/**
 * The observed counter: the Exarchos calls of each workflow in one recorded session tree.
 *
 * The fixture is a trimmed copy of recorded lines. Its counts come from a hand count that the lead made before the counter ran.
 * The other cases build a session tree in a temporary directory with compact JSON lines.
 * Each `tool_use` block keeps the key order `type`, `id`, `name`, `input`, which the conservation regex reads.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { roleOf } from '../../tools/audit/core/call-shape/census.js';
import { readRegistry } from '../../tools/audit/core/call-shape/measure.js';
import { countObservedCalls, ObservedCallCountError } from '../../tools/audit/core/call-shape/observed.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(HERE, '../..');

/** The session file of the recorded fixture tree. */
const FIXTURE_SESSION = path.join(HERE, '__fixtures__', 'observed-call-count', 'recorded-session.jsonl');

/** The workflow of the recorded fixture. */
const FIXTURE_WORKFLOW = 'no-per-language-code';

const WORKFLOW_TOOL = 'mcp__exarchos__exarchos_workflow';

const ORCHESTRATE_TOOL = 'mcp__exarchos__exarchos_orchestrate';

/** The orchestrate tool of the Exarchos plugin, as a transcript names it. */
const PLUGIN_ORCHESTRATE_TOOL = 'mcp__plugin_exarchos_exarchos__exarchos_orchestrate';

type ObservedCount = ReturnType<typeof countObservedCalls>;

type WorkflowCount = ObservedCount['workflows'][number];

/** A cell of a workflow and a caller with no call. */
const ZERO_CELL = { work: 0, describe: 0, runbookFetch: 0, failed: 0, noAction: 0, unregistered: 0, calls: 0, filesWithCalls: 0 };

/** The temporary trees of the running case. The `afterEach` hook removes each one. */
const trees: string[] = [];

/** Removes each temporary tree of the case that ran. */
afterEach(async () => {
  for (const root of trees.splice(0)) await rmrfAsync(root);
});

/** The recorded fixture count. Each fixture case reads the same count. */
let recordedCount: ObservedCount | undefined;

function recorded(): ObservedCount {
  recordedCount ??= countObservedCalls(FIXTURE_SESSION);
  return recordedCount;
}

/** The timestamp `second` seconds after a fixed start. A later second gives a later timestamp. */
function at(second: number): string {
  return new Date(Date.UTC(2026, 10, 9, 10, 0, second)).toISOString();
}

/**
 * One call and its result as two compact JSON lines.
 * An `is-error` result has `is_error: true`. An `envelope-failure` result holds only the envelope with `success: false`.
 */
function exchange(
  id: string,
  name: string,
  input: Readonly<Record<string, unknown>>,
  second: number,
  result: 'ok' | 'is-error' | 'envelope-failure' = 'ok',
): string[] {
  const content = result === 'ok' ? '{"success":true}' : '{"success":false}';
  return [
    JSON.stringify({
      type: 'assistant',
      uuid: `a-${id}`,
      timestamp: at(second),
      message: { content: [{ type: 'tool_use', id, name, input }] },
    }),
    JSON.stringify({
      type: 'user',
      uuid: `u-${id}`,
      timestamp: at(second),
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content, ...(result === 'is-error' ? { is_error: true } : {}) }],
      },
    }),
  ];
}

/** The text of a `.jsonl` file that holds the lines. */
function jsonl(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** The text of a meta file with the fields that the case gives. */
function meta(fields: Readonly<Record<string, string>>): string {
  return JSON.stringify(fields);
}

/**
 * Writes a session tree under a new temporary directory and returns the path of its session file.
 * Each key is a POSIX path relative to that directory. The session file is `session.jsonl`.
 */
function writeTree(files: Readonly<Record<string, string>>, directories: readonly string[] = []): string {
  const root = makeTempDir('observed-call-count-');
  trees.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  for (const rel of directories) mkdirSync(path.join(root, ...rel.split('/')), { recursive: true });
  return path.join(root, 'session.jsonl');
}

/**
 * Makes `link` a symbolic link to the directory `target`. Both are POSIX paths relative to the directory of the session file.
 * On Windows the link is a junction, which needs no privilege.
 */
function linkDirectory(session: string, target: string, link: string): void {
  const root = path.dirname(session);
  const linkPath = path.join(root, ...link.split('/'));
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(path.join(root, ...target.split('/')), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** The counts of one workflow. It fails the case when the output holds no such workflow. */
function workflowOf(count: ObservedCount, workflow: string): WorkflowCount {
  const found = count.workflows.find((entry) => entry.workflow === workflow);
  if (found === undefined) throw new Error(`the output holds no workflow ${workflow}`);
  return found;
}

/** The output entry of one file. It fails the case when the output holds no such file. */
function fileOf(count: ObservedCount, rel: string): ObservedCount['files'][number] {
  const found = count.files.find((entry) => entry.path === rel);
  if (found === undefined) throw new Error(`the output holds no file ${rel}`);
  return found;
}

/** Runs the counter and returns the code of its refusal. It fails the case when the counter does not refuse. */
function refusalOf(session: string): string {
  try {
    countObservedCalls(session);
  } catch (error) {
    if (error instanceof ObservedCallCountError) return error.code;
    throw error;
  }
  throw new Error('the counter did not refuse');
}

describe('observed call count', () => {
  it('ObservedCallCount_WorkDescribeAndRunbookCalls_AreCountedApart', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 1),
        ...exchange('toolu_describe01', WORKFLOW_TOOL, { action: 'describe', featureId: 'feat-a' }, 2),
        ...exchange('toolu_runbook01', ORCHESTRATE_TOOL, { action: 'runbook', id: 'task-completion', featureId: 'feat-a' }, 3),
        ...exchange('toolu_update01', WORKFLOW_TOOL, { action: 'update', featureId: 'feat-a' }, 4),
      ]),
    });

    expect(workflowOf(countObservedCalls(session), 'feat-a').counts).toEqual({
      work: 2,
      describe: 1,
      runbookFetch: 1,
      failed: 0,
      noAction: 0,
      unregistered: 0,
    });
  });

  it('ObservedCallCount_ARawRunbookFetch_IsARunbookFetchAsInTheCallShapeCensus', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_runbook01', PLUGIN_ORCHESTRATE_TOOL, { action: 'runbook', featureId: 'feat-a' }, 1)),
    });

    expect(roleOf('exarchos_orchestrate.runbook')).toBe('runbook-fetch');
    expect(workflowOf(countObservedCalls(session), 'feat-a').counts.runbookFetch).toBe(1);
  });

  it('ObservedCallCount_AnUnknownExarchosTool_IsRefused', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 1),
        ...exchange('toolu_ghost01', 'mcp__exarchos__exarchos_ghost', { action: 'get', featureId: 'feat-a' }, 2),
      ]),
    });

    expect(refusalOf(session)).toBe('UNKNOWN_EXARCHOS_TOOL');
  });

  it('ObservedCallCount_ASubagentFile_IsReadAndMarked', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/agent-one.jsonl': jsonl(exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 2)),
      'session/subagents/agent-one.meta.json': meta({ agentType: 'general-purpose' }),
    });

    const count = countObservedCalls(session);

    expect(fileOf(count, 'session.jsonl').subagent).toBe(false);
    expect(fileOf(count, 'subagents/agent-one.jsonl')).toMatchObject({ subagent: true, calls: 1 });
    expect(workflowOf(count, 'feat-a').total).toBe(2);
  });

  it('ObservedCallCount_ANestedSubagentFile_IsRead', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/workflows/wf_x/deep/agent-nested.jsonl': jsonl(
        exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 2),
      ),
      'session/subagents/workflows/wf_x/deep/agent-nested.meta.json': meta({ agentType: 'workflow-subagent' }),
    });

    const count = countObservedCalls(session);

    expect(fileOf(count, 'subagents/workflows/wf_x/deep/agent-nested.jsonl').calls).toBe(1);
    expect(workflowOf(count, 'feat-a').total).toBe(2);
  });

  it('ObservedCallCount_ARepeatedToolUseId_IsCountedOnce', () => {
    const repeated = exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 1);
    const session = writeTree({
      'session.jsonl': jsonl([...repeated, ...repeated]),
      'session/subagents/agent-one.jsonl': jsonl(repeated),
      'session/subagents/agent-one.meta.json': meta({ agentType: 'general-purpose' }),
    });

    const count = countObservedCalls(session);

    expect(workflowOf(count, 'feat-a').total).toBe(1);
    expect(count.repeatedEvents).toBe(2);
    expect(count.distinctIds).toBe(1);
    expect(fileOf(count, 'session.jsonl').calls).toBe(1);
    expect(fileOf(count, 'subagents/agent-one.jsonl').calls).toBe(0);
  });

  it('ObservedCallCount_TwoWorkflowsInOneSession_AreCountedApart', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_a01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1),
        ...exchange('toolu_b01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-b' }, 2),
        ...exchange('toolu_b02', ORCHESTRATE_TOOL, { action: 'settle', streamId: 'feat-b' }, 3),
        ...exchange('toolu_a02', WORKFLOW_TOOL, { action: 'get', workflowId: 'feat-a' }, 4),
        ...exchange('toolu_b03', 'mcp__exarchos__exarchos_event', { action: 'query', stream: 'feat-b' }, 5),
      ]),
    });

    const count = countObservedCalls(session);

    expect(count.workflows.map((entry) => [entry.workflow, entry.total])).toEqual([
      ['feat-a', 2],
      ['feat-b', 3],
    ]);
  });

  it('ObservedCallCount_ACallWithNoWorkflow_GoesToTheLatestWorkflowOfItsFile', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_a01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1),
        ...exchange('toolu_a02', WORKFLOW_TOOL, { action: 'describe' }, 2),
        ...exchange('toolu_b01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-b' }, 5),
      ]),
      'session/subagents/agent-one.jsonl': jsonl([
        ...exchange('toolu_c01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-c' }, 3),
        ...exchange('toolu_d01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-d' }, 4),
        ...exchange('toolu_none01', ORCHESTRATE_TOOL, { action: 'describe' }, 6),
      ]),
      'session/subagents/agent-one.meta.json': meta({ agentType: 'general-purpose' }),
    });

    const count = countObservedCalls(session);

    expect(count.workflows.map((entry) => [entry.workflow, entry.total])).toEqual([
      ['feat-a', 2],
      ['feat-b', 1],
      ['feat-c', 1],
      ['feat-d', 2],
    ]);
    expect(count.unattributed.total).toBe(0);
  });

  it('ObservedCallCount_ACallBeforeAnyWorkflow_IsUnattributed', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_describe01', ORCHESTRATE_TOOL, { action: 'describe' }, 1),
        ...exchange('toolu_a01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 2),
      ]),
    });

    const count = countObservedCalls(session);

    expect(count.unattributed.total).toBe(1);
    expect(count.unattributed.counts.describe).toBe(1);
    expect(workflowOf(count, 'feat-a').total).toBe(1);
    expect(count.findings).toContainEqual(expect.objectContaining({ workflow: null, caller: null, calls: 1 }));
  });

  it('ObservedCallCount_AFailedCall_IsCountedApartAndInNoRoleTotal', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 1, 'is-error'),
        ...exchange('toolu_describe01', WORKFLOW_TOOL, { action: 'describe', featureId: 'feat-a' }, 2, 'envelope-failure'),
        ...exchange('toolu_update01', WORKFLOW_TOOL, { action: 'update', featureId: 'feat-a' }, 3),
      ]),
    });

    expect(workflowOf(countObservedCalls(session), 'feat-a').counts).toEqual({
      work: 1,
      describe: 0,
      runbookFetch: 0,
      failed: 2,
      noAction: 0,
      unregistered: 0,
    });
  });

  it('ObservedCallCount_AnExarchosCallWithNoAction_IsCountedApart', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_noaction01', WORKFLOW_TOOL, { featureId: 'feat-a' }, 1),
        ...exchange('toolu_numeric01', WORKFLOW_TOOL, { action: 7, featureId: 'feat-a' }, 2),
        ...exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 3),
      ]),
    });

    expect(workflowOf(countObservedCalls(session), 'feat-a').counts).toMatchObject({ work: 1, noAction: 2, failed: 0 });
  });

  it('ObservedCallCount_AnUnregisteredCallThatFailed_IsCountedOnceAsUnregistered', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_set01', WORKFLOW_TOOL, { action: 'set', featureId: 'feat-a' }, 1, 'is-error')),
    });

    const workflow = workflowOf(countObservedCalls(session), 'feat-a');

    expect(workflow.counts).toEqual({ work: 0, describe: 0, runbookFetch: 0, failed: 0, noAction: 0, unregistered: 1 });
    expect(workflow.total).toBe(1);
  });

  it('ObservedCallCount_ACallWithNoActionThatFailed_IsCountedOnceAsNoAction', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_noaction01', ORCHESTRATE_TOOL, { featureId: 'feat-a' }, 1, 'is-error')),
    });

    const workflow = workflowOf(countObservedCalls(session), 'feat-a');

    expect(workflow.counts).toEqual({ work: 0, describe: 0, runbookFetch: 0, failed: 0, noAction: 1, unregistered: 0 });
    expect(workflow.total).toBe(1);
  });

  it('ObservedCallCount_EachWorkflow_SplitsItsCountsByCaller', () => {
    expect(workflowOf(recorded(), FIXTURE_WORKFLOW).byCaller).toEqual({
      coordinator: { ...ZERO_CELL, work: 49, failed: 6, unregistered: 1, calls: 56, filesWithCalls: 2 },
      reviewer: ZERO_CELL,
      worker: ZERO_CELL,
      other: { ...ZERO_CELL, work: 5, describe: 1, failed: 1, calls: 7, filesWithCalls: 1 },
      unknown: ZERO_CELL,
    });
  });

  it('ObservedCallCount_EachCaller_CountsItsFilesOverTheWholeTree', () => {
    expect(recorded().population).toEqual({
      byCaller: {
        coordinator: { files: 2, filesWithCalls: 2, calls: 56 },
        reviewer: { files: 0, filesWithCalls: 0, calls: 0 },
        worker: { files: 1, filesWithCalls: 0, calls: 0 },
        other: { files: 1, filesWithCalls: 1, calls: 7 },
        unknown: { files: 0, filesWithCalls: 0, calls: 0 },
      },
      byRule: {
        1: { files: 1, filesWithCalls: 1, calls: 55 },
        2: { files: 1, filesWithCalls: 0, calls: 0 },
        3: { files: 1, filesWithCalls: 1, calls: 1 },
        4: { files: 0, filesWithCalls: 0, calls: 0 },
        5: { files: 1, filesWithCalls: 1, calls: 7 },
      },
    });
  });

  it('ObservedCallCount_AFileWithNoTranscriptLine_HasNoCaller', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/workflows/wf_x/journal.jsonl': jsonl([
        JSON.stringify({ type: 'launched', at: at(2) }),
        JSON.stringify({ type: 'started', at: at(3) }),
      ]),
    });

    const count = countObservedCalls(session);

    expect(count.noTranscript).toEqual(['subagents/workflows/wf_x/journal.jsonl']);
    expect(fileOf(count, 'subagents/workflows/wf_x/journal.jsonl')).toMatchObject({ transcript: false, caller: null, rule: null });
    expect(Object.values(count.population.byCaller).reduce((sum, cell) => sum + cell.files, 0)).toBe(1);
    expect(count.population.byCaller.unknown.files).toBe(0);
  });

  it('ObservedCallCount_EachFilePath_IsPosixAndInCodeUnitOrder', () => {
    expect(recorded().files.map((file) => file.path)).toEqual([
      'recorded-session.jsonl',
      'subagents/agent-fixture.jsonl',
      'subagents/agent-implementer.jsonl',
      'subagents/workflows/wf_fixture/agent-coordinator.jsonl',
    ]);
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/agent-b.jsonl': jsonl(exchange('toolu_b01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 2)),
      'session/subagents/Agent-C.jsonl': jsonl(exchange('toolu_c01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 3)),
      'session/subagents/Z/agent-a.jsonl': jsonl(exchange('toolu_a01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 4)),
    });

    expect(countObservedCalls(session).files.map((file) => file.path)).toEqual([
      'session.jsonl',
      'subagents/Agent-C.jsonl',
      'subagents/Z/agent-a.jsonl',
      'subagents/agent-b.jsonl',
    ]);
  });

  it('ObservedCallCount_EachRuleThreeFile_IsListedWithItsWorkflowPhase', () => {
    const count = recorded();

    expect(count.ruleThreeFiles).toEqual([
      { path: 'subagents/workflows/wf_fixture/agent-coordinator.jsonl', workflowPhase: 'E prepare' },
    ]);
    expect(count.ruleThreeByPhase).toEqual([{ workflowPhase: 'E prepare', files: 1 }]);
  });

  it('ObservedCallCount_EachWorkflow_GivesTheSumOfItsCountsOverEveryCaller', () => {
    const workflow = workflowOf(recorded(), FIXTURE_WORKFLOW);

    expect(workflow.total).toBe(63);
    expect(workflow.byCaller.coordinator.calls).toBe(56);
    expect(workflow.counts).toEqual({ work: 54, describe: 1, runbookFetch: 0, failed: 7, noAction: 0, unregistered: 1 });
  });

  it('ObservedCallCount_APrepareCallInAWorkflowSubagentFile_CountsForTheCoordinator', () => {
    const file = fileOf(recorded(), 'subagents/workflows/wf_fixture/agent-coordinator.jsonl');

    expect(file).toMatchObject({ caller: 'coordinator', rule: 3, agentType: 'workflow-subagent', calls: 1 });
    expect(file.counts.work).toBe(1);
  });

  it('ObservedCallCount_AnExarchosAgentSpecType_GivesItsCaller', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/agent-implementer.jsonl': jsonl(exchange('toolu_i01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 2)),
      'session/subagents/agent-implementer.meta.json': meta({ agentType: 'exarchos:exarchos-implementer' }),
      'session/subagents/agent-reviewer.jsonl': jsonl(exchange('toolu_r01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 3)),
      'session/subagents/agent-reviewer.meta.json': meta({ agentType: 'exarchos-reviewer' }),
      'session/subagents/agent-fixer.jsonl': jsonl(exchange('toolu_f01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 4)),
      'session/subagents/agent-fixer.meta.json': meta({ agentType: 'exarchos:exarchos-fixer' }),
      'session/subagents/agent-scaffolder.jsonl': jsonl(exchange('toolu_s01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 5)),
      'session/subagents/agent-scaffolder.meta.json': meta({ agentType: 'exarchos-scaffolder' }),
      'session/subagents/agent-stranger.jsonl': jsonl(exchange('toolu_x01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 6)),
      'session/subagents/agent-stranger.meta.json': meta({ agentType: 'exarchos:exarchos-stranger' }),
    });

    const count = countObservedCalls(session);

    expect(
      count.files.filter((file) => file.subagent).map((file) => [file.path, file.caller, file.rule]),
    ).toEqual([
      ['subagents/agent-fixer.jsonl', 'worker', 2],
      ['subagents/agent-implementer.jsonl', 'worker', 2],
      ['subagents/agent-reviewer.jsonl', 'reviewer', 2],
      ['subagents/agent-scaffolder.jsonl', 'worker', 2],
      ['subagents/agent-stranger.jsonl', 'other', 5],
    ]);
    expect(workflowOf(count, 'feat-a').byCaller.worker).toMatchObject({ calls: 3, filesWithCalls: 3 });
  });

  it('ObservedCallCount_AWorkerThatCallsSettle_StaysAWorker', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/agent-implementer.jsonl': jsonl(
        exchange('toolu_settle01', ORCHESTRATE_TOOL, { action: 'settle', streamId: 'feat-a' }, 2),
      ),
      'session/subagents/agent-implementer.meta.json': meta({ agentType: 'exarchos:exarchos-implementer' }),
    });

    const count = countObservedCalls(session);

    expect(fileOf(count, 'subagents/agent-implementer.jsonl')).toMatchObject({ caller: 'worker', rule: 2 });
    expect(workflowOf(count, 'feat-a').byCaller.worker).toMatchObject({ work: 1, calls: 1, filesWithCalls: 1 });
    expect(count.findings).toContainEqual(expect.objectContaining({ workflow: 'feat-a', caller: 'worker', calls: 1 }));
  });

  it('ObservedCallCount_AWorkflowSubagentWithNoPrepareOrSettle_IsOther', () => {
    const count = recorded();

    expect(fileOf(count, 'subagents/agent-fixture.jsonl')).toMatchObject({
      caller: 'other',
      rule: 5,
      agentType: 'workflow-subagent',
      workflowPhase: 'F review',
    });
    expect(count.findings).toEqual([expect.objectContaining({ workflow: FIXTURE_WORKFLOW, caller: 'other', calls: 7 })]);
  });

  it('ObservedCallCount_EachFile_NamesTheRuleThatGaveItsCaller', () => {
    expect(
      recorded().files.map((file) => ({
        path: file.path,
        caller: file.caller,
        rule: file.rule,
        agentType: file.agentType,
        workflowPhase: file.workflowPhase,
      })),
    ).toEqual([
      { path: 'recorded-session.jsonl', caller: 'coordinator', rule: 1, agentType: null, workflowPhase: null },
      { path: 'subagents/agent-fixture.jsonl', caller: 'other', rule: 5, agentType: 'workflow-subagent', workflowPhase: 'F review' },
      {
        path: 'subagents/agent-implementer.jsonl',
        caller: 'worker',
        rule: 2,
        agentType: 'exarchos:exarchos-implementer',
        workflowPhase: null,
      },
      {
        path: 'subagents/workflows/wf_fixture/agent-coordinator.jsonl',
        caller: 'coordinator',
        rule: 3,
        agentType: 'workflow-subagent',
        workflowPhase: 'E prepare',
      },
    ]);
  });

  it('ObservedCallCount_ASubagentFileWithNoMetaFile_HasTheCallerUnknown', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/agent-bare.jsonl': jsonl(exchange('toolu_bare01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 2)),
      'session/subagents/agent-untyped.jsonl': jsonl(exchange('toolu_untyped01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 3)),
      'session/subagents/agent-untyped.meta.json': meta({ workflowPhase: 'F review' }),
      'session/subagents/agent-prepare.jsonl': jsonl(
        exchange('toolu_prepare01', ORCHESTRATE_TOOL, { action: 'prepare', streamId: 'feat-a' }, 4),
      ),
    });

    const count = countObservedCalls(session);

    expect(fileOf(count, 'subagents/agent-bare.jsonl')).toMatchObject({ caller: 'unknown', rule: 4 });
    expect(fileOf(count, 'subagents/agent-untyped.jsonl')).toMatchObject({ caller: 'unknown', rule: 4, workflowPhase: 'F review' });
    expect(fileOf(count, 'subagents/agent-prepare.jsonl')).toMatchObject({ caller: 'coordinator', rule: 3 });
    expect(count.population.byRule[4]).toEqual({ files: 2, filesWithCalls: 2, calls: 2 });
  });

  it('ObservedCallCount_ALineThatIsNotJson_IsCountedAsSkipped', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1),
        '{"type":"assistant","message":',
        'not json at all',
      ]),
    });

    const file = fileOf(countObservedCalls(session), 'session.jsonl');

    expect(file.lines).toBe(4);
    expect(file.skippedLines).toBe(2);
  });

  it('ObservedCallCount_ACallOnALineThatTheParserSkips_FailsTheConservationCheck', () => {
    const blob = JSON.stringify({
      type: 'api-request-blob',
      timestamp: at(2),
      message: {
        content: [{ type: 'tool_use', id: 'toolu_blob01', name: WORKFLOW_TOOL, input: { action: 'get', featureId: 'feat-a' } }],
      },
    });
    const session = writeTree({
      'session.jsonl': jsonl([...exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1), blob]),
    });

    expect(refusalOf(session)).toBe('COUNT_NOT_CONSERVED');
  });

  it('ObservedCallCount_AnUnreadableSubagentFile_IsRefused', () => {
    const session = writeTree(
      { 'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)) },
      ['session/subagents/agent-broken.jsonl'],
    );

    expect(refusalOf(session)).toBe('UNREADABLE_FILE');
  });

  it('ObservedCallCount_ATranscriptWithNoExarchosCall_IsRefused', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_read01', 'Read', { file_path: '/repo/README.md' }, 1)),
    });

    expect(refusalOf(session)).toBe('NO_EXARCHOS_CALL');
  });

  it('ObservedCallCount_TheRecordedSession_GivesItsHandCountedCounts', () => {
    const count = recorded();

    expect(count.sessionId).toBe('recorded-session');
    expect(count.workflows.map((entry) => [entry.workflow, entry.total])).toEqual([[FIXTURE_WORKFLOW, 63]]);
    expect(count.unattributed.total).toBe(0);
    expect(count.repeatedEvents).toBe(6);
    expect(count.distinctIds).toBe(63);
    expect(count.noTranscript).toEqual([]);
    expect(count.files.map((file) => [file.path, file.sha256, file.lines, file.skippedLines, file.calls])).toEqual([
      ['recorded-session.jsonl', '95a56e08df6c5003e7af53fb0bde9222ed32c110060aeb1a30cf99c18ca27eda', 122, 0, 55],
      ['subagents/agent-fixture.jsonl', '3834966606513c7dbb32852366ebfc804965c5f8f2b4a63d485479261e967606', 14, 0, 7],
      ['subagents/agent-implementer.jsonl', '3231e91713cf0d1588d3b12a81232d3da424953d5d2ee6a706eb073070a20468', 2, 0, 0],
      [
        'subagents/workflows/wf_fixture/agent-coordinator.jsonl',
        'e7dce082d14136d1ec8e4459914b0e69ff89f79aee6450e5b592c09f7f5692ca',
        2,
        0,
        1,
      ],
    ]);
  });

  it('ObservedCallCount_EachRole_IsTheRoleThatTheCallShapeCensusGives', () => {
    const registry = readRegistry(readFileSync(path.join(REPO_ROOT, 'tools/audit/registered-actions-snapshot.json'), 'utf8'));
    const expected = { work: 0, describe: 0, runbookFetch: 0 };
    const lines: string[] = [];
    let index = 0;
    for (const tool of registry.tools) {
      for (const action of tool.actions) {
        index += 1;
        lines.push(...exchange(`toolu_role${index}`, `mcp__exarchos__${tool.name}`, { action, featureId: 'roles' }, index));
        const role = roleOf(`${tool.name}.${action}`);
        if (role === 'describe') expected.describe += 1;
        else if (role === 'runbook-fetch') expected.runbookFetch += 1;
        else expected.work += 1;
      }
    }

    expect(index).toBe(registry.counts.actions);
    expect(expected.describe).toBeGreaterThan(0);
    expect(expected.runbookFetch).toBeGreaterThan(0);
    const session = writeTree({ 'session.jsonl': jsonl(lines) });
    expect(workflowOf(countObservedCalls(session), 'roles').counts).toEqual({
      ...expected,
      failed: 0,
      noAction: 0,
      unregistered: 0,
    });
  });

  /** The `workflows` directory under `subagents/` is a link to a directory outside the session tree. Each path keeps the names of the listing. */
  it('ObservedCallCount_ASymbolicLinkToADirectory_IsRead', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'elsewhere/wf_x/agent-prepare.jsonl': jsonl(
        exchange('toolu_prepare01', ORCHESTRATE_TOOL, { action: 'prepare', featureId: 'feat-a' }, 2),
      ),
      'elsewhere/wf_x/agent-prepare.meta.json': meta({ agentType: 'workflow-subagent', workflowPhase: 'E prepare' }),
    });
    linkDirectory(session, 'elsewhere', 'session/subagents/workflows');

    const count = countObservedCalls(session);

    expect(count.files.map((file) => file.path)).toEqual(['session.jsonl', 'subagents/workflows/wf_x/agent-prepare.jsonl']);
    expect(fileOf(count, 'subagents/workflows/wf_x/agent-prepare.jsonl')).toMatchObject({ caller: 'coordinator', rule: 3, calls: 1 });
    expect(workflowOf(count, 'feat-a').total).toBe(2);
    expect(count.distinctIds).toBe(2);
  });

  /** A link under the linked directory names `subagents/` again. The walk lists each real directory once, so it ends and reads each file once. */
  it('ObservedCallCount_ALinkLoop_IsReadOnce', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/agent-one.jsonl': jsonl(exchange('toolu_get01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 2)),
      'session/subagents/agent-one.meta.json': meta({ agentType: 'general-purpose' }),
      'elsewhere/wf_x/agent-prepare.jsonl': jsonl(
        exchange('toolu_prepare01', ORCHESTRATE_TOOL, { action: 'prepare', featureId: 'feat-a' }, 3),
      ),
      'elsewhere/wf_x/agent-prepare.meta.json': meta({ agentType: 'workflow-subagent', workflowPhase: 'E prepare' }),
    });
    linkDirectory(session, 'elsewhere', 'session/subagents/workflows');
    linkDirectory(session, 'session/subagents', 'elsewhere/wf_x/up');

    const count = countObservedCalls(session);

    expect(count.files.map((file) => file.path)).toEqual([
      'session.jsonl',
      'subagents/agent-one.jsonl',
      'subagents/workflows/wf_x/agent-prepare.jsonl',
    ]);
    expect(count.repeatedEvents).toBe(0);
    expect(count.distinctIds).toBe(3);
    expect(workflowOf(count, 'feat-a').total).toBe(3);
  });

  /**
   * The first call of `agent-b.jsonl` names no workflow, and its own file names none before it. It takes the latest workflow of the session file before its time.
   * The workflow that `agent-a.jsonl` names does not pass to the next file. The last call of `agent-b.jsonl` takes the workflow that its own file names.
   */
  it('ObservedCallCount_ACallWithNoWorkflow_TakesTheLatestWorkflowOfItsOwnFile', () => {
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_a01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1),
        ...exchange('toolu_b01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-b' }, 2),
        ...exchange('toolu_e01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-e' }, 9),
      ]),
      'session/subagents/agent-a.jsonl': jsonl(exchange('toolu_z01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-z' }, 3)),
      'session/subagents/agent-a.meta.json': meta({ agentType: 'general-purpose' }),
      'session/subagents/agent-b.jsonl': jsonl([
        ...exchange('toolu_none01', ORCHESTRATE_TOOL, { action: 'describe' }, 4),
        ...exchange('toolu_c01', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-c' }, 5),
        ...exchange('toolu_none02', ORCHESTRATE_TOOL, { action: 'describe' }, 6),
      ]),
      'session/subagents/agent-b.meta.json': meta({ agentType: 'general-purpose' }),
    });

    const count = countObservedCalls(session);

    expect(count.workflows.map((entry) => [entry.workflow, entry.total])).toEqual([
      ['feat-a', 1],
      ['feat-b', 2],
      ['feat-c', 2],
      ['feat-e', 1],
      ['feat-z', 1],
    ]);
    expect(count.unattributed.total).toBe(0);
  });

  /** An "E settle" workflow subagent calls settle and no prepare. Rule 3 makes it a coordinator file. */
  it('ObservedCallCount_ASettleCallInAWorkflowSubagentFile_CountsForTheCoordinator', () => {
    const session = writeTree({
      'session.jsonl': jsonl(exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1)),
      'session/subagents/workflows/wf_x/agent-settle.jsonl': jsonl(
        exchange('toolu_settle01', ORCHESTRATE_TOOL, { action: 'settle', streamId: 'feat-a' }, 2),
      ),
      'session/subagents/workflows/wf_x/agent-settle.meta.json': meta({ agentType: 'workflow-subagent', workflowPhase: 'E settle' }),
    });

    const count = countObservedCalls(session);

    expect(fileOf(count, 'subagents/workflows/wf_x/agent-settle.jsonl')).toMatchObject({ caller: 'coordinator', rule: 3, calls: 1 });
    expect(count.ruleThreeFiles).toEqual([{ path: 'subagents/workflows/wf_x/agent-settle.jsonl', workflowPhase: 'E settle' }]);
    expect(count.ruleThreeByPhase).toEqual([{ workflowPhase: 'E settle', files: 1 }]);
    expect(workflowOf(count, 'feat-a').byCaller.coordinator).toMatchObject({ calls: 2, filesWithCalls: 2 });
    expect(count.findings).toEqual([]);
  });

  /**
   * The split of each fixture file comes from the hand count. The implementer file holds no call, so its split is empty.
   * A file with two workflows and a call that no workflow takes gives one entry for each, with the unattributed entry last.
   */
  it('ObservedCallCount_EachFile_GivesTheSixCountsOfEachWorkflow', () => {
    const none = { work: 0, describe: 0, runbookFetch: 0, failed: 0, noAction: 0, unregistered: 0 };
    expect(recorded().files.map((file) => [file.path, file.byWorkflow])).toEqual([
      ['recorded-session.jsonl', [{ workflow: FIXTURE_WORKFLOW, calls: 55, counts: { ...none, work: 48, failed: 6, unregistered: 1 } }]],
      ['subagents/agent-fixture.jsonl', [{ workflow: FIXTURE_WORKFLOW, calls: 7, counts: { ...none, work: 5, describe: 1, failed: 1 } }]],
      ['subagents/agent-implementer.jsonl', []],
      ['subagents/workflows/wf_fixture/agent-coordinator.jsonl', [{ workflow: FIXTURE_WORKFLOW, calls: 1, counts: { ...none, work: 1 } }]],
    ]);
    const session = writeTree({
      'session.jsonl': jsonl([
        ...exchange('toolu_describe01', ORCHESTRATE_TOOL, { action: 'describe' }, 1),
        ...exchange('toolu_b01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-b' }, 2),
        ...exchange('toolu_a01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 3),
        ...exchange('toolu_a02', WORKFLOW_TOOL, { action: 'get', featureId: 'feat-a' }, 4, 'is-error'),
        ...exchange('toolu_b02', ORCHESTRATE_TOOL, { action: 'runbook', featureId: 'feat-b' }, 5),
      ]),
    });

    expect(fileOf(countObservedCalls(session), 'session.jsonl').byWorkflow).toEqual([
      { workflow: 'feat-a', calls: 2, counts: { ...none, work: 1, failed: 1 } },
      { workflow: 'feat-b', calls: 2, counts: { ...none, work: 1, runbookFetch: 1 } },
      { workflow: null, calls: 1, counts: { ...none, describe: 1 } },
    ]);
  });

  /**
   * One call has a block key order that the regex does not read. One call sits on a line that the parser skips.
   * The two counts agree, and the two sets of ids do not. The refusal names the id on each side.
   */
  it('ObservedCallCount_TwoMissesThatCancel_FailTheConservationCheck', () => {
    const reordered = JSON.stringify({
      type: 'assistant',
      uuid: 'a-toolu_reordered01',
      timestamp: at(2),
      message: {
        content: [{ id: 'toolu_reordered01', type: 'tool_use', name: WORKFLOW_TOOL, input: { action: 'get', featureId: 'feat-a' } }],
      },
    });
    const blob = JSON.stringify({
      type: 'api-request-blob',
      timestamp: at(3),
      message: {
        content: [{ type: 'tool_use', id: 'toolu_blob01', name: WORKFLOW_TOOL, input: { action: 'get', featureId: 'feat-a' } }],
      },
    });
    const session = writeTree({
      'session.jsonl': jsonl([...exchange('toolu_init01', WORKFLOW_TOOL, { action: 'init', featureId: 'feat-a' }, 1), reordered, blob]),
    });

    expect(refusalOf(session)).toBe('COUNT_NOT_CONSERVED');
    expect(() => countObservedCalls(session)).toThrow('Ids in the text that no parsed call holds: toolu_blob01.');
    expect(() => countObservedCalls(session)).toThrow('Parsed ids that the regex does not find: toolu_reordered01.');
  });
});
