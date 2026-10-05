// Acceptance test for the storage handle that `DispatchContext` carries.
//   1. `DispatchContext` declares a `storage` field of type `StorageBackend`.
//   2. No production file outside `storage/` imports `bun:sqlite`.
//   3. A test double injects an `InMemoryBackend` through the same context shape.

import { describe, it, expect, beforeEach, afterEach, assertType } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { EventStore } from '../../../../src/events/store.js';
import { InMemoryBackend } from '../../../../src/storage/memory-backend.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { StorageBackend } from '../../../../src/storage/backend.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_DIR = resolve(__dirname, '../../../../src');

const EXCLUDED_SEGMENTS = new Set(['storage', '__shims__', '__tests__']);

/**
 * Collects each production `.ts` file under `rootDir`. The walk skips each
 * directory in `EXCLUDED_SEGMENTS`, each `.test.ts` file, and each `.d.ts` file.
 */
function collectProductionTsFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_SEGMENTS.has(entry)) continue;
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.test.ts')) continue;
      if (entry.endsWith('.d.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

const BUN_SQLITE_IMPORT_RE = /from\s+['"]bun:sqlite['"]/;

describe('DR-2 acceptance — storage handle DI through DispatchContext', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'dispatch-ctx-acceptance-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * 1. An interface has no run-time form, so the test reads `dispatch.ts` as text
   *    and matches the `storage` field of `DispatchContext`. No type check covers
   *    this file, so `assertType` and the type annotations prove nothing.
   * 2. The scan of the production tree finds no `from 'bun:sqlite'` import
   *    outside `storage/`.
   * 3. A context literal accepts an `InMemoryBackend` as its `storage`.
   */
  it('DispatchContext_StorageHandle_InjectedNotAmbient', () => {
    const dispatchSrc = readFileSync(
      resolve(__dirname, '../../../../src/dispatch/core/dispatch.ts'),
      'utf-8',
    );
    const ifaceMatch = dispatchSrc.match(
      /export interface DispatchContext\s*\{[\s\S]*?\n\}/,
    );
    expect(
      ifaceMatch,
      'DispatchContext interface not found in core/dispatch.ts',
    ).not.toBeNull();
    const ifaceBody = ifaceMatch![0];
    expect(
      /\bstorage\??:\s*StorageBackend\b/.test(ifaceBody),
      `DispatchContext.storage must be declared as 'storage[?]: StorageBackend' in core/dispatch.ts.\n` +
        `Current interface body:\n${ifaceBody}`,
    ).toBe(true);

    const backend: StorageBackend = new InMemoryBackend();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      storage: backend,
    };
    assertType<StorageBackend | undefined>(ctx.storage);
    expect(ctx.storage).toBe(backend);

    const productionFiles = collectProductionTsFiles(SRC_DIR);
    const offenders: string[] = [];
    for (const file of productionFiles) {
      const content = readFileSync(file, 'utf-8');
      if (BUN_SQLITE_IMPORT_RE.test(content)) {
        offenders.push(file.split(`${sep}src${sep}`).pop() ?? file);
      }
    }
    expect(
      offenders,
      `Found bun:sqlite imports in production code outside storage/. ` +
        `Production code must access SQLite through the StorageBackend abstraction. ` +
        `Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);

    const memoryBackend: StorageBackend = new InMemoryBackend();
    const ctxWithMemory: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      storage: memoryBackend,
    };
    expect(ctxWithMemory.storage).toBe(memoryBackend);
    expect(ctxWithMemory.storage).toBeInstanceOf(InMemoryBackend);
  });
});
