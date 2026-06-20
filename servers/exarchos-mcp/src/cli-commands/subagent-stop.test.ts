import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import { handleSubagentStop, resolveTeammateByWorktree } from './subagent-stop.js';

// #1525 W2 Half 1 (H1-A) — the restored SubagentStop hook reads the subagent's
// own transcript, sums output tokens, resolves teammate identity by matching the
// subagent cwd to a dispatched worktree, and appends subagent.tokens_used to the
// feature stream. Observe-only / fail-open: never blocks a subagent.

describe('handleSubagentStop (#1525 W2 H1-A)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-stop-'));
    store = new EventStore(tmpDir);
    await store.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('SubagentStop_ResolvesTeammate_ByWorktreeMatch_EmitsAtom', async () => {
    await store.append('feat-1', {
      type: 'team.task.assigned',
      data: { taskId: 'T-9', teammateName: 'alice', worktreePath: '/tmp/wt-a', modules: ['m'] },
    });

    const result = await handleSubagentStop(
      {
        agent_id: 'agent-xyz',
        agent_type: 'exarchos-implementer',
        agent_transcript_path: '/tmp/fake-transcript.jsonl',
        cwd: '/tmp/wt-a',
        session_id: 'sess-1',
      },
      tmpDir,
      { eventStore: store, readTranscriptOutputTokens: async () => 4200 },
    );

    expect(result).toEqual({ continue: true });
    const emitted = await store.query('feat-1', { type: 'subagent.tokens_used' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data).toMatchObject({
      agentId: 'agent-xyz',
      agentType: 'exarchos-implementer',
      outputTokens: 4200,
      teammateName: 'alice',
      taskId: 'T-9',
      cwd: '/tmp/wt-a',
    });
  });

  it('SubagentStop_NoWorktreeMatch_FailsOpen_NoEmit', async () => {
    await store.append('feat-1', {
      type: 'team.task.assigned',
      data: { taskId: 'T-9', teammateName: 'alice', worktreePath: '/tmp/wt-a', modules: [] },
    });

    const result = await handleSubagentStop(
      { agent_id: 'agent-xyz', agent_transcript_path: '/x.jsonl', cwd: '/tmp/UNMATCHED', session_id: 's' },
      tmpDir,
      { eventStore: store, readTranscriptOutputTokens: async () => 100 },
    );

    expect(result).toEqual({ continue: true });
    expect(await store.query('feat-1', { type: 'subagent.tokens_used' })).toHaveLength(0);
  });

  it('SubagentStop_MissingAgentIdOrTranscript_FailsOpen', async () => {
    const r1 = await handleSubagentStop({ cwd: '/tmp/wt-a' }, tmpDir, { eventStore: store });
    expect(r1).toEqual({ continue: true });
    const r2 = await handleSubagentStop({ agent_id: 'a' }, tmpDir, { eventStore: store });
    expect(r2).toEqual({ continue: true });
  });

  it('SubagentStop_TranscriptReaderReturnsNull_NoEmit', async () => {
    await store.append('feat-1', {
      type: 'team.task.assigned',
      data: { taskId: 'T-9', teammateName: 'alice', worktreePath: '/tmp/wt-a', modules: [] },
    });
    const result = await handleSubagentStop(
      { agent_id: 'a', agent_transcript_path: '/x', cwd: '/tmp/wt-a' },
      tmpDir,
      { eventStore: store, readTranscriptOutputTokens: async () => null },
    );
    expect(result).toEqual({ continue: true });
    expect(await store.query('feat-1', { type: 'subagent.tokens_used' })).toHaveLength(0);
  });

  it('SubagentStop_DedupesByAgentId_OnRetry', async () => {
    await store.append('feat-1', {
      type: 'team.task.assigned',
      data: { taskId: 'T-9', teammateName: 'alice', worktreePath: '/tmp/wt-a', modules: [] },
    });
    const payload = {
      agent_id: 'agent-dup',
      agent_transcript_path: '/x.jsonl',
      cwd: '/tmp/wt-a',
      session_id: 's',
    };
    const deps = { eventStore: store, readTranscriptOutputTokens: async () => 7 };
    await handleSubagentStop(payload, tmpDir, deps);
    await handleSubagentStop(payload, tmpDir, deps); // retry — must not double-count

    expect(await store.query('feat-1', { type: 'subagent.tokens_used' })).toHaveLength(1);
  });

  it('resolveTeammateByWorktree_FromDispatched_CarriesFirstTaskId', async () => {
    await store.append('feat-2', {
      type: 'team.teammate.dispatched',
      data: { teammateName: 'bob', worktreePath: '/tmp/wt-b', assignedTaskIds: ['T-2'], model: 'opus' },
    });
    const r = await resolveTeammateByWorktree(store, '/tmp/wt-b');
    expect(r).toEqual({ featureId: 'feat-2', teammateName: 'bob', taskId: 'T-2' });
  });

  it('resolveTeammateByWorktree_NoMatch_ReturnsNull', async () => {
    const r = await resolveTeammateByWorktree(store, '/tmp/nope');
    expect(r).toBeNull();
  });

  it('resolveTeammateByWorktree_ReusedWorktree_PrefersMostRecentStream', async () => {
    // A worktree path can be reused across features over time. The resolver must
    // attribute to the MOST RECENT owner by timestamp, not the first encountered
    // (taking the first would misattribute tokens to a stale stream — #1560).
    await store.append('old-feat', {
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'team.task.assigned',
      data: { taskId: 'OLD-1', teammateName: 'old-owner', worktreePath: '/tmp/shared-wt', modules: [] },
    });
    await store.append('new-feat', {
      timestamp: '2026-06-01T00:00:00.000Z',
      type: 'team.task.assigned',
      data: { taskId: 'NEW-1', teammateName: 'new-owner', worktreePath: '/tmp/shared-wt', modules: [] },
    });

    const r = await resolveTeammateByWorktree(store, '/tmp/shared-wt');
    expect(r).toEqual({ featureId: 'new-feat', teammateName: 'new-owner', taskId: 'NEW-1' });
  });

  it('SubagentStop_ZeroOutputTokens_NoEmit', async () => {
    // A zero-token run carries no usage signal; skip the atom so per-run token
    // metrics stay clean (the run is already recorded by dispatch/completion).
    await store.append('feat-1', {
      type: 'team.task.assigned',
      data: { taskId: 'T-9', teammateName: 'alice', worktreePath: '/tmp/wt-a', modules: [] },
    });
    const result = await handleSubagentStop(
      { agent_id: 'agent-zero', agent_transcript_path: '/x.jsonl', cwd: '/tmp/wt-a', session_id: 's' },
      tmpDir,
      { eventStore: store, readTranscriptOutputTokens: async () => 0 },
    );
    expect(result).toEqual({ continue: true });
    expect(await store.query('feat-1', { type: 'subagent.tokens_used' })).toHaveLength(0);
  });

  it('SubagentStop_MalformedPayload_FailsOpen', async () => {
    // Non-string load-bearing fields fail safeParse → fail-open, no throw/emit.
    const result = await handleSubagentStop(
      { agent_id: 123, agent_transcript_path: '/x.jsonl', cwd: '/tmp/wt-a' },
      tmpDir,
      { eventStore: store, readTranscriptOutputTokens: async () => 50 },
    );
    expect(result).toEqual({ continue: true });
  });
});
