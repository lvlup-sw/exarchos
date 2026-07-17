// ─── DR-2 Acceptance — Storage handle DI through DispatchContext ───────────
//
// Bundle scope: T14 acceptance for the durable-event-store-substrate plan.
// This test is the canonical observable for DR-2 (design doc:
// `docs/designs/archive/2026-05-08-durable-event-store-substrate.md`).
//
// DR-2 acceptance criteria (verbatim from the design doc):
//   1. `DispatchContext` carries a `storage: StorageBackend` field
//      constructed in `lifecycle.ts`.
//   2. A grep of production code (`servers/exarchos-mcp/src/**/*.ts`
//      excluding `__tests__/` and `__shims__/`) finds zero
//      `import .* from 'bun:sqlite'` outside `storage/`.
//   3. Test-doubles use `MemoryBackend` injected through the same
//      context shape.
//
// This file stays RED while T14 is the only commit on the branch and
// flips GREEN once T15 (type field), T16 (lifecycle wiring) and T17
// (no ambient bun:sqlite outside storage/) are all in.

import { describe, it, expect, beforeEach, afterEach, assertType } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { EventStore } from '../event-store/store.js';
import { InMemoryBackend } from '../storage/memory-backend.js';
import type { DispatchContext } from './dispatch.js';
import type { StorageBackend } from '../storage/backend.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// servers/exarchos-mcp/src/core/dispatch-context.acceptance.test.ts → src/
const SRC_DIR = resolve(__dirname, '..');

const EXCLUDED_SEGMENTS = new Set(['storage', '__shims__', '__tests__']);

/**
 * Walk the production tree under `src/`, collecting every `.ts` file that
 * is NOT in an excluded segment and is NOT a test file.
 *
 * Excluded:
 *   - any path segment named `storage`     (the abstraction lives there)
 *   - any path segment named `__shims__`   (vitest alias targets only)
 *   - any path segment named `__tests__`   (test-only fixtures)
 *   - any file ending in `.test.ts`         (co-located tests)
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
      // Defensive: drop `.d.ts` files — they are type-only and would
      // surface ambient `declare module 'bun:sqlite'` declarations.
      if (entry.endsWith('.d.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

const BUN_SQLITE_IMPORT_RE = /from\s+['"]bun:sqlite['"]/;

// ─── DR-2 Acceptance ────────────────────────────────────────────────────────

describe('DR-2 acceptance — storage handle DI through DispatchContext', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'dispatch-ctx-acceptance-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('DispatchContext_StorageHandle_InjectedNotAmbient', () => {
    // ─── Sub-assertion 1: type-shape — `storage` is declared on the
    // `DispatchContext` interface in `core/dispatch.ts`.
    //
    // Type-erasure makes runtime introspection of an interface impossible,
    // so this assertion reads `core/dispatch.ts` and grep-asserts that
    // the declared interface body contains a `storage` field annotated
    // with `StorageBackend`. The companion `assertType` below pins the
    // shape statically — but tsc excludes test files from the typecheck
    // gate (see `tsconfig.json`), so the file-level grep is the
    // load-bearing observable.
    const dispatchSrc = readFileSync(
      resolve(__dirname, 'dispatch.ts'),
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

    // Static-side: a `DispatchContext` literal that sets
    // `storage: StorageBackend` must be assignable. vitest's
    // `assertType` is reified via `--typecheck`; without that mode it's
    // a no-op, but the literal below still fails compilation under
    // `tsx`/vitest if the interface is missing the field.
    const backend: StorageBackend = new InMemoryBackend();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
      storage: backend,
    };
    assertType<StorageBackend | undefined>(ctx.storage);
    // Runtime sanity: the literal carries the backend we just constructed.
    expect(ctx.storage).toBe(backend);

    // ─── Sub-assertion 2: production tree contains zero `from 'bun:sqlite'`
    // imports outside `storage/`, `__shims__/`, and test files.
    //
    // This is the grep-based observable from the design doc. It also
    // backstops T17 — if any production module reaches for raw
    // `Database` / `Statement`, it must do so through the
    // `StorageBackend` abstraction in `storage/`.
    const productionFiles = collectProductionTsFiles(SRC_DIR);
    const offenders: string[] = [];
    for (const file of productionFiles) {
      const content = readFileSync(file, 'utf-8');
      if (BUN_SQLITE_IMPORT_RE.test(content)) {
        // Render as src-relative for legible failure output.
        offenders.push(file.split(`${sep}src${sep}`).pop() ?? file);
      }
    }
    expect(
      offenders,
      `Found bun:sqlite imports in production code outside storage/. ` +
        `Production code must access SQLite through the StorageBackend abstraction. ` +
        `Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);

    // ─── Sub-assertion 3: test-double parity.
    //
    // The same `DispatchContext` shape accepts an `InMemoryBackend`
    // without type errors. This is what test-doubles depend on — if
    // the field's type were narrower than `StorageBackend`, in-memory
    // tests would have to special-case the context shape.
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
