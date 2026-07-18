# Subagent token-capture proof run (DR-19, #1561)

**Date:** 2026-07-17/18 · **Session:** background job `be059575` (v2-12-bundle delegate wave) · **Task:** v2-12-bundle 024-wave task 018

## Objective

DR-19 acceptance: one live worktree-isolated dispatch with the SubagentStop hook registered produces `subagent.tokens_used`, visible in `team_performance` and `delegation_timeline`, with evidence attached to #1561 before close.

## Environment

- SubagentStop hook registered at **both** surfaces: user `~/.claude/settings.json` (`exarchos subagent-stop`, confirmed key present) and the plugin's `hooks/hooks.json`.
- `exarchos` CLI 2.12.0-preview.3 on PATH.
- Live event store: `~/.claude/workflow-state/exarchos.db` (note: `~/.exarchos/state/exarchos.db` exists but is stale — last write 2026-07-14; anyone auditing capture must check the workflow-state path).

## Findings

### 1. PROVEN — hook → event pipeline works end-to-end

The same session's earlier (pre-context-clear) delegate flow, which followed the full playbook (`team.spawned` → `team.task.planned` → `team.teammate.dispatched` per agent), produced **61 `subagent.tokens_used` events** on the `risk-verification-closeout` stream, newest at `2026-07-17T21:40:35.942Z`. Sample payload:

```json
{
  "agentId": "ab6dc0477be204127",
  "outputTokens": 24825,
  "teammateName": "impl-008",
  "taskId": "008",
  "agentType": "general-purpose",
  "sessionId": "be059575-96f3-4023-9e89-e70a52de34b2",
  "cwd": "/home/reedsalus/Documents/code/lvlup-sw/exarchos"
}
```

Worktree-isolated dispatch, real token counts, correct task attribution. The capture seam (SubagentStop hook reading its own transcript) is live and functional.

### 2. GAP A — unregistered dispatches are silently dropped

The post-clear wave in the same session dispatched **11 worktree-isolated Agent-tool subagents without per-agent `team.teammate.dispatched` registration** (the stream carried only the prior orchestrator's stale teammate registrations). Result: **0 of 11 stops produced a `subagent.tokens_used` event** (verified across all streams: no event of this type newer than `21:40Z`; sync `outbox` empty, so nothing was queued). The drop is **silent** — no structured skip event, no diagnostic residue found.

Live probe: teammate registration for the one still-in-flight agent (`task-012`, event seq 113 on `v2-12-bundle`) was emitted *before* its stop; the capture outcome is recorded on #1561.

**Hypothesis:** `exarchos subagent-stop` resolves attribution via teammate registration and drops the append when the stopping agent matches no registered teammate. Whatever the precise key, an *attribution-miss should leave a trace* (a structured skip log or a dead-letter event), not vanish.

### 3. GAP B — both views return empty despite 61 events on the stream

Queried from this session against `risk-verification-closeout` (the stream with 61 capture events **and** a full `team.*` event set including `team.spawned`/`team.teammate.dispatched` ×4/`team.disbanded`):

- `team_performance` → `{"teammates": {}}`
- `delegation_timeline` → `tasks: [], totalDurationMs: 0, scope: "correlation", unscopedTotal: 0`

The `scope: "correlation"` marker suggests the timeline folds only events correlated to the *current* session/operation, which would make historical proof runs invisible by construction — but `team_performance` is empty too. Either way, the DR-19 criterion "visible in both views showing non-zero tokens" **fails as observed**, for a stream where the raw events demonstrably exist.

## Verdict

| Claim | Status |
|---|---|
| Hook fires and appends `subagent.tokens_used` with real token counts (worktree-isolated dispatch) | **Proven** |
| Capture is robust to playbook drift (unregistered dispatches) | **Failed** — silent drop, 11/11 lost |
| Events visible in `team_performance` | **Failed** (empty) |
| Events visible in `delegation_timeline` | **Failed** (empty, `scope: "correlation"`) |

#1561 should stay **open**: the capture seam works, but the acceptance criterion is not met end-to-end. Follow-ups worth filing: (a) structured skip/dead-letter on attribution miss in `subagent-stop`; (b) view-layer fold audit for `team_performance`/`delegation_timeline` against historical streams; (c) the stale-DB split (`~/.exarchos/state` vs `~/.claude/workflow-state`) as an operator footgun.
