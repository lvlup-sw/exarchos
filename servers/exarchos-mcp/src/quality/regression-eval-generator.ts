// ─── Regression Eval Generator ───────────────────────────────────────────────
//
// Generates and persists regression eval cases from detected quality regressions.
// Cases are written to `evals/{skill}/datasets/auto-regression.jsonl` in valid
// JSONL format, with duplicate detection by caseId.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalCase } from '../evals/types.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface GeneratedRegressionCase {
  readonly caseId: string;
  readonly skill: string;
  readonly evalCase: EvalCase;
}

export interface WriteResult {
  readonly written: boolean;
  readonly path: string;
  readonly reason?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isDuplicate(existingContent: string, caseId: string): boolean {
  const lines = existingContent.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { id?: string };
      if (parsed.id === caseId) return true;
    } catch {
      // Skip malformed lines
    }
  }
  return false;
}

// ─── File Writer ────────────────────────────────────────────────────────────

export async function writeAutoRegressionCase(
  generatedCase: GeneratedRegressionCase,
  evalsDir: string,
): Promise<WriteResult> {
  const datasetDir = join(evalsDir, generatedCase.skill, 'datasets');
  const filePath = join(datasetDir, 'auto-regression.jsonl');

  // Ensure directory exists
  await mkdir(datasetDir, { recursive: true });

  // Read existing content for duplicate check
  let existingContent = '';
  try {
    existingContent = await readFile(filePath, 'utf-8');
  } catch {
    // File does not exist yet — that's fine
  }

  // Check for duplicate by caseId (mapped to evalCase.id)
  if (existingContent && isDuplicate(existingContent, generatedCase.caseId)) {
    return { written: false, path: filePath, reason: 'duplicate: case already exists in dataset' };
  }

  // Append the eval case as a JSON line
  const jsonLine = JSON.stringify(generatedCase.evalCase) + '\n';
  const newContent = existingContent.endsWith('\n') || existingContent === ''
    ? existingContent + jsonLine
    : existingContent + '\n' + jsonLine;

  await writeFile(filePath, newContent, 'utf-8');

  return { written: true, path: filePath };
}
