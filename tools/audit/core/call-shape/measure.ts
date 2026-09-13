// Measures the prescribed call shape from the live tree and writes, or checks,
// the checked-in census and its summary.
//
// Usage:
//   npx tsx tools/audit/core/call-shape/measure.ts           # write
//   npx tsx tools/audit/core/call-shape/measure.ts --check   # verify; exit 1 on drift
//
// The output carries no timestamp and no commit, so an unchanged tree
// reproduces it byte for byte. Every file it reads is pinned by digest inside
// the census, so an edit to a pinned skill fails the drift guard until the
// census is regenerated and its diff read.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import {
  buildCallShapeCensus,
  renderCallShapeSummary,
  serializeCallShapeCensus,
  type CallShapeCensus,
  type CensusInputs,
} from './census.js';
import type { RegistrySnapshot, RegistryTool } from './extract.js';
import { CALL_SHAPE_MODEL } from './intent-models.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const CALL_SHAPE_BASELINE = 'tools/audit/core/call-shape/call-shape-census.json';
export const CALL_SHAPE_SUMMARY = 'tools/audit/core/call-shape/call-shape-census.md';
export const CALL_SHAPE_REGENERATE = 'npx tsx tools/audit/core/call-shape/measure.ts';

const REGISTRY_SNAPSHOT = 'tools/audit/registered-actions-snapshot.json';
const CONTRACT_LOCK = 'src/contract/contract-authority.lock.json';
const RUNBOOK_DEFINITIONS = 'src/runbooks/definitions.ts';

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const inner: unknown = Reflect.get(value, key);
  return inner;
}

function readRegistry(text: string): RegistrySnapshot {
  const parsed: unknown = JSON.parse(text);
  const counts = field(parsed, 'counts');
  const count = (key: string): number => {
    const value = field(counts, key);
    if (typeof value !== 'number') throw new Error(`${REGISTRY_SNAPSHOT}: counts.${key} is not a number`);
    return value;
  };
  const tools = field(parsed, 'tools');
  if (!Array.isArray(tools)) throw new Error(`${REGISTRY_SNAPSHOT}: tools is not an array`);
  const parsedTools: RegistryTool[] = tools.map((tool: unknown, index: number) => {
    const name = field(tool, 'name');
    const hidden = field(tool, 'hidden');
    const actions = field(tool, 'actions');
    if (
      typeof name !== 'string' ||
      typeof hidden !== 'boolean' ||
      !Array.isArray(actions) ||
      !actions.every((action: unknown): action is string => typeof action === 'string')
    ) {
      throw new Error(`${REGISTRY_SNAPSHOT}: tools[${index}] is malformed`);
    }
    return { name, hidden, actions };
  });
  return {
    counts: { tools: count('tools'), visibleTools: count('visibleTools'), actions: count('actions') },
    tools: parsedTools,
  };
}

function readActionIdRegistryDigest(text: string): string | null {
  const parsed: unknown = JSON.parse(text);
  const digest = field(field(field(parsed, 'authorities'), 'action-id-registry'), 'digest');
  return typeof digest === 'string' ? digest : null;
}

export function readLiveCallShapeInputs(root: string = REPO_ROOT): CensusInputs {
  const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
  const pinnedFiles: Record<string, string> = {};
  for (const file of [...Object.values(CALL_SHAPE_MODEL.sources), RUNBOOK_DEFINITIONS]) {
    pinnedFiles[file] = read(file);
  }
  return {
    pinnedFiles,
    runbooks: ALL_RUNBOOKS,
    runbookSource: RUNBOOK_DEFINITIONS,
    registry: readRegistry(read(REGISTRY_SNAPSHOT)),
    registrySource: REGISTRY_SNAPSHOT,
    contractLockSource: CONTRACT_LOCK,
    actionIdRegistryDigest: readActionIdRegistryDigest(read(CONTRACT_LOCK)),
  };
}

export interface MeasuredCallShape {
  readonly census: CallShapeCensus;
  readonly errors: readonly string[];
  readonly json: string;
  readonly markdown: string;
}

export function measureLiveCallShape(root: string = REPO_ROOT): MeasuredCallShape {
  const { census, errors } = buildCallShapeCensus(readLiveCallShapeInputs(root), CALL_SHAPE_MODEL);
  return { census, errors, json: serializeCallShapeCensus(census), markdown: renderCallShapeSummary(census) };
}

function main(args: readonly string[]): number {
  const measured = measureLiveCallShape();
  if (measured.errors.length > 0) {
    console.error(
      `call-shape census refused (${measured.errors.length}):\n${measured.errors.map((error) => `  - ${error}`).join('\n')}`,
    );
    return 2;
  }
  const targets: readonly { readonly rel: string; readonly content: string }[] = [
    { rel: CALL_SHAPE_BASELINE, content: measured.json },
    { rel: CALL_SHAPE_SUMMARY, content: measured.markdown },
  ];
  if (args.includes('--check')) {
    const drifted = targets.filter(({ rel, content }) => {
      try {
        return readFileSync(path.join(REPO_ROOT, rel), 'utf8') !== content;
      } catch {
        return true;
      }
    });
    for (const { rel } of drifted) {
      console.error(`drift: ${rel} does not match the live tree; regenerate with ${CALL_SHAPE_REGENERATE}`);
    }
    return drifted.length === 0 ? 0 : 1;
  }
  for (const { rel, content } of targets) writeFileSync(path.join(REPO_ROOT, rel), content);
  console.log(`wrote ${targets.map(({ rel }) => rel).join(' and ')}`);
  return 0;
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedAs)).href) {
  process.exitCode = main(process.argv.slice(2));
}
