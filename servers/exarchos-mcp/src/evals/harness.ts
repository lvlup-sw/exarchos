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
 * Discover eval suites by scanning for suite.json files in subdirectories.
 */
export async function discoverSuites(
  evalsDir: string,
  filter?: { skill?: string },
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
        continue; // No suite.json in this directory
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
        `Invalid suite config at ${suiteJsonPath}: ${firstIssue.path.join('.')} - ${firstIssue.message}`,
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
 * Run all cases in a suite against the registered graders.
 */
export async function runSuite(
  suite: EvalSuiteConfig,
  _evalsDir: string,
  suiteDir: string,
  graderRegistry: GraderRegistry,
): Promise<RunSummary> {
  const startTime = Date.now();
  const allResults: EvalResult[] = [];

  for (const [_datasetName, datasetRef] of Object.entries(suite.datasets)) {
    const datasetPath = path.resolve(suiteDir, datasetRef.path);
    const cases = await loadDataset(datasetPath);

    for (const evalCase of cases) {
      const caseStart = Date.now();
      const assertionResults: AssertionResult[] = [];

      for (const assertion of suite.assertions) {
        const grader = graderRegistry.resolve(assertion.type);
        const gradeResult = await grader.grade(
          evalCase.input,
          evalCase.input, // Phase 1: output = input (recorded traces)
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

      allResults.push({
        caseId: evalCase.id,
        suiteId: suite.metadata.skill,
        passed: casePassed,
        score: caseScore,
        assertions: assertionResults,
        duration: Date.now() - caseStart,
      });
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

  return {
    runId: crypto.randomUUID(),
    suiteId: suite.metadata.skill,
    total: allResults.length,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    avgScore,
    duration: Date.now() - startTime,
    results: allResults,
  };
}

/**
 * Discover and run all suites, with optional filtering.
 */
export async function runAll(
  evalsDir: string,
  options?: { skill?: string; dataset?: string },
): Promise<RunSummary[]> {
  const discovered = await discoverSuites(evalsDir, { skill: options?.skill });
  const summaries: RunSummary[] = [];

  for (const { config, suiteDir } of discovered) {
    const summary = await runSuite(config, evalsDir, suiteDir, createDefaultRegistry());
    summaries.push(summary);
  }

  return summaries;
}
