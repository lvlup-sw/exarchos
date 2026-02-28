import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getOrCreateEventStore } from '../views/tools.js';
import { captureTrace } from '../evals/trace-capture.js';
import { loadDataset } from '../evals/dataset-loader.js';
import { isDuplicate } from '../evals/deduplication.js';
import { EvalSuiteConfigSchema } from '../evals/types.js';
import type { EvalCase } from '../evals/types.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { CommandResult } from '../cli.js';

// ─── Promote Logic ───────────────────────────────────────────────────────────

/**
 * Increment the patch component of a semver string.
 * e.g. "1.2.3" -> "1.2.4"
 */
function incrementPatchVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length !== 3) return version;
  const patch = parseInt(parts[2], 10);
  if (Number.isNaN(patch)) return version;
  return `${parts[0]}.${parts[1]}.${patch + 1}`;
}

/**
 * Handle the promote sub-command: promote triaged trace cases into a
 * suite's dataset JSONL file.
 */
async function handlePromote(
  stdinData: Record<string, unknown>,
): Promise<CommandResult> {
  const promotePath = stdinData['promote'] as string;
  const suiteName = stdinData['suite'];
  const datasetName = stdinData['dataset'];
  const ids = stdinData['ids'];
  const evalsDir = stdinData['evalsDir'];

  // Validate required fields
  if (typeof suiteName !== 'string' || suiteName.length === 0) {
    return {
      error: {
        code: 'MISSING_SUITE',
        message: 'Required field "suite" is missing or empty.',
      },
    };
  }

  if (typeof datasetName !== 'string' || datasetName.length === 0) {
    return {
      error: {
        code: 'MISSING_DATASET',
        message: 'Required field "dataset" is missing or empty.',
      },
    };
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    return {
      error: {
        code: 'MISSING_IDS',
        message: 'Required field "ids" must be a non-empty array of case IDs.',
      },
    };
  }

  if (typeof evalsDir !== 'string' || evalsDir.length === 0) {
    return {
      error: {
        code: 'MISSING_EVALS_DIR',
        message: 'Required field "evalsDir" is missing or empty.',
      },
    };
  }

  // Locate suite directory and config
  const suiteDir = path.join(evalsDir, suiteName);
  const suiteJsonPath = path.join(suiteDir, 'suite.json');

  let suiteRaw: string;
  try {
    suiteRaw = await fs.readFile(suiteJsonPath, 'utf-8');
  } catch {
    return {
      error: {
        code: 'SUITE_NOT_FOUND',
        message: `Suite "${suiteName}" not found at ${suiteJsonPath}.`,
      },
    };
  }

  const parseResult = EvalSuiteConfigSchema.safeParse(JSON.parse(suiteRaw));
  if (!parseResult.success) {
    return {
      error: {
        code: 'INVALID_SUITE_CONFIG',
        message: `Invalid suite.json: ${parseResult.error.issues[0].message}`,
      },
    };
  }

  const suiteConfig = parseResult.data;
  const datasetRef = suiteConfig.datasets[datasetName];
  if (!datasetRef) {
    return {
      error: {
        code: 'DATASET_NOT_FOUND',
        message: `Dataset "${datasetName}" not found in suite "${suiteName}".`,
      },
    };
  }

  const datasetPath = path.resolve(suiteDir, datasetRef.path);

  // Load candidates from the promote file
  let candidates: EvalCase[];
  try {
    candidates = await loadDataset(promotePath);
  } catch {
    return {
      error: {
        code: 'INVALID_CANDIDATES',
        message: `Failed to load candidates from "${promotePath}".`,
      },
    };
  }

  // Filter candidates by provided IDs (validate all are strings)
  if (!ids.every((id): id is string => typeof id === 'string')) {
    return {
      error: {
        code: 'INVALID_IDS',
        message: 'All IDs must be strings.',
      },
    };
  }
  const idSet = new Set(ids);
  const selected = candidates.filter((c) => idSet.has(c.id));

  // Load existing dataset for deduplication
  let existing: EvalCase[] = [];
  try {
    const content = await fs.readFile(datasetPath, 'utf-8');
    if (content.trim().length > 0) {
      existing = await loadDataset(datasetPath);
    }
  } catch {
    // Dataset file may not exist yet — that's fine, start empty
  }

  // Filter out duplicates and assign the correct layer tag
  const toPromote: EvalCase[] = [];
  let skipped = 0;

  for (const candidate of selected) {
    if (isDuplicate(candidate, existing)) {
      skipped++;
      continue;
    }
    // Override layer to match the dataset name (regression, capability, etc.)
    const validLayers = ['regression', 'capability', 'reliability'] as const;
    const layer = validLayers.includes(datasetName as typeof validLayers[number])
      ? (datasetName as EvalCase['layer'])
      : 'regression';
    toPromote.push({ ...candidate, layer });
  }

  // Append to dataset
  if (toPromote.length > 0) {
    const appendContent = toPromote.map((c) => JSON.stringify(c)).join('\n') + '\n';
    await fs.appendFile(datasetPath, appendContent, 'utf-8');
  }

  // Increment suite metadata version
  if (toPromote.length > 0) {
    const updatedConfig = {
      ...suiteConfig,
      metadata: {
        ...suiteConfig.metadata,
        version: incrementPatchVersion(suiteConfig.metadata.version),
      },
    };
    await fs.writeFile(suiteJsonPath, JSON.stringify(updatedConfig, null, 2) + '\n', 'utf-8');
  }

  return {
    promoted: toPromote.length,
    skipped,
    suite: suiteName,
    dataset: datasetName,
    message: `Promoted ${toPromote.length} case(s) to ${suiteName}/${datasetName} (${skipped} skipped as duplicates).`,
  };
}

// ─── Main Handler ────────────────────────────────────────────────────────────

/**
 * Handle the eval-capture CLI command.
 *
 * Captures workflow event traces from an event stream and converts them
 * into EvalCase JSONL files suitable for regression testing.
 *
 * When the "promote" field is present, promotes triaged trace cases
 * from a candidates file into a suite's dataset.
 */
export async function handleEvalCapture(
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<CommandResult> {
  // Route to promote sub-command if the "promote" field is present
  if (typeof stdinData['promote'] === 'string' && stdinData['promote'].length > 0) {
    return handlePromote(stdinData);
  }

  const stream = stdinData['stream'];
  if (typeof stream !== 'string' || stream.length === 0) {
    return {
      error: {
        code: 'MISSING_STREAM',
        message: 'Required field "stream" (event stream ID) is missing or empty.',
      },
    };
  }

  const skill = typeof stdinData['skill'] === 'string' ? stdinData['skill'] : undefined;
  const output = typeof stdinData['output'] === 'string' ? stdinData['output'] : undefined;

  // Query events from the event store
  const store = getOrCreateEventStore(stateDir);
  const events = await store.query(stream) as WorkflowEvent[];

  // Capture traces
  const cases = captureTrace(events, { skill });

  if (cases.length === 0) {
    return {
      captured: 0,
      message: 'No traces captured from the stream.',
    };
  }

  // Write JSONL output
  const jsonlContent = cases.map((c) => JSON.stringify(c)).join('\n') + '\n';

  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, jsonlContent, 'utf-8');
  } else {
    process.stdout.write(jsonlContent);
  }

  return {
    captured: cases.length,
    output: output ?? '(stdout)',
    message: `Captured ${cases.length} eval case(s) from stream "${stream}".`,
  };
}
