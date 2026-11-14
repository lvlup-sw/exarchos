/**
 * Typed task adapters share authored identity and validate the whole record.
 * @oracle-sources: authored task fields, explicit profile globs, and the legacy fixtures
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventStore } from '../../src/events/store.js';
import { toEnvelope, type ToolResult } from '../../src/format.js';
import { handleDesignCompleteness } from '../../src/verbs/gates/design-completeness.js';
import { handleSpecCoverageCheck, type SpecCoveragePhase } from '../../src/verbs/gates/spec-coverage-check.js';
import { handleExtractTask } from '../../src/verbs/tasks/extract-task.js';
import { parseTaskStamps, stampForTask } from '../../src/verbs/tasks/parse-task-stamps.js';
import { applyPlanStamps } from '../../src/verbs/team/prepare-delegation.js';
import type { DesignTask } from '../../src/workflow/design-record/schema.js';
import { makeTempDir, rmrf } from '../../tools/test-helpers/temp-dir.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock('../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: (request: { executeProvider: () => Promise<ToolResult> }) => request.executeProvider(),
}));

const LEGACY_TASK = '### Task T-01: Misleading DR-99 title\n**Risk Tier:** high\n**Test file:** `checks/legacy.test.ts`\n';
const STANDARD = readFileSync(new URL('../helpers/fixtures/design-record/typed-standard.md', import.meta.url), 'utf8');
let root: string;
let planPath: string;
let store: EventStore;

beforeEach(() => {
  root = makeTempDir('design-record-adapters-');
  planPath = join(root, 'plan.md');
  store = new EventStore(root);
  writeFileSync(join(root, '.exarchos.yml'),
    'verification:\n  tests:\n    globs: ["checks/**/*.proofcase", "checks/**/*.test.ts"]\n');
  vi.clearAllMocks();
});

afterEach(() => rmrf(root));

function task(id: string, fields: Partial<DesignTask> = {}): DesignTask {
  return {
    id,
    title: `Implement ${id}`,
    implements: ['DR-1'],
    blockedBy: [],
    files: [`src/${id}.ts`],
    testFiles: [],
    riskTier: 'low',
    boundaryTouching: false,
    testLayer: 'unit',
    acceptance: ['Preserve the declared field.'],
    instructions: 'Use the authored data.\nKeep the original identifier.',
    parallelizable: false,
    ...fields,
  };
}

function fenced(body: string, fence = 'exarchos-plan-v1'): string {
  return `\`\`\`${fence}\n${body}\n\`\`\`\n`;
}

function body(tasks: DesignTask[]): string {
  return JSON.stringify({ version: 1, requirements: ['DR-1'], tasks });
}

function record(tasks: DesignTask[], prose = LEGACY_TASK): string {
  return '# Design & Rationale\n### DR-1: Authored requirement\n## Tasks\n' + fenced(body(tasks)) + prose;
}

function coverage(coveragePhase: SpecCoveragePhase = 'plan', skipRun = false): Promise<ToolResult> {
  return handleSpecCoverageCheck({ featureId: 'adapter-test', planFile: planPath, repoRoot: root, coveragePhase, skipRun }, root, store);
}

