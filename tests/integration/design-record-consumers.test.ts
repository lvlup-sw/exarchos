/**
 * Real consumer adapters share exact typed relations and captured evidence bytes.
 * @oracle-sources: literal records and expected edges here, existing legacy contract suites
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { createEvidenceSubject } from '../../src/workflow/admission/evidence-subject.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { evaluatePlanCoverage, evaluatePlanDecomposition, evaluatePlanProvenance, evaluatePlanTraceability } from '../../src/workflow/design-record/plan-checks.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const capture = vi.hoisted(() => ({ subject: undefined as unknown, afterCapture: () => {} }));
vi.mock('../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: async (request: {
    subject: (phase: string) => unknown; executeProvider: () => Promise<ToolResult>;
  }) => {
    capture.subject = request.subject('phase-attempt:test');
    capture.afterCapture();
    return request.executeProvider();
  },
}));
vi.mock('../../src/verbs/gates/gate-utils.js', () => ({
  emitGateEvent: vi.fn(async () => {}),
  requireGateEvent: vi.fn(async () => undefined),
  sameOperationGateKey: (gate: string) => gate,
}));
import { handlePlanCoverage } from '../../src/verbs/gates/plan-coverage.js';
import { handleGenerateTraceability } from '../../src/verbs/gates/generate-traceability.js';
import { handleProvenanceChain } from '../../src/verbs/gates/provenance-chain.js';
import { verifyProvenanceChain } from '../../src/verbs/pure/provenance-chain.js';
import { handleTaskDecomposition } from '../../src/verbs/tasks/task-decomposition.js';

const directories: string[] = [];
const store = {} as EventStore;
afterEach(() => {
  capture.afterCapture = () => {};
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmrf(directory);
});
function files(design: string, plan = design) {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-record-'));
  directories.push(directory);
  const designPath = join(directory, 'design.md');
  const planPath = join(directory, 'plan.md');
  writeFileSync(designPath, design);
  writeFileSync(planPath, plan);
  return { designPath, planPath, outputFile: join(directory, 'report.md') };
}
function task(id: string, implementsIds: string[], blockedBy: string[] = []) {
  return { id, title: 'DR-99 and misleading other requirement', implements: implementsIds, blockedBy,
    files: [`src/${id}.ts`], testFiles: [`tests/${id}.test.ts`], riskTier: 'high', boundaryTouching: true,
    testLayer: 'acceptance', acceptance: ['The exact authored relation remains intact.'], instructions: 'Implement only the authored edges.', parallelizable: false };
}
function record(tasks = [task('T-1', ['DR-2']), task('T-01', ['DR-1'], ['T-1'])]) {
  return '# Design & Rationale\n### DR-1: First\n### DR-2: Second\n## Tasks\n```exarchos-plan-v1\n'
    + JSON.stringify({ version: 1, requirements: ['DR-1', 'DR-2'], tasks }) + '\n```\n### Task 99: Fake\n**Implements:** DR-99';
}
async function consumers(design: string, plan = design) {
  const paths = files(design, plan);
  const args = { featureId: 'consumer-test', ...paths };
  return { paths, coverage: await handlePlanCoverage(args, '', store),
    trace: handleGenerateTraceability({ designFile: paths.designPath, planFile: paths.planPath, outputFile: paths.outputFile }),
    provenance: await handleProvenanceChain(args, '', store),
    pure: verifyProvenanceChain({ designFile: paths.designPath, planFile: paths.planPath }),
    decomposition: await handleTaskDecomposition(args, '', store) };
}
function snapshot(text: string) {
  const result = readDesignRecord(Buffer.from(text), 'record.md');
  if (result.kind !== 'typed') throw new Error(JSON.stringify(result));
  return result.snapshot;
}

describe('typed consumer adoption; prepare remains deferred to its own task', () => {
  it('Consumers_T01WithMisleadingTitle_AgreeOnEdges', async () => {
    const text = record();
    const expected = [{ taskId: 'T-01', requirementId: 'DR-1' }, { taskId: 'T-1', requirementId: 'DR-2' }];
    const results = await consumers(text);
    for (const result of [results.coverage, results.trace, results.provenance]) {
      expect(result).toMatchObject({ success: true, data: { passed: true, edges: expected } });
    }
    expect(results.pure).toMatchObject({ status: 'pass', edges: expected });
    expect(results.decomposition).toMatchObject({ success: true, data: { passed: true, totalTasks: 2,
      tasks: [{ id: 'T-1', blockedBy: [] }, { id: 'T-01', blockedBy: ['T-1'] }] } });
    expect(results.trace.data?.report).toBe('| Requirement | Task |\n|---|---|\n| DR-2 | T-1 |\n| DR-1 | T-01 |');
  });
  it('generated relations agree across real wrappers and shared evaluators', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.integer({ min: 2, max: 8 }), async (crossEdge, swap, size) => {
      const tasks = [task('T-1', crossEdge ? ['DR-2', 'DR-1'] : ['DR-2']), task('T-01', ['DR-1'], ['T-1'])];
      for (let index = 2; index < size; index++) tasks.push(task(`task-${index}`, [index % 2 ? 'DR-1' : 'DR-2'], [index === 2 ? 'T-01' : `task-${index - 1}`]));
      const text = record(swap ? [...tasks].reverse() : tasks);
      const expected = [{ taskId: 'T-01', requirementId: 'DR-1' },
        ...(crossEdge ? [{ taskId: 'T-1', requirementId: 'DR-1' }] : []), { taskId: 'T-1', requirementId: 'DR-2' }];
      for (let index = 2; index < size; index++) expected.push({ taskId: `task-${index}`, requirementId: index % 2 ? 'DR-1' : 'DR-2' });
      expected.sort((a, b) => a.requirementId.localeCompare(b.requirementId) || a.taskId.localeCompare(b.taskId));
      const results = await consumers(text);
      for (const result of [results.coverage, results.trace, results.provenance]) expect(result.data?.edges).toEqual(expected);
      expect(results.pure.edges).toEqual(expected);
      const source = snapshot(text);
      for (const evaluate of [evaluatePlanCoverage, evaluatePlanTraceability, evaluatePlanProvenance]) expect(evaluate(source).edges).toEqual(expected);
      expect(results.decomposition.data?.tasks).toEqual(source.tasks);
      expect(results.decomposition.data?.findings).toEqual(evaluatePlanDecomposition(source).findings);
    }), { numRuns: 20 });
  });
  it.each(['{', '{"version":1,"version":1}', '{"version":2}', '{"unknown":true}',
    '{}\n```\n```exarchos-plan-v1\n{}'])('Consumers_InvalidTypedBlock_AllRefuse: %s', async (body) => {
    const text = '# Design & Rationale\n### DR-1: First\n```exarchos-plan-v1\n' + body
      + '\n```\n## Tasks\n### Task 1: First\n**Implements:** DR-1';
    const results = await consumers(text);
    for (const result of [results.coverage, results.trace, results.provenance, results.decomposition]) expect(result.success).toBe(false);
    expect(results.pure.status).toBe('error');
    expect(existsSync(results.paths.outputFile)).toBe(false);
  });
  it.each(['UNKNOWN_IMPLEMENTS', 'DEPENDENCY_CYCLE', 'UNKNOWN_DEPENDENCY', 'SELF_DEPENDENCY', 'PARALLEL_FILE_CONFLICT', 'MISSING_REQUIREMENT_DEFINITION', 'DUPLICATE_REQUIREMENT'])('whole graph refuses %s despite full coverage', async (code) => {
    const tasks = [task('T-1', ['DR-2']), task('T-01', ['DR-1'], ['T-1'])];
    const first = tasks[0];
    const second = tasks[1];
    if (!first || !second) throw new Error('Missing fixture task');
    if (code === 'UNKNOWN_IMPLEMENTS') first.implements.push('DR-99');
    if (code === 'DEPENDENCY_CYCLE') first.blockedBy.push('T-01');
    if (code === 'UNKNOWN_DEPENDENCY') first.blockedBy.push('missing');
    if (code === 'SELF_DEPENDENCY') first.blockedBy.push(first.id);
    if (code === 'PARALLEL_FILE_CONFLICT') { first.parallelizable = true; second.parallelizable = true; second.files = first.files; }
    let text = record(tasks);
    if (code === 'MISSING_REQUIREMENT_DEFINITION') text = text.replace('### DR-1: First', '### Other heading');
    if (code === 'DUPLICATE_REQUIREMENT') text = text.replace('### DR-1: First', '### DR-1: First\n### DR-1: Repeated');
    const results = await consumers(text);
    for (const result of [results.coverage, results.trace, results.provenance, results.decomposition]) {
      expect(result.data?.passed).toBe(false);
      expect(result.data?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    }
    expect(results.pure.status).toBe('fail');
    expect(existsSync(results.paths.outputFile)).toBe(false);
  });
  it('classifies both sources and refuses different typed or legacy bytes', async () => {
    for (const [design, plan] of [[record(), 'legacy'], ['legacy', record()], [record(), '```exarchos-plan-v1\n{\n```'], [record(), record() + '\n'], ['```exarchos-plan-v1\n{\n```', record()]]) {
      if (design === undefined || plan === undefined) throw new Error('Missing pair');
      const results = await consumers(design, plan);
      for (const result of [results.coverage, results.trace, results.provenance]) expect(result.success).toBe(false);
      expect(results.pure.status).toBe('error');
      expect(existsSync(results.paths.outputFile)).toBe(false);
    }
  });
  it('unified absolute paths are captured once by coverage traceability and pure provenance', async () => {
    const paths = files(record());
    const args = { featureId: 'consumer-test', designPath: paths.designPath, planPath: paths.designPath };
    const reads = vi.mocked(fsPromises.readFile);
    const syncReads = vi.mocked(fs.readFileSync);
    expect((await handlePlanCoverage(args, '', store)).data?.passed).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(handleGenerateTraceability({ designFile: paths.designPath, planFile: paths.designPath }).data?.passed).toBe(true);
    expect(syncReads).toHaveBeenCalledTimes(1);
    syncReads.mockClear();
    expect(verifyProvenanceChain({ designFile: paths.designPath, planFile: paths.designPath }).status).toBe('pass');
    expect(syncReads).toHaveBeenCalledTimes(1);
  });
  it('typed coverage and decomposition advisories do not block a sound graph', async () => {
    const tasks = [task('T-1', ['DR-2']), task('T-01', ['DR-1'], ['T-1'])];
    for (const item of tasks) { item.testLayer = 'unit'; item.files = ['a/file', 'b/file', 'c/file', 'd/file', 'e/file']; }
    const text = record(tasks).replace('### DR-1: First', '### DR-1: First\n**Given** a record\n**When** it changes\n**Then** its identity changes');
    const results = await consumers(text);
    expect(results.coverage.data?.passed).toBe(true);
    expect(results.coverage.data?.advisories).toHaveLength(1);
    expect(results.decomposition.data?.passed).toBe(true);
    expect(results.decomposition.data?.plausibility.challenged).toBe(true);
  });
  it.each([true, false])('Provenance_FileChangesAfterRead_DigestMatchesVerdict typed=%s', async (typed) => {
    const design = typed ? record() : '### DR-1: First';
    const plan = typed ? design : '### Task 1: First\n**Implements:** DR-1';
    const paths = files(design, plan);
    const planPath = typed ? paths.designPath : paths.planPath;
    const reads = vi.mocked(fsPromises.readFile);
    const syncReads = vi.mocked(fs.readFileSync);
    capture.afterCapture = () => { writeFileSync(paths.designPath, 'invalid replacement'); writeFileSync(planPath, 'invalid replacement'); };
    const result = await handleProvenanceChain({ featureId: 'consumer-test', designPath: paths.designPath, planPath }, '', store);
    expect(result).toMatchObject({ success: true, data: { passed: true } });
    expect(reads).toHaveBeenCalledTimes(typed ? 1 : 2);
    expect(syncReads).not.toHaveBeenCalled();
    if (typed) expect(result.data?.digest).toBe(createHash('sha256').update(design).digest('hex'));
    expect(capture.subject).toEqual(createEvidenceSubject({ kind: 'artifact',
      artifactId: `plan-spec:${createHash('sha256').update('consumer-test').digest('hex').slice(0, 32)}` },
    { designPath: paths.designPath, planPath, designContent: design, planContent: plan }));
  });
});
