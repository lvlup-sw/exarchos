#!/usr/bin/env node
/**
 * Standalone entrypoint for the Eval Gate workflow (`.github/workflows/eval-gate.yml`).
 *
 * It reads one JSON object of run options from stdin, calls `runAll()` on the evals directory, and writes
 * the report to stderr. The exit code is 1 when a case fails or no suite runs. A `capability` run exits 0
 * even when cases fail.
 *
 * stdin shape (all fields optional). `ci` selects CI annotations, and `skill` limits the run to one skill:
 *   {
 *     "ci"?: boolean,
 *     "skill"?: string,
 *     "layer"?: "regression" | "capability" | "reliability"
 *   }
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAll } from './harness.js';
import type { EvalEventStore } from './harness.js';
import type { RunSummary } from './types.js';
import { formatMultiSuiteReport } from './reporters/cli-reporter.js';
import { EventStore } from '../../../src/events/store.js';
import { resolveStateDir } from '../../../src/utils/paths.js';

const VALID_LAYERS = ['regression', 'capability', 'reliability'] as const;
type EvalLayer = (typeof VALID_LAYERS)[number];

function isValidLayer(value: unknown): value is EvalLayer {
  return typeof value === 'string' && (VALID_LAYERS as readonly string[]).includes(value);
}

function resolveEvalsDir(): string {
  const envDir = process.env['EVALS_DIR'];
  if (envDir) {
    if (!fs.existsSync(envDir) || !fs.statSync(envDir).isDirectory()) {
      throw new Error(`EVALS_DIR path does not exist or is not a directory: ${envDir}`);
    }
    return envDir;
  }
  const thisFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(thisFile);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'evals');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find evals/ directory. Set EVALS_DIR environment variable.');
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (raw.length === 0) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stdin must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Runs the suites and returns the exit code. The CLI is its own process, so it opens its own `EventStore`. */
async function main(): Promise<number> {
  const stdinData = await readStdinJson();
  const ciMode = stdinData['ci'] === true;
  const options: { skill?: string; layer?: EvalLayer } = {};
  if (typeof stdinData['skill'] === 'string') {
    options.skill = stdinData['skill'];
  }
  if (isValidLayer(stdinData['layer'])) {
    options.layer = stdinData['layer'];
  }

  const evalsDir = resolveEvalsDir();
  const stateDir = resolveStateDir();
  const store = new EventStore(stateDir);
  await store.initialize();
  const eventStore: EvalEventStore = {
    append: async (streamId, event) => {
      await store.append(streamId, event as Parameters<typeof store.append>[1]);
    },
  };

  let summaries: RunSummary[];
  try {
    summaries = await runAll(evalsDir, {
      ...options,
      eventStore,
      streamId: 'evals',
      trigger: ciMode ? 'ci' : 'local',
    });
  } catch (err: unknown) {
    process.stderr.write(
      `Failed to run evals: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (summaries.length === 0) {
    process.stderr.write('No eval suites found in the evals directory.\n');
    return 1;
  }

  if (ciMode) {
    const { formatCIReport } = await import('./reporters/ci-reporter.js');
    const ciOutput = formatCIReport(summaries);
    if (ciOutput) process.stderr.write(ciOutput + '\n');
  } else {
    process.stderr.write(formatMultiSuiteReport(summaries) + '\n');
  }

  const totalFailures = summaries.reduce((sum, s) => sum + s.failed, 0);
  const isAdvisoryLayer = options.layer === 'capability';
  if (isAdvisoryLayer || totalFailures === 0) return 0;
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `eval-run failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
