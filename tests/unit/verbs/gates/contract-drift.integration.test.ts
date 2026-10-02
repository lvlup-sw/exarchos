/**
 * These tests run `check_contract_drift` through the composite
 * `handleOrchestrate` router, against a temp git repo with an OpenAPI artifact.
 * A breaking schema diff fails the gate. A clean regen with a passing
 * typecheck passes. With no contract tool, the gate skips and passes as
 * advisory. `contract-drift.test.ts` holds the unit tests.
 *
 * Shell stubs replace the real codegen and diff tools. `.exarchos.yml` wires
 * them through `contract: { codegen, diff }`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { runAsTrustedCaller, seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';


function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

async function initRepo(prefix: string): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

const OPENAPI_BASE = [
  'openapi: 3.0.0',
  'info:',
  '  title: fixture',
  '  version: 1.0.0',
  'paths:',
  '  /widgets:',
  '    get:',
  '      responses:',
  "        '200':",
  '          description: ok',
  '',
].join('\n');

/**
 * A stub `codegen` script: succeeds (exit 0) unless a `FAIL_CODEGEN` file is
 * present at the repo root. Writes a regenerated-marker file so a caller can
 * confirm it ran.
 */
const CODEGEN_STUB = [
  '#!/bin/sh',
  'if [ -f "$PWD/FAIL_CODEGEN" ]; then',
  '  echo "codegen failed" >&2',
  '  exit 1',
  'fi',
  'echo regenerated > "$PWD/.codegen-ran"',
  'exit 0',
  '',
].join('\n');

/**
 * A stub breaking-diff script: scans the schema artifact for the sentinel
 * `BREAKING-MARKER`. If present, prints a breaking-change line and exits 1
 * (the convention the gate reads as "drift"). Otherwise exits 0.
 */
const DIFF_STUB = [
  '#!/bin/sh',
  'if grep -q "BREAKING-MARKER" "$PWD/openapi.yaml"; then',
  '  echo "BREAKING: removed required field from /widgets"',
  '  exit 1',
  'fi',
  'echo "no breaking changes"',
  'exit 0',
  '',
].join('\n');

/**
 * Commits a fixture project on `main`: an OpenAPI artifact, the stub scripts,
 * and an `.exarchos.yml` with the given `typecheck` command. With
 * `wireContract`, the file also wires `contract.codegen` and `contract.diff` to
 * the stubs.
 */
async function writeBaseProject(
  repoRoot: string,
  opts: { wireContract: boolean; typecheck: string },
): Promise<void> {
  mkdirSync(path.join(repoRoot, 'stubs'), { recursive: true });
  const codegenPath = path.join(repoRoot, 'stubs', 'codegen.sh');
  const diffPath = path.join(repoRoot, 'stubs', 'diff.sh');
  writeFileSync(codegenPath, CODEGEN_STUB);
  writeFileSync(diffPath, DIFF_STUB);
  chmodSync(codegenPath, 0o755);
  chmodSync(diffPath, 0o755);

  writeFileSync(path.join(repoRoot, 'openapi.yaml'), OPENAPI_BASE);

  const exarchosYml = opts.wireContract
    ? [
        'contract:',
        '  codegen: sh stubs/codegen.sh',
        '  diff: sh stubs/diff.sh',
        `typecheck: '${opts.typecheck}'`,
        '',
      ].join('\n')
    : ['# no contract wired', `typecheck: '${opts.typecheck}'`, ''].join('\n');
  writeFileSync(path.join(repoRoot, '.exarchos.yml'), exarchosYml);

  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'base: openapi + contract stubs', '-q']);
}

function makeCtx(stateDir: string, eventStore: EventStore): DispatchContext {
  return withTrustedCaller({ stateDir, eventStore, enableTelemetry: false } as DispatchContext);
}

interface ContractDriftData {
  passed: boolean;
  drift?: boolean;
  breaking?: string[];
  report?: string;
  skipped?: boolean;
}

describe('check_contract_drift acceptance (through handleOrchestrate)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  async function dispatch(
    repoRoot: string,
    branch: string,
  ): Promise<{ success: boolean; data: ContractDriftData }> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'contract-drift-state-'));
    cleanups.push(() => rmrf(stateDir));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const ctx = makeCtx(stateDir, eventStore);
    const result = await orchestrate(
      {
        action: 'check_contract_drift',
        featureId: 'feat-contract',
        taskId: 'T-01',
        branch,
        baseBranch: 'main',
        repoRoot,
      },
      ctx,
    );
    return result as { success: boolean; data: ContractDriftData };
  }

  /** A breaking diff fails the gate and fills `breaking`. The tool call itself succeeds. */
  it(
    'HandleOrchestrate_CheckContractDrift_BreakingSchemaDiff_Fails',
    async () => {
      const repoRoot = await initRepo('contract-drift-breaking-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot, { wireContract: true, typecheck: 'true' });

      await git(repoRoot, ['checkout', '-b', 'feature/breaking', '-q']);
      writeFileSync(
        path.join(repoRoot, 'openapi.yaml'),
        OPENAPI_BASE + '# BREAKING-MARKER: removed field\n',
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: breaking schema change', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/breaking');

      expect(success).toBe(true);
      expect(data.passed).toBe(false);
      expect(data.drift).toBe(true);
      expect(Array.isArray(data.breaking)).toBe(true);
      expect(data.breaking!.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    'HandleOrchestrate_CheckContractDrift_CleanRegenAndTypecheck_Passes',
    async () => {
      const repoRoot = await initRepo('contract-drift-clean-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot, { wireContract: true, typecheck: 'true' });

      await git(repoRoot, ['checkout', '-b', 'feature/clean', '-q']);
      writeFileSync(
        path.join(repoRoot, 'openapi.yaml'),
        OPENAPI_BASE + '# additive: new optional field\n',
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: additive schema change', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/clean');

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.drift).toBeFalsy();
      expect(data.breaking ?? []).toEqual([]);
    },
    120_000,
  );

  it(
    'HandleOrchestrate_CheckContractDrift_NoToolResolves_SkippedAdvisory',
    async () => {
      const repoRoot = await initRepo('contract-drift-skip-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot, { wireContract: false, typecheck: 'true' });

      await git(repoRoot, ['checkout', '-b', 'feature/notool', '-q']);
      writeFileSync(
        path.join(repoRoot, 'openapi.yaml'),
        OPENAPI_BASE + '# BREAKING-MARKER: but no tool to detect it\n',
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'feat: schema change, no contract tool', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/notool');

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.skipped).toBe(true);
    },
    120_000,
  );
});

/** The state dir and feature id pairs that `orchestrate` already seeded. */
const seededWorkflows = new Set<string>();

/**
 * Calls the composite handler directly, without `dispatch()`, and recreates two
 * things that a real run provides. Without the trusted dispatch scope, the gate
 * returns `TRUSTED_CALLER_REQUIRED`. Without an active phase attempt for the
 * evidence, it returns `ACTIVE_PHASE_ATTEMPT_REQUIRED`.
 */
async function orchestrate(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<Awaited<ReturnType<typeof handleOrchestrate>>> {
  const featureId = typeof args['featureId'] === 'string' ? args['featureId'] : undefined;
  if (featureId !== undefined) {
    const key = `${ctx.stateDir}\0${featureId}`;
    if (!seededWorkflows.has(key)) {
      seededWorkflows.add(key);
      await seedActivePhaseAttempt(ctx.eventStore, featureId);
    }
  }
  return runAsTrustedCaller(ctx.stateDir, () => handleOrchestrate(args, ctx));
}
