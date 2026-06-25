// ─── check_mock_boundary ACCEPTANCE — through handleOrchestrate (task 026) ────
//
// Verification-ladder slice 1, SIV-4 (#1530). The end-to-end contract: dispatch
// `check_mock_boundary` through the composite `handleOrchestrate` router against
// a real temp-dir git fixture repo and prove the gate distinguishes:
//
//   • UNOWNED mock — a task diff adds a test file that mocks a third-party
//     dependency (`vi.mock('axios')`) outside the first-party ownership scope →
//     advisory pass (severity advisory by default), carrying the finding AND a
//     per-finding steer in next_actions that names the dependency and prescribes
//     a hermetic replacement.
//   • FIRST-PARTY mock — a task diff mocks a relative module that resolves under
//     the first-party globs (`vi.mock('../foo.js')`) → clean pass, no findings.
//   • CONFIG OVERRIDE — a `.exarchos.yml` review-gate override flips the gate to
//     blocking; the advisory carrier honors it (severity:'blocking').
//   • ESCAPE HATCH — when the caller acknowledges an intentional unowned mock via
//     an explicit `reason`, the gate passes advisory AND the gate.executed event
//     payload records the escape hatch + reason (an enforced default, not an
//     absolute).
//
// This file is the acceptance gate; it stays RED until the action is registered
// and the dispatch branch wired.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import { rmrf } from '../test-helpers/temp-dir.js';

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

/**
 * Scaffold a fixture repo on `main`: a source module + a base test, plus an
 * optional `.exarchos.yml`. The first-party scope defaults to `src/**`, so a
 * relative mock of `../foo.js` from `src/foo.test.ts` is OWNED, while a bare
 * `axios` mock is UNOWNED.
 */
function writeBaseProject(repoRoot: string, exarchosYml?: string): void {
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'foo.ts'), 'export const foo = () => 1;\n');
  writeFileSync(
    path.join(repoRoot, 'src', 'foo.test.ts'),
    "import { foo } from './foo.js';\nfoo();\n",
  );
  if (exarchosYml !== undefined) {
    writeFileSync(path.join(repoRoot, '.exarchos.yml'), exarchosYml);
  }
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base: src + test', '-q']);
}

function makeCtx(stateDir: string, eventStore: EventStore): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false } as DispatchContext;
}

interface MockBoundaryData {
  passed: boolean;
  findings?: Array<{ file: string; identifier: string; mockedTarget: string; unowned: boolean }>;
  next_actions?: string[];
  severity?: string;
  escapeHatch?: { acknowledged: boolean; reason: string };
  skipped?: boolean;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('check_mock_boundary acceptance (through handleOrchestrate)', () => {
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
    extra: Record<string, unknown> = {},
  ): Promise<{ result: { success: boolean; data: MockBoundaryData }; eventStore: EventStore; featureId: string }> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mock-boundary-state-'));
    cleanups.push(() => rmrf(stateDir));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const ctx = makeCtx(stateDir, eventStore);
    const featureId = 'feat-mock-boundary';
    const result = await handleOrchestrate(
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

  it(
    'HandleOrchestrate_CheckMockBoundary_UnownedMock_AdvisoryWithSteerNextAction',
    async () => {
      const repoRoot = initRepo('mock-boundary-unowned-');
      cleanups.push(() => rmrf(repoRoot));
      writeBaseProject(repoRoot);

      // Branch: add a test file that mocks a third-party dependency.
      git(repoRoot, ['checkout', '-b', 'feature/unowned', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'http.test.ts'),
        "import axios from 'axios';\nvi.mock('axios');\naxios.get('/x');\n",
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'test: mock axios', '-q']);

      const { result } = await dispatch(repoRoot, 'feature/unowned');
      const { success, data } = result;

      // Advisory carrier: tool call SUCCEEDS, gate verdict advisory (passes).
      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.severity).toBe('warning');

      // Carries the unowned finding.
      // Optional-chaining over non-null assertions (PR #1535 CR-2): if the
      // Array.isArray expectation fails, execution still reaches the next
      // lines — `?.` keeps them well-defined instead of hiding an undefined.
      expect(Array.isArray(data.findings)).toBe(true);
      expect(data.findings?.length ?? 0).toBeGreaterThan(0);
      const axiosFinding = data.findings?.find((f) => f.mockedTarget === 'axios');
      expect(axiosFinding).toBeDefined();
      expect(axiosFinding?.unowned).toBe(true);

      // Per-finding steer (INV-12 + SIV-5 resolution #1531): names the dep, and
      // since axios classifies as third-party-http, resolves the CONCRETE
      // hermetic double (a Pact-verified contract stub) rather than a generic menu.
      expect(Array.isArray(data.next_actions)).toBe(true);
      const steer = data.next_actions?.find((s) => s.includes('axios'));
      expect(steer).toBeDefined();
      expect(steer ?? '').toMatch(/replace the mock/i);
      expect(steer ?? '').toMatch(/third-party-http/i);
      expect(steer!).toMatch(/Pact-verified contract stub/i);
    },
    120_000,
  );

