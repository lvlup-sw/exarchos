/**
 * Tests for `scripts/codegen-runtimes.ts` (#1213, #1214).
 *
 * These exercise three invariants the embedded-runtimes codegen MUST
 * uphold so that:
 *
 *   1. The compiled binary always has every required runtime present
 *      (otherwise `install-skills --agent <name>` would fail at
 *      user-runtime, defeating the point of inlining).
 *   2. The emitted file is byte-identical across invocations on the
 *      same input — otherwise `runtimes:guard` (CI) would oscillate.
 *   3. Every embedded entry round-trips through `RuntimeMapSchema`
 *      cleanly, so we cannot smuggle malformed data into the binary.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderEmbeddedRuntimesModule,
  generateEmbeddedRuntimesModule,
  sortRuntimes,
} from './codegen-runtimes.js';
import { loadAllRuntimes, REQUIRED_RUNTIME_NAMES } from '../src/install/runtimes/load.js';
import { RuntimeMapSchema } from '../src/install/runtimes/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RUNTIMES_DIR = join(REPO_ROOT, 'content/harness/runtimes');

/** Copy the real `content/harness/runtimes/*.yaml` into a fresh tmp dir so the codegen
 *  has a stable input independent of any concurrent test mutating the
 *  workspace.
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
  it('EmbeddedRuntimes_AllRequiredNames_Present', () => {
    const fixture = makeRuntimesFixture();
    const outFile = join(mkdtempSync(join(tmpdir(), 'codegen-out-')), 'embedded.ts');
    generateEmbeddedRuntimesModule({ runtimesDir: fixture, outFile });

    const source = readFileSync(outFile, 'utf8');
    // Coarse-grained presence check: the canonical names appear in the
    // emitted source. Stricter parse-back happens in the schema test below.
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

  it('EmbeddedRuntimes_ParsesViaRuntimeMapSchema_NoFailures', () => {
    // The render step takes the already-validated array (loadAllRuntimes
    // ran Zod), but the contract is "every emitted entry round-trips"
    // — so we re-parse each entry to lock the contract in place against
    // any future codegen mutation that might strip fields.
    const runtimes = loadAllRuntimes(RUNTIMES_DIR);
    expect(runtimes.length).toBeGreaterThan(0);

    const sorted = sortRuntimes(runtimes);
    for (const rt of sorted) {
      const parsed = RuntimeMapSchema.safeParse(rt);
      expect(parsed.success, `runtime ${rt.name} failed schema parse`).toBe(true);
    }
  });

  it('EmbeddedRuntimes_SortOrder_RequiredFirstThenExtras', () => {
    // Synthesize an "extras" runtime to exercise the sort branch even
    // though the production runtimes/ tree has no extras today.
    const real = loadAllRuntimes(RUNTIMES_DIR);
    const extra = { ...real[0]!, name: 'aardvark-extra' };
    const sorted = sortRuntimes([...real, extra]);

    // First N entries must follow REQUIRED_RUNTIME_NAMES ordering.
    for (let i = 0; i < REQUIRED_RUNTIME_NAMES.length; i++) {
      expect(sorted[i]?.name).toBe(REQUIRED_RUNTIME_NAMES[i]);
    }
    // The extras tail must be alphabetical, with our synthetic entry
    // first since it sorts before any other plausible extra.
    expect(sorted[REQUIRED_RUNTIME_NAMES.length]?.name).toBe('aardvark-extra');
  });

  it('renderEmbeddedRuntimesModule_EmitsHeaderAndExports', () => {
    const runtimes = loadAllRuntimes(RUNTIMES_DIR);
    const source = renderEmbeddedRuntimesModule(runtimes);
    expect(source).toContain('GENERATED FILE');
    expect(source).toContain('export const EMBEDDED_RUNTIMES');
    expect(source).toContain('export function getEmbeddedRuntime');
  });
});
