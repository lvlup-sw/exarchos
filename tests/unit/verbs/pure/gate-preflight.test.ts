// Tests for `runGatePreflight`, the preflight helper that the gate handlers share.
// It returns the fail-fast envelopes of each handler and resolves `repoRoot` with worktree awareness.
//
// The module-surface test compares two authorities: the declared exports of the module,
// and the import sites in the source tree. Neither can observe the other,
// so a dead export is a disagreement between them.
// @oracle-sources: ../../../../src/verbs/pure/gate-preflight.ts, the named-import bindings scanned out of every non-test module under src

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { EventStore } from '../../../../src/events/store.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { runGatePreflight } from '../../../../src/verbs/pure/gate-preflight.js';

describe('gate-preflight (DR-10 shared helper)', () => {
  const stateDirs: string[] = [];

  async function makeStore(): Promise<EventStore> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gate-preflight-'));
    stateDirs.push(stateDir);
    const store = new EventStore(stateDir);
    await store.initialize();
    return store;
  }

  /** The temporary directory cleanup is best-effort. */
  afterEach(() => {
    for (const d of stateDirs.splice(0)) {
      try {
        rmrf(d);
      } catch {
      }
    }
  });

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

    /** `taskId` is optional for `check-integration-suite` and `static-analysis`. */
    it('absentTaskIdWithoutRequireFlag_ResolvesNormally', async () => {
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

    /** `auto` with no `worktreePath` and no `worktree.created` event gives `INVALID_INPUT` with the message of the resolver. */
    it('autoRepoRootUnresolvable_ReturnsInvalidInputWithResolverMessage', async () => {
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

    /** A miswired store with an absent `featureId` reports `MISWIRED_CONTEXT` first, in the same order as the handlers. */
    it('validationOrder_EventStoreCheckedBeforeFeatureId', async () => {
      const outcome = await runGatePreflight(
        { featureId: '', handlerName: 'h' },
        null as unknown as EventStore,
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.result.error?.code).toBe('MISWIRED_CONTEXT');
    });
  });

  describe('module surface', () => {
    /**
     * The module-intent gate checks whole modules, so it cannot see a dead export inside a live module.
     * This test fails when a value export of `gate-preflight.ts` has no production importer.
     *
     * It reads exports and imports from the AST. A text match misses `export let`, `export { … }`, double quotes, and default or namespace imports.
     * A namespace import covers each export. For an aliased import, `propertyName` is the exported name.
     * The test also requires at least one importer, so an empty scan cannot pass.
     */
    it('GatePreflight_EveryValueExport_HasANonTestImporter', () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const srcRoot = path.resolve(here, '../../../../src');
      const moduleFile = path.join(srcRoot, 'verbs/pure/gate-preflight.ts');

      const parse = (file: string): ts.SourceFile =>
        ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

      const isExported = (node: ts.Node): boolean =>
        ts.canHaveModifiers(node) &&
        (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

      const valueExports: string[] = [];
      for (const statement of parse(moduleFile).statements) {
        if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
        if (isExported(statement)) {
          if (
            (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
            statement.name !== undefined
          ) {
            valueExports.push(statement.name.text);
          } else if (ts.isVariableStatement(statement)) {
            for (const decl of statement.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) valueExports.push(decl.name.text);
            }
          } else if (ts.isEnumDeclaration(statement)) {
            valueExports.push(statement.name.text);
          }
        } else if (
          ts.isExportDeclaration(statement) &&
          !statement.isTypeOnly &&
          statement.exportClause !== undefined &&
          ts.isNamedExports(statement.exportClause)
        ) {
          for (const element of statement.exportClause.elements) {
            if (!element.isTypeOnly) valueExports.push(element.name.text);
          }
        }
      }
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
      let namespaceImporter = false;
      for (const file of files) {
        if (path.resolve(file) === path.resolve(moduleFile)) continue;
        for (const statement of parse(file).statements) {
          if (!ts.isImportDeclaration(statement)) continue;
          if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
          if (!statement.moduleSpecifier.text.endsWith('/gate-preflight.js')) continue;
          const clause = statement.importClause;
          if (clause === undefined || clause.isTypeOnly) continue;
          importerCount += 1;
          if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
            namespaceImporter = true;
          }
          if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              if (element.isTypeOnly) continue;
              importedBindings.add((element.propertyName ?? element.name).text);
            }
          }
          if (clause.name !== undefined) importedBindings.add('default');
        }
      }
      expect(importerCount, 'no production importer of gate-preflight was found').toBeGreaterThan(0);

      for (const name of valueExports) {
        expect(
          namespaceImporter || importedBindings.has(name),
          `${name} is exported but no production module imports it`,
        ).toBe(true);
      }
    });
  });
});