  it(
    'HandleOrchestrate_CheckMockBoundary_FirstPartyMock_Passes',
    async () => {
      const repoRoot = initRepo('mock-boundary-firstparty-');
      cleanups.push(() => rmrf(repoRoot));
      writeBaseProject(repoRoot);

      // Branch: add a test that mocks a FIRST-PARTY relative module. `./foo.js`
      // resolves against the diff file's directory (`src/bar.test.ts` → `src/`),
      // so the target is `src/foo.js` — under the `src/**` first-party scope.
      git(repoRoot, ['checkout', '-b', 'feature/firstparty', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'bar.test.ts'),
        "import { foo } from './foo.js';\nvi.mock('./foo.js');\nfoo();\n",
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'test: mock first-party foo', '-q']);

      const { result } = await dispatch(repoRoot, 'feature/firstparty');
      const { success, data } = result;

      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      // First-party mocks are filtered out by the pure core → no findings.
      expect(data.findings ?? []).toEqual([]);
      // No unowned finding → no steer.
      expect(data.next_actions ?? []).toEqual([]);
    },
    120_000,
  );

  it(
    'CheckMockBoundary_ConfigOverrideBlocking_StillHonored',
    async () => {
      const repoRoot = initRepo('mock-boundary-blocking-');
      cleanups.push(() => rmrf(repoRoot));
      // `.exarchos.yml` flips the gate to blocking via a review-gate override.
      writeBaseProject(
        repoRoot,
        ['review:', '  gates:', '    mock-boundary:', '      blocking: true', ''].join('\n'),
      );

      git(repoRoot, ['checkout', '-b', 'feature/blocking', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'http.test.ts'),
        "import axios from 'axios';\nvi.mock('axios');\naxios.get('/x');\n",
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'test: mock axios', '-q']);

      const { result } = await dispatch(repoRoot, 'feature/blocking');
      const { success, data } = result;

      // The config override flips severity to blocking; the unowned finding is
      // still present, but now the gate result reflects the blocking posture.
      expect(success).toBe(true);
      expect(data.severity).toBe('blocking');
      // Blocking + an unowned finding → the gate does NOT pass.
      expect(data.passed).toBe(false);
      expect(data.findings?.some((f) => f.mockedTarget === 'axios') ?? false).toBe(true);
    },
    120_000,
  );

  it(
    'GateEvent_EscapeHatch_LoggedInPayload',
    async () => {
      const repoRoot = initRepo('mock-boundary-escape-');
      cleanups.push(() => rmrf(repoRoot));
      writeBaseProject(repoRoot);

      git(repoRoot, ['checkout', '-b', 'feature/escape', '-q']);
      writeFileSync(
        path.join(repoRoot, 'src', 'http.test.ts'),
        "import axios from 'axios';\nvi.mock('axios');\naxios.get('/x');\n",
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'test: mock axios (intentional)', '-q']);

      const reason = 'axios stubbed at the transport boundary; covered by a separate contract test';
      const { result, eventStore, featureId } = await dispatch(repoRoot, 'feature/escape', {
        reason,
      });
      const { success, data } = result;

      // With the escape hatch acknowledged, the gate passes advisory regardless
      // of the unowned finding, and the carrier records the acknowledgement.
      expect(success).toBe(true);
      expect(data.passed).toBe(true);
      expect(data.escapeHatch).toBeDefined();
      expect(data.escapeHatch!.acknowledged).toBe(true);
      expect(data.escapeHatch!.reason).toBe(reason);

      // The gate.executed event payload records the escape hatch + reason.
      const events = await eventStore.query(featureId, { type: 'gate.executed' });
      expect(events.length).toBeGreaterThan(0);
      const gateEvent = events[events.length - 1];
      const eventData = gateEvent.data as {
        gateName: string;
        details?: { escapeHatch?: { acknowledged: boolean; reason: string } };
      };
      expect(eventData.gateName).toBe('mock-boundary');
      expect(eventData.details?.escapeHatch).toBeDefined();
      expect(eventData.details!.escapeHatch!.acknowledged).toBe(true);
      expect(eventData.details!.escapeHatch!.reason).toBe(reason);
    },
    120_000,
  );
});
