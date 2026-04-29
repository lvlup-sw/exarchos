#!/usr/bin/env tsx
/**
 * Codegen for `src/runtimes/runtimes.generated.ts`.
 *
 * Reads every `runtimes/*.yaml` at repo root, parses + validates each via
 * `RuntimeMapSchema`, and emits a single TypeScript module that exports
 * the validated maps as a frozen `Record<string, RuntimeMap>`.
 *
 * Why a codegen step instead of `import yaml with { type: 'text' }`:
 * Bun's text-import attribute survives `bun build --compile`, but Node
 * (which runs vitest + tsc) rejects YAML imports with
 * ERR_UNKNOWN_FILE_EXTENSION. Tests would have to migrate to Bun. A
 * generated `.ts` module is bundled by both runtimes uniformly.
 *
 * Implements: DR-7 (install-skills CLI), task 1.3 of the v2.9.0 closeout
 * (#1201).
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAllRuntimes, REQUIRED_RUNTIME_NAMES } from '../src/runtimes/load.js';

const REPO_ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');
const RUNTIMES_DIR = resolve(REPO_ROOT, 'runtimes');
const OUTPUT_PATH = resolve(REPO_ROOT, 'src/runtimes/runtimes.generated.ts');

function generate(): void {
  const runtimes = loadAllRuntimes(RUNTIMES_DIR);

  // Map by name so the generated file's order is deterministic
  // (REQUIRED_RUNTIME_NAMES order, then any extras alphabetically).
  const byName = new Map(runtimes.map((r) => [r.name, r]));
  const ordered: typeof runtimes = [];
  for (const name of REQUIRED_RUNTIME_NAMES) {
    const found = byName.get(name);
    if (!found) {
      throw new Error(`generate-runtimes: required runtime "${name}" missing from ${RUNTIMES_DIR}`);
    }
    ordered.push(found);
    byName.delete(name);
  }
  // Stable trailing order for any non-required extras.
  const extras = Array.from(byName.keys()).sort();
  for (const name of extras) {
    const r = byName.get(name);
    if (r) ordered.push(r);
  }

  const entries = ordered
    .map((r) => `  ${JSON.stringify(r.name)}: ${JSON.stringify(r, null, 2).replace(/\n/g, '\n  ')}`)
    .join(',\n');

  const banner = `/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * Source: runtimes/*.yaml at repo root.
 * Regenerate: \`npm run generate:runtimes\`.
 *
 * Bundled into the compiled \`exarchos\` binary so the
 * \`exarchos install-skills\` subcommand can resolve the target runtime
 * without any on-disk YAML at user-install time.
 */

import type { RuntimeMap } from './types.js';

export const EMBEDDED_RUNTIMES: Readonly<Record<string, RuntimeMap>> = Object.freeze({
${entries},
});
`;

  writeFileSync(OUTPUT_PATH, banner, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`generate-runtimes: wrote ${ordered.length} runtimes → ${OUTPUT_PATH}`);
}

generate();
