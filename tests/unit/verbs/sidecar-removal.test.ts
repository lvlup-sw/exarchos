// A structural guard for the removed YAML gate-sidecar layer. SQLite is the authoritative
// structured record, so markdown parsing is the permanent path of the authoring gates.
// The test fails when a source file under `src/verbs` references a removed sidecar module
// or symbol, or the emit script that never existed.
//
// The forbidden strings and file names come from fragments at runtime, so they never appear
// verbatim in this file. Thus the repo-wide grep for dangling references finds no hits here.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = fileURLToPath(new URL('../../../src/verbs/', import.meta.url));

/** The literal "sidecar", built from fragments. */
const sc = 'side' + 'car';

/** Symbols and paths that must not appear under `src/verbs`. */
const FORBIDDEN_TOKENS = [
  `${sc}:emit`,
  /** The token holds no directory, so it matches an import from any path. */
  `${sc}-lookup`,
  `from './${sc}-schemas`,
  `loadDesign${sc[0].toUpperCase()}${sc.slice(1)}`,
  `loadPlan${sc[0].toUpperCase()}${sc.slice(1)}`,
  `Design${sc[0].toUpperCase()}${sc.slice(1)}V1`,
  `Plan${sc[0].toUpperCase()}${sc.slice(1)}V1`,
  `evaluateDesign${sc[0].toUpperCase()}${sc.slice(1)}`,
  `evaluatePlanCoverageFrom${sc[0].toUpperCase()}${sc.slice(1)}s`,
  `evaluateProvenanceFrom${sc[0].toUpperCase()}${sc.slice(1)}s`,
  `evaluateTaskDecompositionFrom${sc[0].toUpperCase()}${sc.slice(1)}`,
  'build' + 'DeprecationMessage',
] as const;

/** Collect every `.ts` file under `dir`, recursively. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('sidecar layer removal (#1494)', () => {
  it('no file under src/verbs references the deleted sidecar layer', () => {
    const files = collectTsFiles(here);
    const candidates = files.filter((f) => !f.endsWith('sidecar-removal.test.ts'));

    const offenders: string[] = [];
    for (const file of candidates) {
      const contents = readFileSync(file, 'utf-8');
      for (const token of FORBIDDEN_TOKENS) {
        if (contents.includes(token)) {
          offenders.push(`${file} contains "${token}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the deleted sidecar module files no longer exist', () => {
    const names = readdirSync(here);
    const deleted = [
      `${sc}-lookup.ts`,
      `${sc}-schemas.ts`,
      `${sc}-lookup.test.ts`,
      `${sc}-consumption.test.ts`,
      `${sc}-backfill.test.ts`,
      `${sc}-schemas.test.ts`,
    ];
    for (const name of deleted) {
      expect(names).not.toContain(name);
    }
  });
});
