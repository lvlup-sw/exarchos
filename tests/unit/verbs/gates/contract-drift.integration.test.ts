// ─── check_contract_drift ACCEPTANCE — through handleOrchestrate ──────────────
//
// Verification-ladder slice 1, Bundle B3 (task 021). The end-to-end contract:
// dispatch `check_contract_drift` through the composite `handleOrchestrate`
// router against a real temp-dir git fixture repo with a schema artifact and
// prove the gate distinguishes a breaking schema diff from a clean regen.
//
//   • Breaking diff — the schema artifact changed on the branch in a way the
//     (stubbed) breaking-diff tool reports as breaking → drift, passed:false,
//     breaking[] populated.
//   • Clean regen + typecheck — codegen succeeds, typecheck succeeds, the
//     breaking-diff reports no breakage → passed:true.
//   • No tool resolves — neither codegen nor diff is configured/detected →
//     skipped/advisory (passed:true, skipped:true), NEVER a hard fail (INV-4).
//
// This file is the acceptance gate: it stays RED until task 023 registers the
// action + wires the dispatch branch. Per-leg/unit coverage of merge-base
// baseline, failure legs, and breaking-array population lives in
// contract-drift.test.ts.
//
// Stub codegen/diff: small shell scripts written into the fixture and wired via
// `.exarchos.yml` `contract: { codegen, diff }` so tests never need a real
// buf/oasdiff/openapi-typescript install. The breaking-diff stub exits non-zero
// (and prints a breaking-change line) when a sentinel marker is present in the
// current schema artifact, exit 0 otherwise.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { runAsTrustedCaller, seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';

// ─── git fixture helpers ─────────────────────────────────────────────────────

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function initRepo(prefix: string): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repoRoot, ['init', '--initial-branch=main', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
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
 * Scaffold a fixture repo on `main`: an OpenAPI artifact, stub codegen/diff
 * scripts, and an `.exarchos.yml` wiring `contract.codegen` / `contract.diff`
 * to those scripts. `typecheckPasses` controls whether a `typecheck` command is
 * wired (a no-op `true` when passing, `false` when failing).
 */
function writeBaseProject(
  repoRoot: string,
  opts: { wireContract: boolean; typecheck: string },
): void {
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

  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base: openapi + contract stubs', '-q']);
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

// ─── tests ───────────────────────────────────────────────────────────────────

describe('check_contract_drift acceptance (through handleOrchestrate)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  async function dispatch(
    repoRoot: string,
    branch: string,
  ): Promise<{ success: boolean; data: ContractDriftData }> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'contract-drift-state-'));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
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

  it(
    'HandleOrchestrate_CheckContractDrift_BreakingSchemaDiff_Fails',
    async () => {
      const repoRoot = initRepo('contract-drift-breaking-');
      cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
      writeBaseProject(repoRoot, { wireContract: true, typecheck: 'true' });

      // Branch: edit the schema in a way the diff stub flags as breaking.
      git(repoRoot, ['checkout', '-b', 'feature/breaking', '-q']);
      writeFileSync(
        path.join(repoRoot, 'openapi.yaml'),
        OPENAPI_BASE + '# BREAKING-MARKER: removed field\n',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'feat: breaking schema change', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/breaking');

      // Advisory carrier: the tool call SUCCEEDS, the gate FAILS.
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
      const repoRoot = initRepo('contract-drift-clean-');
      cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
      writeBaseProject(repoRoot, { wireContract: true, typecheck: 'true' });

      // Branch: a non-breaking schema edit (no sentinel marker).
      git(repoRoot, ['checkout', '-b', 'feature/clean', '-q']);
      writeFileSync(
        path.join(repoRoot, 'openapi.yaml'),
        OPENAPI_BASE + '# additive: new optional field\n',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'feat: additive schema change', '-q']);

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
      const repoRoot = initRepo('contract-drift-skip-');
      cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
      // No contract commands wired → the gate cannot resolve a tool.
      writeBaseProject(repoRoot, { wireContract: false, typecheck: 'true' });

      git(repoRoot, ['checkout', '-b', 'feature/notool', '-q']);
      writeFileSync(
        path.join(repoRoot, 'openapi.yaml'),
        OPENAPI_BASE + '# BREAKING-MARKER: but no tool to detect it\n',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'feat: schema change, no contract tool', '-q']);

      const { success, data } = await dispatch(repoRoot, 'feature/notool');

      // Degrade per INV-4: skipped/advisory, never a hard fail.
      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.skipped).toBe(true);
    },
    120_000,
  );
});

/**
 * These tests invoke the composite handler DIRECTLY, bypassing `dispatch()`.
 *
 * Two things `dispatch()` and a real run would have provided must be recreated,
 * or every case exercises a fail-closed path instead of the behaviour under
 * test: the ambient trusted dispatch scope the durable-evidence gates read
 * their caller authorization from (`TRUSTED_CALLER_REQUIRED` without it), and a
 * started workflow with an active phase attempt for the gate's evidence to bind
 * to (`ACTIVE_PHASE_ATTEMPT_REQUIRED` without it).
 */
const seededWorkflows = new Set<string>();

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
