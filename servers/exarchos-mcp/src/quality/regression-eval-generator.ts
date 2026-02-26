// ─── Regression Eval Generator ──────────────────────────────────────────────
//
// Generates eval cases from detected regressions. When a quality regression
// is detected with sufficient confidence, this module creates a structured
// eval case that can be added to the regression test suite.
// ────────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QualityRegression } from '../views/code-quality-view.js';
import type { SignalConfidence } from './calibrated-correlation.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export type { SignalConfidence } from './calibrated-correlation.js';

export interface RegressionTrace {
  readonly gate: string;
  readonly skill: string;
  readonly failureReason: string;
  readonly commit: string;
}

export interface GeneratedRegressionCase {
  readonly caseId: string;
  readonly source: 'auto-generated';
  readonly skill: string;
  readonly gate: string;
  readonly regression: QualityRegression;
  readonly traces: ReadonlyArray<RegressionTrace>;
  readonly generatedAt: string;
  readonly confidence: SignalConfidence;
}

export interface GenerateRegressionEvalInput {
  readonly regression: QualityRegression;
  readonly traces: ReadonlyArray<RegressionTrace>;
  readonly confidence: SignalConfidence;
}

// ─── Generator ─────────────────────────────────────────────────────────────

/**
 * Generate a regression eval case from a detected regression.
 *
 * Only generates when confidence is at least 'medium'.
 * Returns null when confidence is too low.
 */
export function generateRegressionEval(
  input: GenerateRegressionEvalInput,
): GeneratedRegressionCase | null {
  if (input.confidence === 'low') return null;

  const caseId = `auto-${input.regression.skill}-${input.regression.gate}-${Date.now()}`;

  return {
    caseId,
    source: 'auto-generated',
    skill: input.regression.skill,
    gate: input.regression.gate,
    regression: input.regression,
    traces: input.traces,
    generatedAt: new Date().toISOString(),
    confidence: input.confidence,
  };
}

// ─── File Writer ───────────────────────────────────────────────────────────

/**
 * Write an auto-generated regression case to a JSONL file.
 * Creates the directory if it doesn't exist.
 */
export async function writeAutoRegressionCase(
  evalCase: GeneratedRegressionCase,
  outputDir: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const filename = `${evalCase.caseId}.jsonl`;
  const filepath = join(outputDir, filename);
  const line = JSON.stringify(evalCase) + '\n';

  await writeFile(filepath, line, 'utf-8');

  return filepath;
}
