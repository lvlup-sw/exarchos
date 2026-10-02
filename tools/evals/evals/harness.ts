import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EvalSuiteConfigSchema, type EvalSuiteConfig, type EvalResult, type RunSummary, type AssertionResult } from './types.js';
import { loadDataset } from './dataset-loader.js';
import { createDefaultRegistry, type GraderRegistry } from './graders/index.js';

/**
 * A discovered suite pairs the parsed config with its filesystem location.
 */
export interface DiscoveredSuite {
  config: EvalSuiteConfig;
  suiteDir: string;
}

/**
 * Discovers the eval suites in the subdirectories of `evalsDir` that hold a `suite.json`.
 * It skips a subdirectory without one, and throws on an invalid one.
 */
export async function discoverSuites(
  evalsDir: string,
  filter?: { skill?: string | undefined },
): Promise<DiscoveredSuite[]> {
  const entries = await fs.readdir(evalsDir, { withFileTypes: true });
  const discovered: DiscoveredSuite[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const suiteDir = path.join(evalsDir, entry.name);
    const suiteJsonPath = path.join(suiteDir, 'suite.json');
    let content: string;
    try {
      content = await fs.readFile(suiteJsonPath, 'utf-8');
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Invalid JSON in suite config: ${suiteJsonPath}`);
    }

    const result = EvalSuiteConfigSchema.safeParse(parsed);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      throw new Error(
        `Invalid suite config at ${suiteJsonPath}: ${firstIssue?.path.join('.') ?? '?'} - ${firstIssue?.message ?? 'schema validation failed'}`,
      );
    }

    discovered.push({ config: result.data, suiteDir });
  }

  if (!filter?.skill) {
    return discovered;
  }

  return discovered.filter((s) => s.config.metadata.skill === filter.skill);
}

/**
 * The event store surface that the harness uses, declared here to avoid a circular import.
 * Without `query`, regression detection finds no regressions.
 */
export interface EvalEventStore {
  append(streamId: string, event: Record<string, unknown>): Promise<void>;
  query?(streamId: string, filters?: { type?: string }): Promise<Array<{ type: string; data?: Record<string, unknown> }>>;
}

/**
 * Options for event emission during suite runs.
 */
export interface RunSuiteOptions {
  eventStore?: EvalEventStore;
  streamId?: string;
  trigger?: 'ci' | 'local' | 'scheduled';
  layer?: 'regression' | 'capability' | 'reliability';
}

/** Returns the IDs of the cases that passed in the last completed run of the suite and fail now. */
async function detectRegressions(
  suiteId: string,
  currentResults: EvalResult[],
  eventStore?: EvalEventStore,
  streamId?: string,
): Promise<string[]> {
  if (!eventStore?.query) return [];

  const stream = streamId ?? 'default';
  const events = await eventStore.query(stream);

  const runCompletedEvents = events.filter(
    (e) => e.type === 'eval.run.completed' && e.data?.['suiteId'] === suiteId,
  );

  if (runCompletedEvents.length === 0) return [];

  const lastRun = runCompletedEvents[runCompletedEvents.length - 1];
  const lastRunId = lastRun?.data?.['runId'] as string | undefined;

  if (!lastRunId) return [];

  const previousCaseEvents = events.filter(
    (e) =>
      e.type === 'eval.case.completed' &&
      e.data?.['runId'] === lastRunId &&
      e.data?.['suiteId'] === suiteId,
  );

  const previousResults = new Map<string, boolean>();
  for (const event of previousCaseEvents) {
    const caseId = event.data?.['caseId'] as string | undefined;
    const passed = event.data?.['passed'] as boolean | undefined;
    if (caseId !== undefined && passed !== undefined) {
      previousResults.set(caseId, passed);
    }
  }

  const regressions: string[] = [];
  for (const result of currentResults) {
    const wasPassing = previousResults.get(result.caseId);
    if (wasPassing === true && !result.passed) {
      regressions.push(result.caseId);
    }
  }

  return regressions;
}

/**
 * Runs the cases of a suite against the registered graders. When `options.layer` is set, only cases of
 * that layer run. Each grader gets the case input as the output too, because the cases hold recorded traces.
 *
 * With an event store, it appends `eval.run.started`, one `eval.case.completed` per case, an
 * `eval.judge.calibrated` per assertion with scored results, and `eval.run.completed`.
 * Calibration takes `expected` on an assertion result as the gold label, and `true` when it is absent.
 */
export async function runSuite(
  suite: EvalSuiteConfig,
  _evalsDir: string,
  suiteDir: string,
  graderRegistry: GraderRegistry,
  options?: RunSuiteOptions,
): Promise<RunSummary> {
  const startTime = Date.now();
  const runId = crypto.randomUUID();
  const allResults: EvalResult[] = [];
  const eventStore = options?.eventStore;
  const streamId = options?.streamId ?? 'default';
  const trigger = options?.trigger ?? 'local';

  let totalCaseCount = 0;
  const datasetEntries = Object.entries(suite.datasets);
  const loadedDatasets: Array<{ datasetRef: { path: string; description: string }; cases: Awaited<ReturnType<typeof loadDataset>> }> = [];

  const layerFilter = options?.layer;

  for (const [_datasetName, datasetRef] of datasetEntries) {
    const datasetPath = path.resolve(suiteDir, datasetRef.path);
    let cases = await loadDataset(datasetPath);

    if (layerFilter) {
      cases = cases.filter((c) => c.layer === layerFilter);
    }

    totalCaseCount += cases.length;
    loadedDatasets.push({ datasetRef, cases });
  }

  if (eventStore) {
    await eventStore.append(streamId, {
      type: 'eval.run.started',
      data: {
        runId,
        suiteId: suite.metadata.skill,
        trigger,
        caseCount: totalCaseCount,
      },
    });
  }

  for (const { cases } of loadedDatasets) {
    for (const evalCase of cases) {
      const caseStart = Date.now();
      const assertionResults: AssertionResult[] = [];

      for (const assertion of suite.assertions) {
        const grader = graderRegistry.resolve(assertion.type);
        const gradeResult = await grader.grade(
          evalCase.input,
          evalCase.input,
          evalCase.expected,
          assertion.config,
        );

        const isSkipped = gradeResult.details?.['skipped'] === true;
        const passed = isSkipped || gradeResult.score >= assertion.threshold;
        assertionResults.push({
          name: assertion.name,
          type: assertion.type,
          passed,
          score: gradeResult.score,
          reason: gradeResult.reason,
          threshold: assertion.threshold,
          skipped: isSkipped,
        });
      }

      const casePassed = assertionResults.every((a) => a.passed);
      const scoredAssertions = assertionResults.filter((a) => !a.skipped);
      const caseScore =
        scoredAssertions.length > 0
          ? scoredAssertions.reduce((sum, a) => sum + a.score, 0) / scoredAssertions.length
          : 1.0;
      const caseDuration = Date.now() - caseStart;

      allResults.push({
        caseId: evalCase.id,
        suiteId: suite.metadata.skill,
        passed: casePassed,
        score: caseScore,
        assertions: assertionResults,
        duration: caseDuration,
      });

      if (eventStore) {
        await eventStore.append(streamId, {
          type: 'eval.case.completed',
          data: {
            runId,
            caseId: evalCase.id,
            suiteId: suite.metadata.skill,
            passed: casePassed,
            score: caseScore,
            assertions: assertionResults.map((a) => ({
              name: a.name,
              type: a.type,
              passed: a.passed,
              score: a.score,
              reason: a.reason,
            })),
            duration: caseDuration,
          },
        });
      }
    }
  }

  const totalPassed = allResults.filter((r) => r.passed).length;
  const totalFailed = allResults.filter((r) => !r.passed).length;
  const totalSkipped = allResults.reduce(
    (sum, r) => sum + r.assertions.filter((a) => a.skipped).length, 0,
  );
  const avgScore =
    allResults.length > 0
      ? allResults.reduce((sum, r) => sum + r.score, 0) / allResults.length
      : 0;

  const summary: RunSummary = {
    runId,
    suiteId: suite.metadata.skill,
    total: allResults.length,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    avgScore,
    duration: Date.now() - startTime,
    results: allResults,
  };

  if (eventStore && allResults.length > 0) {
    for (const assertion of suite.assertions) {
      let tp = 0;
      let fp = 0;
      let tn = 0;
      let fn = 0;

      for (const result of allResults) {
        const ar = result.assertions.find((a) => a.name === assertion.name);
        if (!ar || ar.skipped) continue;

        const goldPositive = (ar as Record<string, unknown>).expected !== undefined
          ? Boolean((ar as Record<string, unknown>).expected)
          : true;
        const predicted = ar.passed;

        if (goldPositive && predicted) tp++;
        else if (!goldPositive && predicted) fp++;
        else if (!goldPositive && !predicted) tn++;
        else fn++;
      }

      const total = tp + fp + tn + fn;
      if (total === 0) continue;

      const tpr = (tp + fn) > 0 ? tp / (tp + fn) : 0;
      const tnr = (tn + fp) > 0 ? tn / (tn + fp) : 0;
      const accuracy = total > 0 ? (tp + tn) / total : 0;
      const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
      const recall = tpr;
      const f1 = (precision + recall) > 0
        ? 2 * (precision * recall) / (precision + recall)
        : 0;

      const split = options?.layer === 'capability' ? 'test' : 'validation';

      await eventStore.append(streamId, {
        type: 'eval.judge.calibrated',
        data: {
          skill: suite.metadata.skill,
          rubricName: assertion.name,
          split,
          tpr,
          tnr,
          accuracy,
          f1,
          tp,
          fp,
          tn,
          fn,
          goldStandardVersion: suite.metadata.version,
          rubricVersion: suite.metadata.version,
        },
      });
    }
  }

  const regressions = await detectRegressions(
    suite.metadata.skill,
    allResults,
    eventStore,
    streamId,
  );

  if (eventStore) {
    await eventStore.append(streamId, {
      type: 'eval.run.completed',
      data: {
        runId,
        suiteId: suite.metadata.skill,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        avgScore: summary.avgScore,
        duration: summary.duration,
        regressions,
      },
    });
  }

  return summary;
}

/** Discovers the suites, filtered by `options.skill` when set, and runs each one. */
export async function runAll(
  evalsDir: string,
  options?: { skill?: string; dataset?: string; layer?: 'regression' | 'capability' | 'reliability' } & RunSuiteOptions,
): Promise<RunSummary[]> {
  const discovered = await discoverSuites(evalsDir, { skill: options?.skill });
  const summaries: RunSummary[] = [];

  for (const { config, suiteDir } of discovered) {
    const summary = await runSuite(config, evalsDir, suiteDir, createDefaultRegistry(), options);
    summaries.push(summary);
  }

  return summaries;
}
