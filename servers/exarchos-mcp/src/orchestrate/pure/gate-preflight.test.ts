// ─── gate-preflight — the shared preflight helper (DR-10) ────────────────────
//
// These tests pin the SHARED helper directly (the five gate handlers keep their
// own unmodified tests): runGatePreflight reproduces each handler's exact
// fail-fast envelopes and the worktree-aware repoRoot resolution.
//
// The `emitPolicySkipIfNeeded` cases that used to sit below were deleted with
// the helper itself. It was retired when the durable gate runner took over skip
// emission, and by then this file was its only caller — the tests were the only
// thing keeping a dead export compiling. Its behaviour is now asserted where the
// behaviour lives, against `appendGateExecutedSignal` in gate-runner.test.ts.
//
// DR-30 — the two authorities `GatePreflight_EveryValueExport_HasANonTestImporter`
// compares are the module's own DECLARED export surface and the live IMPORT
// SITES across the MCP source tree. Neither can observe the other: the module
// does not know who imports it, and no importer enumerates what it exports, so a
// dead export is exactly the disagreement between them.
// @oracle-sources: ./gate-preflight.ts, the named-import bindings scanned out of every non-test module under servers/exarchos-mcp/src
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventStore } from '../../event-store/store.js';
import { rmrf } from '../../test-helpers/temp-dir.js';
import { runGatePreflight } from './gate-preflight.js';

describe('gate-preflight (DR-10 shared helper)', () => {
  const stateDirs: string[] = [];

  async function makeStore(): Promise<EventStore> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gate-preflight-'));
    stateDirs.push(stateDir);
    const store = new EventStore(stateDir);
    await store.initialize();
    return store;
  }

  afterEach(() => {
    for (const d of stateDirs.splice(0)) {
      try {
        rmrf(d);
      } catch {
        /* best-effort */
      }
    }
  });

  // ─── runGatePreflight ──────────────────────────────────────────────────────

  describe('runGatePreflight', () => {
    it('miswiredEventStore_ReturnsMiswiredContextNamedPerHandler', async () => {
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', handlerName: 'handleContractDrift' },
        null as unknown as EventStore,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.error?.code).toBe('MISWIRED_CONTEXT');
      // The handler name is stamped into the message (not a generic string).
      expect(outcome.result.error?.message).toBe('handleContractDrift: eventStore is required');
    });

    it('absentFeatureId_ReturnsInvalidInput', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: '', handlerName: 'handleStaticAnalysis' },
        store,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('INVALID_INPUT');
      expect(outcome.result.error?.message).toContain('featureId');
    });

    it('requireTaskIdWithAbsentTaskId_ReturnsInvalidInput', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', handlerName: 'handleTestAdequacy', requireTaskId: true },
        store,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('INVALID_INPUT');
      expect(outcome.result.error?.message).toBe('taskId is required');
    });

    it('absentTaskIdWithoutRequireFlag_ResolvesNormally', async () => {
      // check-integration-suite / static-analysis: taskId is optional.
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', repoRoot: '/literal/repo', handlerName: 'handleCheckIntegrationSuite' },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe('/literal/repo');
    });

    it('literalRepoRoot_ReturnedVerbatim', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', taskId: 'T-1', repoRoot: '/worktrees/agent-x', handlerName: 'h', requireTaskId: true },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe('/worktrees/agent-x');
    });

    it('omittedRepoRoot_FallsBackToProcessCwd', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', handlerName: 'h' },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe(process.cwd());
    });

    it('autoRepoRootUnresolvable_ReturnsInvalidInputWithResolverMessage', async () => {
      // 'auto' with no worktreePath and no worktree.created event → INVALID_INPUT
      // carrying the resolver's own message (byte-preserved from the handlers).
      const store = await makeStore();
      const outcome = await runGatePreflight(
        { featureId: 'feat-1', taskId: 'T-missing', repoRoot: 'auto', handlerName: 'h', requireTaskId: true },
        store,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('INVALID_INPUT');
      expect(outcome.result.error?.message).toContain("repoRoot 'auto' could not be resolved");
    });

    it('autoRepoRootWithExplicitWorktreePath_Resolves', async () => {
      const store = await makeStore();
      const outcome = await runGatePreflight(
        {
          featureId: 'feat-1',
          taskId: 'T-1',
          repoRoot: 'auto',
          worktreePath: '/worktrees/agent-y',
          handlerName: 'h',
          requireTaskId: true,
        },
        store,
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.repoRoot).toBe('/worktrees/agent-y');
    });

    it('validationOrder_EventStoreCheckedBeforeFeatureId', async () => {
      // A miswired store with an ALSO-absent featureId must surface the wiring
      // bug (MISWIRED_CONTEXT), not the input error — the order the handlers use.
      const outcome = await runGatePreflight(
        { featureId: '', handlerName: 'h' },
        null as unknown as EventStore,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('MISWIRED_CONTEXT');
    });
  });

  // ─── No dead exports (the residue `emitPolicySkipIfNeeded` sat in) ─────────

  describe('module surface', () => {
    it('GatePreflight_EveryValueExport_HasANonTestImporter', () => {
      // `emitPolicySkipIfNeeded` was retired when the durable gate runner took
      // over skip emission, and then sat here for a whole programme — because
      // the module-intent gate is MODULE-granular. `gate-preflight.ts` has four
      // live production importers, so the module is not dead and the gate had
      // nothing to say about a dead EXPORT inside it. Deleting the function was
      // a one-time cleanup; this is the part that keeps it deleted, and it is
      // what makes the removal falsifiable rather than merely done.
      const here = path.dirname(fileURLToPath(import.meta.url));
      const srcRoot = path.resolve(here, '..', '..');
      const moduleFile = path.join(here, 'gate-preflight.ts');

      const source = readFileSync(moduleFile, 'utf8');
      const valueExports = [
        ...source.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm),
      ].map((m) => m[1] as string);
      expect(valueExports.length, 'no value exports found — the scan is measuring nothing').toBeGreaterThan(0);

      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            walk(full);
          } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
            files.push(full);
          }
        }
      };
      walk(srcRoot);

      const importedBindings = new Set<string>();
      let importerCount = 0;
      for (const file of files) {
        if (path.resolve(file) === path.resolve(moduleFile)) continue;
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(
          /import\s*\{([^}]*)\}\s*from\s*'[^']*\/gate-preflight\.js'/g,
        )) {
          importerCount += 1;
          for (const raw of (match[1] ?? '').split(',')) {
            const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
            if (name) importedBindings.add(name);
          }
        }
      }
      // Non-empty denominator: a scan that found no importer would pass this
      // test by finding nothing, which is the failure shape it exists to catch.
      expect(importerCount, 'no production importer of gate-preflight was found').toBeGreaterThan(0);

      for (const name of valueExports) {
        expect(importedBindings.has(name), `${name} is exported but no production module imports it`).toBe(
          true,
        );
      }
    });
  });
});
