import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalSuiteConfigSchema, EvalCaseSchema } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The repository root, four levels above this directory. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SUITE_DIR = path.join(REPO_ROOT, 'tests', 'evals', 'reliability');

const REQUIRED_CATEGORIES = ['stall', 'loop', 'budget', 'phase', 'recovery', 'compaction'];

describe('reliability eval suite', () => {
  it('reliabilitySuite_ConfigValid_ParsesWithEvalSuiteConfigSchema', () => {
    const configPath = path.join(SUITE_DIR, 'suite.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    const result = EvalSuiteConfigSchema.safeParse(parsed);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata.skill).toBe('reliability');
      expect(result.data.description).toContain('reliability');
    }
  });

  it('reliabilitySuite_AllDatasets_ParseAsValidEvalCases', () => {
    const configPath = path.join(SUITE_DIR, 'suite.json');
    const config = EvalSuiteConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf-8')));

    for (const [_name, dataset] of Object.entries(config.datasets)) {
      const datasetPath = path.resolve(SUITE_DIR, dataset.path);
      const content = fs.readFileSync(datasetPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      expect(lines.length).toBeGreaterThan(0);

      for (let i = 0; i < lines.length; i++) {
        const parsed = JSON.parse(lines[i]);
        const result = EvalCaseSchema.safeParse(parsed);
        expect(result.success, `Line ${i + 1} failed validation: ${JSON.stringify(result.error?.issues)}`).toBe(true);
      }
    }
  });

  it('reliabilitySuite_AllCases_HaveReliabilityLayer', () => {
    const configPath = path.join(SUITE_DIR, 'suite.json');
    const config = EvalSuiteConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf-8')));

    for (const [_name, dataset] of Object.entries(config.datasets)) {
      const datasetPath = path.resolve(SUITE_DIR, dataset.path);
      const content = fs.readFileSync(datasetPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      for (let i = 0; i < lines.length; i++) {
        const evalCase = EvalCaseSchema.parse(JSON.parse(lines[i]));
        expect(evalCase.layer, `Case ${evalCase.id} at line ${i + 1} missing layer: reliability`).toBe('reliability');
      }
    }
  });

  it('reliabilitySuite_CoversSixCategories_StallLoopBudgetPhaseRecoveryCompaction', () => {
    const configPath = path.join(SUITE_DIR, 'suite.json');
    const config = EvalSuiteConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, 'utf-8')));

    const foundCategories = new Set<string>();

    for (const [_name, dataset] of Object.entries(config.datasets)) {
      const datasetPath = path.resolve(SUITE_DIR, dataset.path);
      const content = fs.readFileSync(datasetPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      for (const line of lines) {
        const evalCase = EvalCaseSchema.parse(JSON.parse(line));
        for (const tag of evalCase.tags) {
          if (REQUIRED_CATEGORIES.includes(tag)) {
            foundCategories.add(tag);
          }
        }
      }
    }

    for (const category of REQUIRED_CATEGORIES) {
      expect(foundCategories.has(category), `Missing category: ${category}`).toBe(true);
    }
    expect(foundCategories.size).toBe(6);
  });
});
