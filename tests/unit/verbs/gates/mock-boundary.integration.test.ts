// Acceptance tests for `check_mock_boundary`. Each case dispatches through `handleOrchestrate`
// against a temporary git repo.
//
// - An unowned mock (`vi.mock('axios')`) gives an advisory pass with the finding and a steer.
// - A first-party mock under `src/` gives a clean pass with no findings.
// - A `.exarchos.yml` review-gate override makes the gate blocking.
// - A `reason` acknowledges an intentional unowned mock. The gate passes,
//   and the durable evidence records the acknowledgement.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt, withTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import { gateRunnerObservationSource } from '../../../../src/verbs/gates/gate-runner.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';


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

/**
 * Commits a source module, a base test, and an optional `.exarchos.yml` on `main`.
 * The default first-party scope includes `src/**`, so a bare `axios` mock is unowned.
 */
async function writeBaseProject(repoRoot: string, exarchosYml?: string): Promise<void> {
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'foo.ts'), 'export const foo = () => 1;\n');
  writeFileSync(
    path.join(repoRoot, 'src', 'foo.test.ts'),
    "import { foo } from '../../orchestrate/foo.js';\nfoo();\n",
  );
  if (exarchosYml !== undefined) {
    writeFileSync(path.join(repoRoot, '.exarchos.yml'), exarchosYml);
  }
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'base: src + test', '-q']);
}

function makeCtx(stateDir: string, eventStore: EventStore): DispatchContext {
  return withTrustedCaller({ stateDir, eventStore, enableTelemetry: false } as DispatchContext);
}

interface MockBoundaryData {
  passed: boolean;
  findings?: Array<{ file: string; identifier: string; mockedTarget: string; unowned: boolean }>;
  next_actions?: string[];
  severity?: string;
  escapeHatch?: { acknowledged: boolean; reason: string };
  skipped?: boolean;
}

