/**
 * A read-only MCP session must not start the spec-coverage probe.
 *
 * The reviewer session holds `fs:read` and `mcp:exarchos:readonly`. `spec_coverage_check`
 * is on the read-only allowlist and declares only `fs:read`, with no admission requirement.
 * After implementation, which is the default phase, the handler resolves the verification
 * profile at the caller-supplied `repoRoot` and runs its probe. These tests dispatch that
 * action through the real session resolver. An operator session on the same tree must run
 * the probe, so a fixture that never starts a process cannot make the read-only case pass.
 * A read-only call passes only when that process does not write its marker.
 *
 * The same marker guards the other profile runners a read-only session can name. Each of
 * those declares `shell:exec` or is absent from the allowlist, so dispatch refuses them
 * before the handler. A refusal that still starts the probe fails the test.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveMcpCallerIdentity,
  resolveMcpSessionResolver,
  type McpSessionGrant,
} from '../../../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { buildDefaultProcessResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';

const FEATURE = 'wf-readonly-probe';
const DENIED_BEFORE_HANDLER = new Set(['CAPABILITY_DENIED', 'ADMISSION_DENIED']);

let stateDir: string;
let store: EventStore;
let roots: string[];

function session(grant: McpSessionGrant): DispatchContext {
  return {
    stateDir,
    eventStore: store,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: `spec-coverage-${grant}` }),
    capabilityResolver: resolveMcpSessionResolver(grant, buildDefaultProcessResolver()),
  };
}

async function call(grant: McpSessionGrant, args: Record<string, unknown>): Promise<ToolResult> {
  return dispatch('exarchos_orchestrate', args, session(grant));
}

function scratch(prefix: string): string {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function markerText(marker: string): string | undefined {
  if (!existsSync(marker)) return undefined;
  return readFileSync(marker, 'utf8');
}

function clearMarker(marker: string): void {
  if (existsSync(marker)) rmSync(marker);
}

/**
 * Writes the probe payload. The marker path is a literal in the file, so the child
 * records a start even when the runner appends test paths or changes the working directory.
 */
function writeProbeScript(repo: string, marker: string): void {
  writeFileSync(
    path.join(repo, 'write-marker.cjs'),
    `const { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`,
  );
}

function writePlanAndTest(repo: string): string {
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.test.ts'), 'export {}\n');
  const plan = path.join(repo, 'plan.md');
  writeFileSync(plan, '# Plan\n\nThe implementation is covered by `src/a.test.ts`.\n');
  return plan;
}

function writeConfiguredProbe(repo: string): void {
  writeFileSync(
    path.join(repo, '.exarchos.yml'),
    `verification:\n  tests:\n    probe:\n      command: ${process.execPath} write-marker.cjs\n`,
  );
}

function writeDetectedPackage(repo: string): void {
  writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({
      name: 'reviewed-tree',
      scripts: {
        'test:run': 'node write-marker.cjs',
        lint: 'node write-marker.cjs',
        typecheck: 'node write-marker.cjs',
      },
    }),
  );
}

interface ProbeTree {
  readonly repo: string;
  readonly plan: string;
  readonly marker: string;
}

function configuredProbeTree(): ProbeTree {
  const repo = scratch('spec-coverage-configured');
  const marker = path.join(repo, 'probe-ran.txt');
  writeProbeScript(repo, marker);
  writeConfiguredProbe(repo);
  return { repo, plan: writePlanAndTest(repo), marker };
}

function detectedProbeTree(): ProbeTree {
  const repo = scratch('spec-coverage-detected');
  const marker = path.join(repo, 'probe-ran.txt');
  writeProbeScript(repo, marker);
  writeDetectedPackage(repo);
  return { repo, plan: writePlanAndTest(repo), marker };
}

async function specCoverage(grant: McpSessionGrant, tree: ProbeTree): Promise<ToolResult> {
  return call(grant, {
    action: 'spec_coverage_check',
    featureId: FEATURE,
    planFile: tree.plan,
    repoRoot: tree.repo,
  });
}

