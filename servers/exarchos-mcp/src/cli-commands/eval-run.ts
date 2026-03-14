import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runAll } from '../evals/harness.js';
import { formatMultiSuiteReport } from '../evals/reporters/cli-reporter.js';
import { getOrCreateEventStore } from '../views/tools.js';
import type { EvalEventStore } from '../evals/harness.js';
import type { RunSummary } from '../evals/types.js';
import type { CommandResult } from '../cli.js';
import { expandTilde } from '../utils/paths.js';

/**
 * Resolve the evals directory.
 * Checks EVALS_DIR env var first, then walks up from the current file to find the repo root.
 */
export function resolveEvalsDir(): string {
  const envDir = process.env['EVALS_DIR'];
  if (envDir) {
    if (!fs.existsSync(envDir) || !fs.statSync(envDir).isDirectory()) {
      throw new Error(`EVALS_DIR path does not exist or is not a directory: ${envDir}`);
    }
    return envDir;
  }

  // Walk up from this file to find the repo root containing an evals/ directory
  const thisFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(thisFile);

  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'evals');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  throw new Error('Could not find evals/ directory. Set EVALS_DIR environment variable.');
}

/**
 * Handle the eval-run CLI command.
 */
const VALID_LAYERS = ['regression', 'capability', 'reliability'] as const;
type EvalLayer = (typeof VALID_LAYERS)[number];

function isValidLayer(value: unknown): value is EvalLayer {
  return typeof value === 'string' && (VALID_LAYERS as readonly string[]).includes(value);
}

export async function handleEvalRun(
  stdinData: Record<string, unknown>,
  evalsDir: string,
): Promise<CommandResult> {
  const options: { skill?: string; dataset?: string; layer?: EvalLayer } = {};
  const ciMode = stdinData['ci'] === true;

  if (typeof stdinData['skill'] === 'string') {
    options.skill = stdinData['skill'];
  }

  if (isValidLayer(stdinData['layer'])) {
    options.layer = stdinData['layer'];
  }

  // Wire up EventStore for event emission during eval runs
  const stateDir = expandTilde(process.env.WORKFLOW_STATE_DIR ?? path.join(os.homedir(), '.claude', 'workflow-state'));
  const store = getOrCreateEventStore(stateDir);
  const eventStore: EvalEventStore = {
    append: async (streamId, event) => { await store.append(streamId, event as Parameters<typeof store.append>[1]); },
  };
  const trigger = ciMode ? 'ci' as const : 'local' as const;

  let summaries: RunSummary[];
  try {
    summaries = await runAll(evalsDir, { ...options, eventStore, streamId: 'evals', trigger });
  } catch (err: unknown) {
    return {
      error: {
        code: 'RUN_FAILED',
        message: `Failed to run evals: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (summaries.length === 0) {
    return {
      error: {
        code: 'NO_SUITES',
        message: 'No eval suites found in the evals directory.',
      },
    };
  }

  if (ciMode) {
    // CI mode: GitHub Actions annotations to stderr
    const { formatCIReport } = await import('../evals/reporters/ci-reporter.js');
    const ciOutput = formatCIReport(summaries);
    if (ciOutput) {
      process.stderr.write(ciOutput + '\n');
    }
  } else {
    // Local mode: rich terminal output to stderr
    const report = formatMultiSuiteReport(summaries);
    process.stderr.write(report + '\n');
  }

  const totalCases = summaries.reduce((sum, s) => sum + s.total, 0);
  const totalFailures = summaries.reduce((sum, s) => sum + s.failed, 0);
  const allPassed = totalFailures === 0;

  // Capability layer: failures produce warnings but don't block CI
  const isAdvisoryLayer = options.layer === 'capability';
  if (isAdvisoryLayer) {
    return {
      summaries,
      passed: true,
      total: totalCases,
      failures: totalFailures,
      ...(totalFailures > 0
        ? { warning: `${totalFailures}/${totalCases} capability eval cases failed (advisory)` }
        : {}),
    };
  }

  return {
    ...(allPassed
      ? {}
      : {
          error: {
            code: 'EVAL_FAILED',
            message: `${totalFailures}/${totalCases} eval cases failed`,
          },
        }),
    summaries,
    passed: allPassed,
    total: totalCases,
    failures: totalFailures,
  };
}