describe('check_mock_boundary acceptance (through handleOrchestrate)', () => {
  const cleanups: Array<() => void> = [];

  /** The temporary directory cleanup is best-effort. */
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
    extra: Record<string, unknown> = {},
  ): Promise<{ result: { success: boolean; data: MockBoundaryData }; eventStore: EventStore; featureId: string }> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mock-boundary-state-'));
    cleanups.push(() => rmrf(stateDir));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const ctx = makeCtx(stateDir, eventStore);
    const featureId = 'feat-mock-boundary';
    const result = await orchestrate(
      {
        action: 'check_mock_boundary',
        featureId,
        taskId: 'T-01',
        branch,
        baseBranch: 'main',
        repoRoot,
        ...extra,
      },
      ctx,
    );
    return { result: result as { success: boolean; data: MockBoundaryData }, eventStore, featureId };
  }

  /** `axios` classifies as `third-party-http`, so the steer names a concrete hermetic double, a Pact-verified contract stub. */
  it(
    'HandleOrchestrate_CheckMockBoundary_UnownedMock_AdvisoryWithSteerNextAction',
    async () => {
      const repoRoot = await initRepo('mock-boundary-unowned-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot);

      await git(repoRoot, ['checkout', '-b', 'feature/unowned', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'http.test.ts'),
        "import axios from 'axios';\nvi.mock('axios');\naxios.get('/x');\n",
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'test: mock axios', '-q']);

      const { result } = await dispatch(repoRoot, 'feature/unowned');
      const { success, data } = result;

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.severity).toBe('warning');

      expect(Array.isArray(data.findings)).toBe(true);
      expect(data.findings?.length ?? 0).toBeGreaterThan(0);
      const axiosFinding = data.findings?.find((f) => f.mockedTarget === 'axios');
      expect(axiosFinding).toBeDefined();
      expect(axiosFinding?.unowned).toBe(true);

      expect(Array.isArray(data.next_actions)).toBe(true);
      const steer = data.next_actions?.find((s) => s.includes('axios'));
      expect(steer).toBeDefined();
      expect(steer ?? '').toMatch(/replace the mock/i);
      expect(steer ?? '').toMatch(/third-party-http/i);
      expect(steer!).toMatch(/Pact-verified contract stub/i);
    },
    120_000,
  );

  /** `./foo.js` resolves against the directory of `src/bar.test.ts`, so the target `src/foo.js` is first-party. */
  it(
    'HandleOrchestrate_CheckMockBoundary_FirstPartyMock_Passes',
    async () => {
      const repoRoot = await initRepo('mock-boundary-firstparty-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot);

      await git(repoRoot, ['checkout', '-b', 'feature/firstparty', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'bar.test.ts'),
        "import { foo } from '../../orchestrate/foo.js';\nvi.mock('./foo.js');\nfoo();\n",
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'test: mock first-party foo', '-q']);

      const { result } = await dispatch(repoRoot, 'feature/firstparty');
      const { success, data } = result;

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.findings ?? []).toEqual([]);
      expect(data.next_actions ?? []).toEqual([]);
    },
    120_000,
  );

  /** A `.exarchos.yml` review-gate override makes the gate blocking. With an unowned finding, the gate does not pass. */
  it(
    'CheckMockBoundary_ConfigOverrideBlocking_StillHonored',
    async () => {
      const repoRoot = await initRepo('mock-boundary-blocking-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(
        repoRoot,
        ['review:', '  gates:', '    mock-boundary:', '      blocking: true', ''].join('\n'),
      );

      await git(repoRoot, ['checkout', '-b', 'feature/blocking', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'http.test.ts'),
        "import axios from 'axios';\nvi.mock('axios');\naxios.get('/x');\n",
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'test: mock axios', '-q']);

      const { result } = await dispatch(repoRoot, 'feature/blocking');
      const { success, data } = result;

      expect(success).toBe(true);
      expect(data.severity).toBe('blocking');
      expect(data.passed).toBe(false);
      expect(data.findings?.some((f) => f.mockedTarget === 'axios') ?? false).toBe(true);
    },
    120_000,
  );

  /**
   * With the escape hatch, the gate passes and the carrier records the acknowledgement.
   * The canonical gate runner also records `admission.evidence-recorded` with its observation source.
   * An escape hatch without an audit trail is not acceptable, so the carrier references that record.
   */
  it(
    'GateEvent_EscapeHatch_LoggedInPayload',
    async () => {
      const repoRoot = await initRepo('mock-boundary-escape-');
      cleanups.push(() => rmrf(repoRoot));
      await writeBaseProject(repoRoot);

      await git(repoRoot, ['checkout', '-b', 'feature/escape', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'http.test.ts'),
        "import axios from 'axios';\nvi.mock('axios');\naxios.get('/x');\n",
      );
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'test: mock axios (intentional)', '-q']);

      const reason = 'axios stubbed at the transport boundary; covered by a separate contract test';
      const { result, eventStore, featureId } = await dispatch(repoRoot, 'feature/escape', {
        reason,
      });
      const { success, data } = result;

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.escapeHatch).toBeDefined();
      expect(data.escapeHatch!.acknowledged).toBe(true);
      expect(data.escapeHatch!.reason).toBe(reason);

      const events = await eventStore.query(featureId, {
        type: 'admission.evidence-recorded',
      });
      const gateEvidence = events.filter(
        (e) => e.source === gateRunnerObservationSource('mock-boundary'),
      );
      expect(gateEvidence.length).toBeGreaterThan(0);
      const latest = gateEvidence[gateEvidence.length - 1];
      expect(latest).toBeDefined();
      if (latest === undefined) return;
      const record = latest.data as {
        evidence: {
          verdict: string;
          contentDigest: { algorithm: string; value: string };
          subject: unknown;
        };
      };
      expect(record.evidence.verdict).toBe('pass');
      expect(record.evidence.contentDigest.value).toMatch(/^[0-9a-f]{64}$/);

      const references = (data as unknown as {
        evidenceReferences?: readonly { contentDigest: { value: string } }[];
      }).evidenceReferences;
      expect(references, 'the gate carrier must reference its durable evidence').toBeDefined();
      expect(
        (references ?? []).some(
          (r) => r.contentDigest.value === record.evidence.contentDigest.value,
        ),
      ).toBe(true);
    },
    120_000,
  );
});

/**
 * These tests call the composite handler directly, without `dispatch()`.
 * Thus `orchestrate` opens the trusted dispatch scope and seeds an active phase attempt once for each workflow.
 * Without the scope, the gate fails with `TRUSTED_CALLER_REQUIRED`.
 * Without the attempt, it fails with `ACTIVE_PHASE_ATTEMPT_REQUIRED`.
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
