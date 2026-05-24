// Regression harness for #1145: verifies preflight.* events actually
// persist to a real EventStore, not just that a mock's .append was called.
//
// The v2.8.1 fix for #1129 added store.append() call sites for preflight
// events. The existing unit tests assert on mockStore.append.mock.calls,
// which only proves the handler *invoked* the append. Live MCP testing
// revealed events are being silently dropped — this harness exercises the
// real store through the production code path and queries it after the
// handler returns.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePrepareDelegation } from './prepare-delegation.js';
import { handleSetupWorktree } from './setup-worktree.js';
import { handleOrchestrate } from './composite.js';
import { resetMaterializerCache } from '../views/tools.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

vi.mock('./dispatch-guard.js', () => ({
  validateBranchAncestry: vi.fn().mockResolvedValue({ passed: true, checks: ['ancestry'] }),
  assertMainWorktree: vi.fn().mockReturnValue({
    isMain: true,
    actual: '/fake/repo',
    expected: 'main worktree (no .claude/worktrees/ in path)',
  }),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  assertCurrentBranchNotProtected: vi.fn().mockReturnValue({
    blocked: true,
    reason: 'current-branch-protected',
    currentBranch: 'main',
  }),
  // #1261 — stash probe is fire-and-forget; default to a no-op for this
  // integration test, which exercises the blocked-protected-branch
  // short-circuit only.
  probeStashAndEmit: vi.fn().mockResolvedValue(undefined),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-deleg-integ-'));
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function flushAsyncQueue(ms = 50): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(queueMicrotask);
    await new Promise(resolve => setImmediate(resolve));
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('handlePrepareDelegation — event persistence (integration)', () => {
  it('persists preflight.blocked to the injected EventStore when branch is protected', async () => {
    const args = { featureId: 'test-integration-stream' };
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const result = await handlePrepareDelegation(args, tmpDir, ctx);
    await flushAsyncQueue();

    expect(result.success).toBe(true);
    const data = result.data as {
      blocked: boolean;
      reason: string;
      currentBranch: string;
    };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');
    expect(data.currentBranch).toBe('main');

    const events = await ctxStore.query('test-integration-stream', {
      type: 'preflight.blocked',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('preflight.blocked');
    const eventData = events[0]?.data as {
      reason: string;
      details: { currentBranch: string };
    };
    expect(eventData.reason).toBe('current-branch-protected');
    expect(eventData.details.currentBranch).toBe('main');
  });

  // The constructor-injection refactor (#1182) requires every reader to
  // share the same EventStore instance the handler used. A "freshReader"
  // EventStore at the same stateDir must still see events on disk, but
  // sequence-counter coherence is only guaranteed when the same instance
  // is used for both writes and reads — that is enforced by single-
  // composition-root wiring at the MCP server level. This test verifies
  // the on-disk events are present (write-side persistence).
  it('event persists to disk and is readable by a second EventStore instance', async () => {
    const args = { featureId: 'test-cross-instance' };
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    await handlePrepareDelegation(args, tmpDir, ctx);
    await flushAsyncQueue(200);

    const freshReader = new EventStore(tmpDir);
    const events = await freshReader.query('test-cross-instance', {
      type: 'preflight.blocked',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('preflight.blocked');
  });

  // Reproduces the EXACT production MCP call path: handleOrchestrate
  // dispatched with a DispatchContext whose ctx.eventStore is a distinct
  // instance from the factory-cached store the handler uses internally.
  // This is the drift that caused #1129's partial regression to escape.
  it('preflight.blocked persists when dispatched via handleOrchestrate with DispatchContext', async () => {
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const result = await handleOrchestrate(
      { action: 'prepare_delegation', featureId: 'test-composite-stream' },
      ctx,
    );
    await flushAsyncQueue(200);

    expect(result.success).toBe(true);
    const data = result.data as { blocked: boolean; reason: string };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');

    const events = await ctxStore.query('test-composite-stream', {
      type: 'preflight.blocked',
    });
    expect(events).toHaveLength(1);
  });

  // Race reproduction: a caller that queries IMMEDIATELY after the dispatch
  // response returns (no flush, no sleep) — exactly what a downstream MCP
  // client does. The event must be visible the moment the dispatch returns,
  // not "eventually." This is the failure mode that surfaced in the v2.8.1
  // dogfood re-verify: the handler returned blocked, the caller queried,
  // the stream was empty. Fire-and-forget appends are not synchronous with
  // the dispatch response, so any "read your writes" MCP caller races.
  it('preflight.blocked is visible the moment handleOrchestrate returns (no flush)', async () => {
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    await handleOrchestrate(
      { action: 'prepare_delegation', featureId: 'test-race-stream' },
      ctx,
    );

    // Intentionally no flush — mirrors a subsequent MCP call from the
    // same client reading its own writes.
    const events = await ctxStore.query('test-race-stream', {
      type: 'preflight.blocked',
    });
    expect(events).toHaveLength(1);
  });
});

// ─── T-09 (#1301): Working-tree mirroring-leak root-cause characterization ────
//
// characterizationRequired: true
//
// #1301 symptom: an implementer agent's worktree edits surface as
// byte-identical UNCOMMITTED modifications in the orchestrator's MAIN
// worktree. The issue's leading hypothesis (#1) is a "file-tool path
// resolution leak" — an agent file-write resolving to BOTH the worktree path
// AND the equivalent main-worktree path.
//
// This block characterizes whether that leak can originate in
// MCP-SERVER-OWNED code. The server's entire surface area for "where an agent
// will write" is the worktree it provisions via `handleSetupWorktree`
// (`git worktree add <repoRoot>/.worktrees/<task>`). The server never spawns
// the agent and never resolves the agent's individual file-write targets —
// that is the Claude Code harness / file-tool layer, outside this repo.
//
// INV-11 (by-construction worktree isolation) on the server side reduces to a
// single provable invariant: every path the server hands off as an agent
// write root MUST live strictly inside `<repoRoot>/.worktrees/`, NEVER the
// main worktree root. These tests assert exactly that. If the server resolved
// a write target to the main worktree, the leak would reproduce here; if it
// cannot, the root fix is a harness-layer concern (escalated to RC2), with
// T-08's `verify-worktree-baseline` backstop as the shipping mitigation.
describe('ImplementerDispatch_WorktreeEdit_DoesNotAppearInMainWorktree (characterization, #1301)', () => {
  let repoRoot: string;

  function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rootcause-1301-'));
    git(repoRoot, ['init', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    // Seed a committed file so the agent worktree has a real main-worktree
    // counterpart to (not) leak into.
    await fs.writeFile(path.join(repoRoot, 'src.txt'), 'baseline\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'baseline']);
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('resolves the agent write-root strictly inside <repoRoot>/.worktrees/, never the main worktree', () => {
    const result = handleSetupWorktree({
      repoRoot,
      taskId: 'T-99',
      taskName: 'leak-probe',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { worktreePath: string; passed: boolean };

    const worktreesRoot = path.join(repoRoot, '.worktrees') + path.sep;
    // The write root must be UNDER .worktrees/ — not the repoRoot itself and
    // not a sibling escaping the isolation boundary.
    expect(data.worktreePath.startsWith(worktreesRoot)).toBe(true);
    expect(path.resolve(data.worktreePath)).not.toBe(path.resolve(repoRoot));
    // A real, distinct worktree was provisioned (git sees a separate gitdir).
    expect(existsSyncSafe(data.worktreePath)).toBe(true);
  });

  it('an agent-side write into its worktree does NOT mirror into the main worktree', () => {
    const setup = handleSetupWorktree({
      repoRoot,
      taskId: 'T-99',
      taskName: 'leak-probe',
      skipTests: true,
    });
    const { worktreePath } = setup.data as { worktreePath: string };

    // Simulate the agent's file-tool write happening at the path the SERVER
    // handed it. If server path-resolution leaked, the byte-identical content
    // would also appear at the main worktree's copy of the same file.
    const agentFile = path.join(worktreePath, 'src.txt');
    execFileSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(agentFile)}, 'agent-edit\\n')`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // The agent's edited path (src.txt) must NOT surface as a modification in
    // the main worktree. (`handleSetupWorktree` step 1 writes `.gitignore`
    // into the main worktree by design — that is provisioning, not a leak, so
    // we assert specifically on the agent-edited path, not whole-tree
    // cleanliness.)
    const mainStatus = git(repoRoot, ['status', '--porcelain']);
    const leakedPaths = mainStatus
      .split('\n')
      .map(l => l.slice(2).trim())
      .filter(p => p === 'src.txt');
    expect(leakedPaths).toEqual([]);
    // And the main worktree's file is untouched.
    const mainContent = execFileSync('cat', [path.join(repoRoot, 'src.txt')], {
      encoding: 'utf-8',
    });
    expect(mainContent).toBe('baseline\n');
  });
});

function existsSyncSafe(p: string): boolean {
  try {
    execFileSync('git', ['-C', p, 'rev-parse', '--git-dir'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