/**
 * The operator call proves the tree's probe starts. The read-only call on the same tree
 * must leave the marker absent, including when dispatch returns a success carrier.
 */
async function expectReadOnlyDoesNotRunProbe(tree: ProbeTree): Promise<void> {
  const operator = await specCoverage('operator', tree);
  expect(markerText(tree.marker), `operator probe did not start: ${JSON.stringify(operator)}`).toBe('ran\n');
  clearMarker(tree.marker);

  const readonly = await specCoverage('read-only', tree);
  expect(
    markerText(tree.marker),
    `read-only spec_coverage_check started the probe: ${JSON.stringify(readonly)}`,
  ).toBeUndefined();
}

beforeEach(async () => {
  roots = [];
  stateDir = scratch('spec-coverage-state');
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, FEATURE, { phase: 'review' });
});

afterEach(async () => {
  store.close();
  for (const root of roots) {
    await rmrfAsync(root);
  }
});

describe('spec_coverage_check probe execution from a read-only session', () => {
  it('configured probe command does not run', async () => {
    await expectReadOnlyDoesNotRunProbe(configuredProbeTree());
  });

  it('detected package test script does not run', async () => {
    await expectReadOnlyDoesNotRunProbe(detectedProbeTree());
  });

  /**
   * `repoRoot` is a symlink under the server state directory. Its target is a different
   * directory that holds the probe. A check of the symlink path that then runs with that
   * path as the working directory still follows the link, so the marker lands in the target.
   */
  it('symlink repoRoot does not run the target probe', async () => {
    const tree = configuredProbeTree();
    const link = path.join(stateDir, 'reviewed');
    symlinkSync(tree.repo, link);
    const linked: ProbeTree = { repo: link, plan: tree.plan, marker: tree.marker };

    const operator = await specCoverage('operator', linked);
    expect(markerText(tree.marker), `operator probe did not follow the symlink: ${JSON.stringify(operator)}`).toBe('ran\n');
    clearMarker(tree.marker);

    const readonly = await specCoverage('read-only', linked);
    expect(
      markerText(tree.marker),
      `read-only spec_coverage_check followed ${link} and started the probe: ${JSON.stringify(readonly)}`,
    ).toBeUndefined();
  });
});

describe('other profile runners a read-only session can name', () => {
  it('verify_worktree_baseline does not run the detected test command', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'verify_worktree_baseline',
      worktreePath: tree.repo,
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });

  it('check_static_analysis does not run the detected lint command', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'check_static_analysis',
      featureId: FEATURE,
      repoRoot: tree.repo,
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });

  it('check_post_merge does not run', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'check_post_merge',
      featureId: FEATURE,
      repoRoot: tree.repo,
      prUrl: 'https://example.invalid/pr/1',
      mergeSha: '0123456789abcdef',
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });

  it('check_test_adequacy does not run the probe', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'check_test_adequacy',
      featureId: FEATURE,
      taskId: 'T-01',
      repoRoot: tree.repo,
      baseBranch: 'main',
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });

  it('check_integration_suite does not run the integration command', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'check_integration_suite',
      featureId: FEATURE,
      repoRoot: tree.repo,
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });

  it('check_contract_drift does not run the contract commands', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'check_contract_drift',
      featureId: FEATURE,
      taskId: 'T-01',
      repoRoot: tree.repo,
      baseBranch: 'main',
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });

  it('mutation-adequacy does not run the mutation command', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'mutation-adequacy',
      featureId: FEATURE,
      taskId: 'T-01',
      repoRoot: tree.repo,
      baseBranch: 'main',
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });

  it('pre_synthesis_check does not run the test command', async () => {
    const tree = detectedProbeTree();
    const result = await call('read-only', {
      action: 'pre_synthesis_check',
      featureId: FEATURE,
      repoRoot: tree.repo,
    });
    expect(markerText(tree.marker), JSON.stringify(result)).toBeUndefined();
    expect(DENIED_BEFORE_HANDLER.has(result.error?.code ?? '')).toBe(true);
  });
});
