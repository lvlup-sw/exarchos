/**
 * Tests for `tools/release/codegen-runtimes.ts`, the codegen for the embedded runtimes module.
 *
 * The codegen must hold three invariants:
 *   1. The output holds each required runtime. If not, `install-skills --agent <name>`
 *      fails in the compiled binary.
 *   2. Two runs on the same input write the same bytes. If not, `runtimes:guard` oscillates in CI.
 *   3. Each embedded entry parses with `RuntimeMapSchema`.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderEmbeddedRuntimesModule,
  generateEmbeddedRuntimesModule,
  sortRuntimes,
} from '../../tools/release/codegen-runtimes.js';
import { loadAllRuntimes, REQUIRED_RUNTIME_NAMES } from '../../src/install/runtimes/load.js';
import { RuntimeMapSchema } from '../../src/install/runtimes/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const RUNTIMES_DIR = join(REPO_ROOT, 'content/harness/runtimes');

/**
 * Copies the real runtime YAML files into a new temporary directory. The codegen
 * input then stays stable when a concurrent test changes the workspace.
 */
function makeRuntimesFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codegen-runtimes-'));
  for (const file of readdirSync(RUNTIMES_DIR)) {
    if (file.endsWith('.yaml') || file.endsWith('.yml')) {
      copyFileSync(join(RUNTIMES_DIR, file), join(dir, file));
    }
  }
  return dir;
}

describe('codegen-runtimes', () => {
  /** A coarse check: each required name appears in the emitted source. */
  it('EmbeddedRuntimes_AllRequiredNames_Present', () => {
    const fixture = makeRuntimesFixture();
    const outFile = join(mkdtempSync(join(tmpdir(), 'codegen-out-')), 'embedded.ts');
    generateEmbeddedRuntimesModule({ runtimesDir: fixture, outFile });

    const source = readFileSync(outFile, 'utf8');
    for (const name of REQUIRED_RUNTIME_NAMES) {
      expect(source).toContain(`"name": "${name}"`);
    }
  });

  it('EmbeddedRuntimes_OutputDeterministic_TwoRunsByteIdentical', () => {
    const fixture = makeRuntimesFixture();
    const outA = join(mkdtempSync(join(tmpdir(), 'codegen-out-a-')), 'embedded.ts');
    const outB = join(mkdtempSync(join(tmpdir(), 'codegen-out-b-')), 'embedded.ts');

    generateEmbeddedRuntimesModule({ runtimesDir: fixture, outFile: outA });
    generateEmbeddedRuntimesModule({ runtimesDir: fixture, outFile: outB });

    expect(readFileSync(outA, 'utf8')).toEqual(readFileSync(outB, 'utf8'));
  });

  /**
   * `loadAllRuntimes` validates each entry. The test parses each sorted entry
   * again with `RuntimeMapSchema`. The render step serializes those sorted entries.
   */
  it('EmbeddedRuntimes_ParsesViaRuntimeMapSchema_NoFailures', () => {
    const runtimes = loadAllRuntimes(RUNTIMES_DIR);
    expect(runtimes.length).toBeGreaterThan(0);

    const sorted = sortRuntimes(runtimes);
    for (const rt of sorted) {
      const parsed = RuntimeMapSchema.safeParse(rt);
      expect(parsed.success, `runtime ${rt.name} failed schema parse`).toBe(true);
    }
  });

  /**
   * The runtimes directory holds no extra runtime, so the test adds a synthetic
   * one to reach the extras branch. The required runtimes come first, in
   * `REQUIRED_RUNTIME_NAMES` order. The synthetic name sorts before any plausible extra.
   */
  it('EmbeddedRuntimes_SortOrder_RequiredFirstThenExtras', () => {
    const real = loadAllRuntimes(RUNTIMES_DIR);
    const extra = { ...real[0]!, name: 'aardvark-extra' };
    const sorted = sortRuntimes([...real, extra]);

    for (let i = 0; i < REQUIRED_RUNTIME_NAMES.length; i++) {
      expect(sorted[i]?.name).toBe(REQUIRED_RUNTIME_NAMES[i]);
    }
    expect(sorted[REQUIRED_RUNTIME_NAMES.length]?.name).toBe('aardvark-extra');
  });

  it('renderEmbeddedRuntimesModule_EmitsHeaderAndExports', () => {
    const runtimes = loadAllRuntimes(RUNTIMES_DIR);
    const source = renderEmbeddedRuntimesModule(runtimes);
    expect(source).toContain('GENERATED FILE');
    expect(source).toContain('export const EMBEDDED_RUNTIMES');
    expect(source).toContain('export function getEmbeddedRuntime');
  });

  /**
   * Each build regenerates the tracked module, so the codegen must not rewrite
   * an up-to-date file. The test sets the mtime to the past, and a rewrite moves
   * it to the present. The codegen still rewrites a stale file.
   */
  it('EmbeddedRuntimes_UpToDateFile_IsNotRewritten', () => {
    const fixture = makeRuntimesFixture();
    const outFile = join(mkdtempSync(join(tmpdir(), 'codegen-out-same-')), 'embedded.ts');
    generateEmbeddedRuntimesModule({ runtimesDir: fixture, outFile });
    const past = new Date('2001-01-01T00:00:00Z');
    utimesSync(outFile, past, past);

    generateEmbeddedRuntimesModule({ runtimesDir: fixture, outFile });
    expect(statSync(outFile).mtimeMs).toBe(past.getTime());

    writeFileSync(outFile, 'stale\n', 'utf8');
    generateEmbeddedRuntimesModule({ runtimesDir: fixture, outFile });
    expect(readFileSync(outFile, 'utf8')).toContain('export const EMBEDDED_RUNTIMES');
  });
});