describe('typed task adapters', () => {
  it('Stamps_TypedT01_UsesExactId', () => {
    const tasks = [
      task('T-01', { files: ['docs/identity.md'] }),
      task('T-1', { riskTier: 'high', boundaryTouching: true, testLayer: 'acceptance',
        testFiles: ['checks/one.proofcase'], blockedBy: ['T-01'] }),
      task('t-1', { riskTier: 'medium', testLayer: 'property' }),
      task('1', { files: ['docs/digits.md'] }),
      task('task-1', { testLayer: 'integration', blockedBy: ['1'] }),
    ];
    const stamps = parseTaskStamps(record(tasks, LEGACY_TASK + '### Task 99: Extra prose\n**Risk Tier:** high\n'));
    expect(stamps.map(({ id }) => id)).toEqual(tasks.map(({ id }) => id));
    for (const { id, title, files, blockedBy, riskTier, boundaryTouching, testLayer } of tasks) {
      expect(stampForTask(stamps, id)).toMatchObject({
        id, canonicalId: id, title, files, blockedBy, riskTier, boundaryTouching, testLayer,
      });
    }

    const callerOverride = { id: 'T-1', title: 'Caller title', riskTier: 'medium', boundaryTouching: false,
      testLayer: 'unit', files: ['src/caller.ts'], blockedBy: ['caller'] } as const;
    const alias = { id: 'T01', title: 'Unknown alias' };
    const proseOnly = { id: '99', title: 'Only in prose' };
    const result = applyPlanStamps([{ id: 'T-01', title: 'Caller title', files: [] }, callerOverride, alias, proseOnly], stamps);
    expect(result.tasks).toEqual([
      { id: 'T-01', title: 'Caller title', files: ['docs/identity.md'], riskTier: 'low', boundaryTouching: false, testLayer: 'unit' },
      callerOverride, alias, proseOnly,
    ]);
  });

  it('Extract_TypedTask_RendersCurrentStringContract', async () => {
    writeFileSync(planPath, STANDARD + '\n' + LEGACY_TASK);
    const extract = (taskId: string) => handleExtractTask({ planPath, taskId }, root);
    expect(await extract('T-01')).toEqual({ success: true, data: {
      taskId: 'T-01',
      taskContent: '### Task T-01: Preserve the source\n\nRead the record.\nKeep its original bytes.\n\n'
        + '**Acceptance:**\n- The source bytes remain exact.\n\n**Files:**\n- docs/identity.md',
    } });
    expect(await extract('T-1')).toEqual({ success: true, data: {
      taskId: 'T-1',
      taskContent: '### Task T-1: Share the snapshot\n\nRead once and pass the snapshot to each consumer.\n\n'
        + '**Acceptance:**\n- Consumers receive one immutable snapshot.\n\n**Files:**\n- src/read.ts\n\n'
        + '**Test files:**\n- tests/read.test.ts',
    } });
    expect(await extract('1')).toMatchObject({
      success: false, error: { code: 'TASK_NOT_FOUND' }, data: { availableTasks: ['T-01', 'T-1'] },
    });
    expect(vi.mocked(readFileSync).mock.calls.filter(([file]) => file === planPath))
      .toEqual([[planPath], [planPath], [planPath]]);
  });

  it('SpecCoverage_ForwardDeclaredProfilePath_PassesWithoutExecution', async () => {
    const paths = ['checks/new-behavior.proofcase', 'checks/new.test.ts'];
    writeFileSync(planPath, record([task('T-01', { testFiles: paths })]));
    const result = await coverage();
    expect(result).toMatchObject({ success: true, data: { passed: true, totalTests: 2, found: 2, malformed: [] } });
    for (const path of paths) {
      expect(result.data?.report).toContain(`Test path well-formed: ${path}`);
      expect(existsSync).not.toHaveBeenCalledWith(join(root, path));
    }
    expect(result.data?.report).not.toContain('checks/legacy.test.ts');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(vi.mocked(readFileSync).mock.calls.filter(([file]) => file === planPath)).toEqual([[planPath]]);
  });

  it('uses the resolved probe for each on-disk typed declaration', async () => {
    const testFiles = ['checks/actual.proofcase', 'checks/actual.test.ts'];
    writeFileSync(join(root, '.exarchos.yml'),
      'verification:\n  tests:\n    globs: ["checks/**/*.proofcase", "checks/**/*.test.ts"]\n'
      + '    probe:\n      command: proof-check run\n      files: as-arguments\n');
    mkdirSync(join(root, 'checks'));
    for (const file of testFiles) writeFileSync(join(root, file), '');
    writeFileSync(planPath, record([task('T-01', { testFiles })]));
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
    expect(await coverage('post-implementation')).toMatchObject({
      success: true, data: { passed: true, totalTests: 2, found: 2, missing: [], malformed: [] },
    });
    expect(vi.mocked(execFileSync).mock.calls.map(([program, args]) => [program, args]))
      .toEqual(testFiles.map((file) => ['proof-check', ['run', file]]));
  });

  it('keeps a typed path outside the resolved globs as malformed in both phases', async () => {
    writeFileSync(planPath, record([task('T-01', { testFiles: ['checks/outside.fixture'] })]));
    for (const phase of ['plan', 'post-implementation'] as const) {
      const result = await coverage(phase, true);
      expect(result).toMatchObject({ success: true, data: {
        passed: false, totalTests: 1, found: 0, missing: [], malformed: ['checks/outside.fixture'],
      } });
      expect(result.data?.report).toContain('no glob of tests.globs matches the path');
    }
    expect(existsSync).not.toHaveBeenCalledWith(join(root, 'checks/outside.fixture'));
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('Adapter_InvalidTypedRecord_NeverProseFallback', async () => {
    const valid = body([task('T-01')]);
    const invalid = [
      fenced('{'),
      fenced(valid.replace('"version":1', '"version":1,"version":1')),
      fenced(valid.replace('"version":1', '"version":2')),
      fenced(valid, 'exarchos-plan-v2'),
      fenced(valid) + fenced(valid),
      fenced(valid).slice(0, -4),
      fenced(valid.replace('"version":1', '"version":1,"unknown":true')),
      fenced(valid.replace('"parallelizable":false,', '').replace(',"parallelizable":false', '')),
    ];
    const prefix = '# Design & Rationale\n### DR-1: Authored requirement\n## Tasks\n' + LEGACY_TASK;
    writeFileSync(planPath, prefix);
    expect(await coverage()).toMatchObject({ success: true, data: { passed: true } });
    expect(await handleExtractTask({ planPath, taskId: 'T-01' }, root)).toMatchObject({ success: true });
    expect(parseTaskStamps(prefix)).toHaveLength(1);

    for (const block of invalid) {
      const text = prefix + block;
      writeFileSync(planPath, text);
      expect(await coverage()).toMatchObject({ success: false, error: { code: 'INVALID_DESIGN_RECORD' } });
      expect(await handleExtractTask({ planPath, taskId: 'T-01' }, root))
        .toMatchObject({ success: false, error: { code: 'INVALID_DESIGN_RECORD' } });
      expect(() => parseTaskStamps(text)).toThrow();
    }
    writeFileSync(planPath, Buffer.concat([Buffer.from(prefix + fenced(valid)), Buffer.from([0xff])]));
    expect(await coverage()).toMatchObject({ success: false, error: { code: 'INVALID_DESIGN_RECORD' } });
    expect(await handleExtractTask({ planPath, taskId: 'T-01' }, root))
      .toMatchObject({ success: false, error: { code: 'INVALID_DESIGN_RECORD' } });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rejects an unsound task outside the selected task and keeps the completeness verdict', async () => {
    writeFileSync(planPath, record([task('T-01'), task('T-1', { implements: ['DR-99'], blockedBy: ['missing'] })]));
    const findings = [{ code: 'UNKNOWN_DEPENDENCY', taskIds: ['T-1', 'missing'] },
      { code: 'UNKNOWN_IMPLEMENTS', taskIds: ['T-1'], requirementIds: ['DR-99'] }];
    for (const result of [await coverage(), await handleExtractTask({ planPath, taskId: 'T-01' }, root)]) {
      expect(result).toMatchObject({ success: false, error: { code: 'INVALID_DESIGN_RECORD' }, data: { findings } });
      expect(toEnvelope(result)).toMatchObject({ success: false, error: {
        code: 'INVALID_DESIGN_RECORD',
        message: 'UNKNOWN_DEPENDENCY: Task T-1 depends on unknown task missing.\n'
          + 'UNKNOWN_IMPLEMENTS: Task T-1 implements unknown requirement DR-99.',
      } });
    }
    expect(() => parseTaskStamps(readFileSync(planPath, 'utf8'))).toThrow('UNKNOWN_DEPENDENCY');
    const completeness = await handleDesignCompleteness({ featureId: 'adapter-test', planPath }, root, store);
    expect(completeness).toMatchObject({ success: true, data: { deprecated: true, passed: false, findings } });

    writeFileSync(planPath, record([task('T-01')]));
    expect(await handleDesignCompleteness({ featureId: 'adapter-test', planPath }, root, store))
      .toMatchObject({ success: true, data: { deprecated: true, passed: true, edges: [{ taskId: 'T-01', requirementId: 'DR-1' }] } });

    writeFileSync(planPath, LEGACY_TASK + fenced('{'));
    expect(await handleDesignCompleteness({ featureId: 'adapter-test', planPath }, root, store))
      .toMatchObject({ success: false, error: { code: 'INVALID_DESIGN_RECORD' } });
  });

  it('preserves generated exact ids and declared fields across task adapters', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2, max: 8 }), fc.boolean(), fc.boolean(), fc.boolean(),
      async (size, reverse, boundary, multiline) => {
        const ids = ['T-01', 'T-1', ...Array.from({ length: size - 2 }, (_, index) => `Task.${index}`)];
        const authored = ids.map((id, index) => task(id, {
          title: `DR-99 title for ${id}`,
          blockedBy: ids.slice(Math.max(0, index - 1), index),
          instructions: multiline ? `Read ${id}.\nConfirm the declaration.` : `Read ${id}.`,
          boundaryTouching: index % 2 === 0 ? boundary : !boundary,
          riskTier: index % 2 === 0 ? 'high' : 'medium',
          testFiles: index % 2 === 0 ? [`checks/${id}.proofcase`, 'checks/shared.test.ts'] : [],
          acceptance: [`Accept ${id}.`],
        }));
        const ordered = reverse ? [...authored].reverse() : authored;
        const text = record(ordered, reverse ? LEGACY_TASK + '### Task 99: Invented\n' : '');
        const stamps = parseTaskStamps(text);
        expect(stamps.map(({ id }) => id)).toEqual(ordered.map(({ id }) => id));
        expect(stampForTask(stamps, '1')).toBeUndefined();
        expect(stampForTask(stamps, '99')).toBeUndefined();
        writeFileSync(planPath, text);
        for (const { id, title, files, blockedBy, riskTier, boundaryTouching, testLayer, instructions, acceptance, testFiles } of ordered) {
          expect(stampForTask(stamps, id)).toMatchObject({ title, files, blockedBy, riskTier, boundaryTouching, testLayer });
          const result = await handleExtractTask({ planPath, taskId: id }, root);
          expect(result).toMatchObject({ success: true, data: { taskId: id } });
          const content = result.data?.taskContent;
          for (const field of [`### Task ${id}: ${title}`, instructions, ...files, ...acceptance, ...testFiles]) {
            expect(content).toContain(field);
          }
        }
        expect(await handleExtractTask({ planPath, taskId: '99' }, root)).toMatchObject({
          success: false, data: { availableTasks: ordered.map(({ id }) => id) },
        });

        const expected = [...new Set(ordered.flatMap(({ testFiles }) => testFiles))];
        const result = await coverage();
        expect(result).toMatchObject({ success: true, data: { passed: true, totalTests: expected.length, found: expected.length } });
        expect(String(result.data?.report).match(/Test path well-formed: [^\n]+/g))
          .toEqual(expected.map((path) => `Test path well-formed: ${path}`));
        expect(readFileSync(planPath, 'utf8')).toBe(text);
      },
    ), { numRuns: 24 });
  });
});
