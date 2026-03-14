# Design: Session Provenance Capture & Event Emission Hardening

**Date:** 2026-02-24
**Status:** Decided
**Scope:** Transcript-based deterministic capture of session data for workflow correlation, code attribution, and intelligence flywheel — plus event emission architecture audit and remediation

---

## 1. Problem Statement

Exarchos captures **workflow-level events** (phase transitions, task completions, team actions) but has no visibility into **session-level activity** (what prompts were sent, what tools were called, what code was generated, how many tokens were consumed).

This gap means:

- **No code attribution.** We know which teammate modified which files, but not which tool calls produced which lines.
- **No cost tracking.** Token consumption per task, per workflow, per strategy is unknown.
- **No reasoning provenance.** When a task fails or produces poor code, there's no record of the reasoning chain that led there.
- **Coarse flywheel signal.** Thompson Sampling on the Basileus backend operates on pass/fail outcomes. Rich behavioral data (tool call patterns, retry frequency, file modification sequences) would enable finer-grained strategy optimization.

### Competitive Context

Entire.io (former GitHub CEO, $60M seed) shipped a Checkpoints CLI that captures full AI agent session transcripts alongside git commits. Their approach: store everything in git shadow branches, make sense of it later.

Our positioning is different — we're an orchestration engine, not a passive recorder. But their provenance capture highlights a gap in our story: we direct what agents do, but we can't fully account for what they did.

The question is not "should we capture session data?" but "how do we capture it in a way that feeds our orchestration model rather than just creating archives?"

### Event Emission Reliability

An audit of the existing event emission architecture (Section 8) revealed two contract violations and multiple gaps. Session provenance depends on a trustworthy event foundation — if workflow events themselves are unreliable, correlating session data to workflows produces unreliable intelligence. This design addresses both layers.

---

## 2. Context

### Transcript Format (Verified)

Claude Code writes a JSONL transcript at `~/.claude/projects/{project-hash}/{session-uuid}.jsonl`. The `transcript_path` field is available in **all** hook payloads (SessionStart, SessionEnd, PreCompact, Stop, PostToolUse, etc.).

Each line is a JSON object with a `type` discriminant:

| `type` | Content | Key Fields |
|--------|---------|------------|
| `assistant` | Full Anthropic API response | `content[]` (tool_use blocks with name/input), `usage` (token breakdown), `model`, `stop_reason` |
| `user` | Prompts AND tool results | `toolUseResult` (structured), `message.content[]` (text), linked by `tool_use_id` |
| `progress` | Streaming updates | `data.type` (agent_progress, hook_progress) |
| `system` | Metadata | `subtype: "turn_duration"` with `durationMs` |
| `file-history-snapshot` | File state for undo | File paths and content |

Every entry carries: `sessionId`, `timestamp` (ISO 8601), `uuid`, `parentUuid`, `cwd`, `gitBranch`, `version`.

**Data availability comparison:**

| Data | In PostToolUse Hook? | In Transcript? |
|------|---------------------|----------------|
| Tool name + input + output | Yes | Yes |
| **Token usage** (input, output, cache) | **No** | **Yes** |
| **Timestamps** | **No** | **Yes** |
| **Model used** | **No** | **Yes** (per assistant turn) |
| **Turn duration** | **No** | **Yes** (`durationMs`) |
| **Conversation tree** | **No** | **Yes** (`uuid`/`parentUuid`) |
| Session metadata (full) | Partial | Yes (`model`, `version`, `gitBranch`, `slug`) |

**Key finding:** Token usage, timestamps, and model metadata are transcript-only. Any approach that skips transcript parsing cannot do cost tracking.

### External Validation

MLflow's Claude Code tracing integration (documented on Microsoft Learn) uses hooks (`ConversationStart`/`ConversationTurn`/`Stop`) to capture session data and send it to Databricks. This validates hook-based session capture as a production-proven pattern.

### Current Event Emission Model

Events are emitted through multiple paths with varying reliability guarantees (see full audit in Section 8):

1. **Event-first via MCP tools** — `handleInit`, `handleSet`: events appended to JSONL before state mutation, idempotency keys prevent duplicates. **Reliable.**
2. **Fire-and-forget via middleware** — telemetry `tool.*` events: swallowed on failure, no idempotency. **By design for auxiliary data.**
3. **Direct JSONL bypass** — `gates.ts` `appendTeamEvent`: raw `fs.appendFile` outside EventStore, uses `Date.now()` as sequence. **Violates sequence invariant.**
4. **Best-effort with swallowed failures** — `handleCancel`: claims event-first but `catch {}` blocks allow state mutation on event failure. **Violates event-first contract.**

### Storage Architecture

Per the [storage-layer-audit](./2026-02-21-storage-layer-audit.md):
- **JSONL** is the durable append-only event log (source of truth)
- **SQLite** (`better-sqlite3`) is the runtime query engine, hydrated from JSONL on startup
- Write path: JSONL append (durable) → SQLite INSERT (derived index)
- Read path: SQLite SELECT (indexed, <1ms)
- Startup: JSONL scan → hydrate SQLite (one-time, <500ms for 5K events)

Telemetry volume is already flagged as a concern (F15): "Telemetry adds 2-3 event appends per tool call — growing a dedicated stream that compounds all read-path issues."

---

## 3. Constraints

### C1: Performance budget

A typical coding session involves 200-2000 tool calls. Capturing must not degrade the developer experience.

- **Hook subprocess cost.** Every hook invocation spawns a new Node.js process (~100-200ms cold start).
- **I/O budget.** Each capture event requires at minimum one `appendFile` call (~0.5ms).
- **SQLite hydration.** Session events must not be hydrated into the main SQLite at startup.
- **Claude Code hook timeout.** PostToolUse has a configurable timeout (default 2s). SessionEnd timeout varies.

### C2: Storage volume

| Stream | Events per session | Size per event | Session total |
|--------|-------------------|----------------|---------------|
| Workflow | N/A (lifecycle-scoped) | ~200-500B | — |
| Telemetry (existing) | 100-300 (MCP tools only) | ~150B | ~15-45KB |
| Session provenance | 200-2000 (all tools) | ~200-500B | ~40KB-1MB |

### C3: Separation from workflow event pipeline

Session data characteristics (write-heavy, read-rarely, high volume, session-scoped) are fundamentally different from workflow events (read-heavy, low volume, lifecycle-scoped). Routing session data through the main EventStore would inflate all I/O paths.

### C4: Determinism requirement

Session provenance must be captured by infrastructure, not by model behavior. The model should emit **domain events** (semantic decisions). Infrastructure should emit **infrastructure events** (factual records).

### C5: Token economy

Session capture must consume **zero agent context**. Must not appear in tool responses, inflate views, or require model cooperation.

### C6: Flywheel utility

Captured data must be queryable in a way that feeds the intelligence flywheel: tool call patterns → Thompson Sampling, file modifications → code attribution, token consumption → cost optimization, retry patterns → Task Router scoring.

### C7: Guaranteed completeness

Session provenance must satisfy the event-sourcing contract: every tool call captured, or the session is marked incomplete. Best-effort is insufficient for auditability.

---

## 4. Decision: Session Boundary ETL (Enhanced Option C)

### Selected Approach

Extract structured events from Claude Code's transcript at session boundaries. The transcript is the **authoritative external event source**; we build an **anti-corruption layer** that transforms it into our domain model.

**Why this approach wins:**

1. **Guaranteed completeness (C7).** The transcript is Claude Code's own record — it's the most complete source. PostToolUse hooks can timeout or be killed; the transcript always exists if the session ran.
2. **Zero per-tool-call overhead (C1).** No PostToolUse hook spawning 200-2000 processes. Two hook invocations per session (SessionStart + SessionEnd), not thousands.
3. **Full data set in one pass.** Token usage, timestamps, model metadata are transcript-only — PostToolUse hooks don't carry them. Transcript ETL captures everything.
4. **No real-time need.** Flywheel consumers (Thompson Sampling, Task Router) operate asynchronously after task completion. Mid-session queries are unnecessary.
5. **Clean separation (C3).** Session events live in a separate storage tier, never touching the main EventStore or SQLite hydration path.

**Why other options were eliminated:**

- **Option A (PostToolUse hooks):** Cannot guarantee completeness — hooks can fail. Missing token/timing data. 200-2000 subprocess spawns per session.
- **Option B (Extend telemetry):** Violates F15 (telemetry volume already flagged). Mixes operational telemetry with session provenance. Forces SQLite hydration.
- **Option D (Unix socket):** Solves the wrong problem (per-tool-call latency) which isn't needed without PostToolUse hooks. Significant new infrastructure for no benefit.

---

## 5. Architecture

### Three-Category Event Model

This design formalizes three distinct event categories with different emission guarantees:

| Category | Examples | Emission Method | Guarantee |
|----------|---------|----------------|-----------|
| **Domain events** | `workflow.started`, `workflow.transition`, `task.claimed` | Model-initiated → tool handler emits event-first (before state mutation) with idempotency keys | Strong: event-first contract, CAS retry, idempotent |
| **Infrastructure events** | `tool.invoked/completed/errored`, `team.task.completed/failed` | Hook-driven or middleware-driven, zero model cooperation | Medium: fire-and-forget, best-effort (auxiliary) |
| **Session events** | Tool calls, token usage, file modifications, timestamps | Transcript-extracted at session boundary | Guaranteed: transcript is authoritative source |

### Write Path

```
SessionStart hook                    SessionEnd hook
      │                                    │
      ▼                                    ▼
Record manifest entry          Parse transcript_path JSONL
(session_id, workflow_id,      Extract structured events
 transcript_path, timestamp)   Batch-write to session JSONL
      │                                    │
      ▼                                    ▼
sessions/.manifest.jsonl       sessions/{session_id}.events.jsonl
```

**SessionStart hook** (enhanced existing):
1. Read JSON from stdin (contains `session_id`, `transcript_path`, `cwd`)
2. Resolve active workflow ID from state directory (existing logic)
3. Append manifest entry: `{ sessionId, workflowId, transcriptPath, startedAt, cwd, branch }`
4. Write to `sessions/.manifest.jsonl` (one line, ~200B)
5. Prune stale session files older than retention period
6. Overhead: ~5ms additional (one `appendFile` + one `readdir` for pruning)

**SessionEnd hook** (new):
1. Read JSON from stdin (contains `session_id`, `transcript_path`, `end_reason`)
2. Read manifest entry for this session ID
3. Parse transcript JSONL line-by-line
4. Extract structured events (see extraction schema below)
5. Batch-write all events to `sessions/{session_id}.events.jsonl`
6. Append session summary to manifest (marks session as extracted)
7. Overhead: ~200-500ms for typical session (500 transcript lines)

**Retry safety:** If SessionEnd hook fails (timeout, crash), extraction retries on next SessionStart. The hook scans manifest for sessions with entries but no corresponding `.events.jsonl` file and re-extracts.

### Extraction Schema

Each transcript line is transformed into a compact structured event:

```jsonl
{"t":"tool","ts":"2026-02-24T10:15:30.123Z","tool":"Write","cat":"native","in":{"file_path":"src/foo.ts"},"inB":240,"outB":120,"files":["src/foo.ts"],"dur":1500,"sid":"abc123","wid":"feat-xyz"}
{"t":"turn","ts":"2026-02-24T10:15:31.000Z","model":"claude-opus-4-6","tokIn":2,"tokOut":45,"tokCacheR":30815,"tokCacheW":13105,"dur":3200,"sid":"abc123","wid":"feat-xyz"}
{"t":"summary","ts":"2026-02-24T10:45:00.000Z","sid":"abc123","wid":"feat-xyz","tools":{"Write":12,"Read":45,"Bash":8,"Edit":15,"Grep":5,"mcp__exarchos":3},"tokTotal":{"in":150,"out":2400,"cacheR":185000,"cacheW":45000},"files":["src/foo.ts","src/bar.ts"],"dur":1800000,"turns":22}
```

**Event types:**
- `tool` — one per tool call (extracted from `assistant` → `user` pairs linked by `tool_use_id`)
- `turn` — one per model response (extracted from `assistant` entries with `usage`)
- `summary` — one per session (aggregated at extraction time)

**Field conventions:** Compact names to minimize storage. `t` = type, `ts` = timestamp, `inB`/`outB` = input/output bytes, `tokIn`/`tokOut` = token counts, `dur` = duration ms, `sid` = session ID, `wid` = workflow ID, `cat` = tool category (`native`, `mcp_exarchos`, `mcp_other`).

### Read Path

New `exarchos_view` action: `session_provenance`

**Query modes:**
- `session_provenance { sessionId }` — full event list for one session
- `session_provenance { workflowId }` — aggregated summary across all sessions for a workflow
- `session_provenance { workflowId, metric: "cost" }` — token totals by session
- `session_provenance { workflowId, metric: "attribution" }` — file→tool call mapping

**Implementation:** Lazy materialization. Reads session JSONL on-demand, never at startup. Caches materialized view in memory (LRU, bounded). Not backed by SQLite.

### Lifecycle

| Policy | Value | Rationale |
|--------|-------|-----------|
| Retention | 7 days | Session data loses value quickly; workflow summaries persist in main EventStore |
| Max total size | 50MB | ~350 typical sessions before rotation |
| Cleanup trigger | SessionStart hook | Prune files older than retention on each new session |
| Orphan handling | SessionStart retry | Re-extract sessions with manifest entries but no `.events.jsonl` |

### Session→Workflow Correlation

The manifest file (`sessions/.manifest.jsonl`) provides the mapping:

```jsonl
{"sessionId":"abc123","workflowId":"feat-xyz","transcriptPath":"~/.claude/projects/.../abc123.jsonl","startedAt":"2026-02-24T10:00:00Z","cwd":"/home/user/project","branch":"feat-xyz"}
{"sessionId":"abc123","extractedAt":"2026-02-24T10:45:05Z","endReason":"user_exit","toolCalls":88,"turns":22,"totalTokens":47550}
```

First line written by SessionStart, second appended by SessionEnd after extraction.

### Basileus Integration

**Phase 1 (this design): Local-only.** Session events stay in the separate tier. Zero impact on outbox, sync, or Basileus.

**Phase 2 (future): Session summary replication.** When Basileus HTTP client is wired (Phase 4 of distributed-sdlc-pipeline ADR), replicate **one summary event per session** (not raw tool calls):

```
Session ETL → session events → session_provenance view → summary → outbox → Basileus
```

A session summary is ~500B containing token totals, tool breakdown by category, file list, duration, and workflow correlation. This keeps Basileus sync at O(1) per session, enabling Thompson Sampling enrichment without overwhelming the sync pipeline.

---

## 6. Hook Configuration

### New hooks to register in `hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "type": "command",
        "command": "node \"$EXARCHOS_DIST/exarchos-cli.js\" session-end",
        "timeout": 30000
      }
    ]
  }
}
```

### Modified hooks:

**SessionStart** — add manifest entry write after existing workflow discovery logic. No new hook registration needed; the existing handler gains ~5ms of additional work.

### Hooks NOT registered (by design):

- **PostToolUse** — not needed. Transcript ETL replaces per-tool-call capture.
- **Stop** — SessionEnd covers the same data. Stop fires on explicit stop; SessionEnd fires on all exit paths.

---

## 7. Transcript Format Coupling

### Risk

The transcript JSONL format is a Claude Code internal detail. Changes could break the extraction function.

### Mitigation

1. **Single adaptation point.** One extraction function (`extractSessionEvents`) with versioned parsing logic. Format changes require updating one function.
2. **Graceful degradation.** If a transcript line doesn't match expected schema, skip it and log a warning. Partial extraction is better than no extraction.
3. **Format version detection.** The transcript carries a `version` field (Claude Code version). Use this to select the appropriate parser.
4. **Test fixtures.** Maintain sample transcript files as test fixtures. Run extraction tests against them in CI.
5. **Monitoring.** The session summary includes a `parsedLines`/`totalLines` ratio. If this drops below a threshold, it signals a format change.

---

## 8. Event Emission Architecture Audit

This audit covers every event emission path in the codebase, evaluating compliance with the event-first contract, idempotency guarantees, and architectural correctness.

### 8.1 EventStore.append Internals

**Source:** `servers/exarchos-mcp/src/event-store/store.ts`

**Order of operations:**
1. Acquire per-stream in-process lock
2. Rebuild idempotency cache from JSONL on first access
3. Idempotency check (return cached event if key seen)
4. Initialize sequence from `.seq` file or JSONL line count
5. Optimistic concurrency check (`expectedSequence`)
6. **Increment sequence counter in-memory**
7. Zod validation (`WorkflowEventBase.parse()`)
8. **Write to JSONL** (`writeEvents()`)
9. Cache idempotency key
10. Backend dual-write to SQLite (logged on failure, does not fail append)
11. Outbox enqueue (logged on failure, does not fail append)

**Finding F-STORE-1 (PARTIAL):** Sequence counter is incremented (step 6) before JSONL write (step 8). If `writeEvents()` fails, the in-memory counter diverges from the JSONL file. A restart would recover (counter re-initialized from JSONL), but within the same process, subsequent appends create a sequence gap.

**Finding F-STORE-2 (PARTIAL):** Idempotency cache is bounded at 200 keys per stream with FIFO eviction. After eviction, a retry with the same key produces a duplicate. The code acknowledges this: "Retries with evicted keys will NOT be deduplicated. Acceptable because retries occur within the same session."

### 8.2 Workflow Event Emission

#### handleInit — `workflow.started`

**Source:** `servers/exarchos-mcp/src/workflow/tools.ts:102-181`

| Step | Operation |
|------|-----------|
| 1 | Guard: check state file doesn't already exist |
| 2 | **Event append:** `workflow.started` to JSONL |
| 3 | On append failure: return error, state file NOT created |
| 4 | State file creation: `initStateFile()` |

- **Idempotency key:** `${featureId}:workflow.started` — deterministic, prevents duplicates.
- **Failure mode:** Event append fails → no state mutation. State write fails after event → orphan event, but deduplicated on retry.
- **Verdict: COMPLIANT**

#### handleSet — `workflow.transition`, `state.patched`

**Source:** `servers/exarchos-mcp/src/workflow/tools.ts:401-748`

| Step | Operation |
|------|-----------|
| 1 | Read state file (capture CAS version) |
| 2 | Apply field updates to mutable copy |
| 3 | Hydrate events for guard evaluation |
| 4 | Execute HSM transition (dry-run) |
| 5 | On guard failure: emit diagnostic events, return error |
| 6 | Collect `pendingTransitionEvents` |
| 7 | **Event-first:** Append transition events BEFORE CAS write |
| 8 | On append failure: return error, no state mutation |
| 9 | **Event-first:** Append `state.patched` BEFORE CAS write |
| 10 | On append failure: return error, no state mutation |
| 11 | CAS write to state file |
| 12 | On CAS conflict: retry (events deduplicated by idempotency keys) |

- **Idempotency keys:** `${featureId}:${type}:${from}:${to}:${expectedVersion}` (version-scoped, safe across CAS retries).
- **Verdict: COMPLIANT** — fully event-first with proper idempotency.

#### handleCheckpoint — `workflow.checkpoint`

**Source:** `servers/exarchos-mcp/src/workflow/tools.ts:752-825`

| Step | Operation |
|------|-----------|
| 1 | Read state file |
| 2 | **Event append:** `workflow.checkpoint` |
| 3 | On append failure: return error, no state mutation |
| 4 | Write state file |

- **Finding F-CHECKPOINT-1 (PARTIAL):** No idempotency key. If the event appends but the state write fails, a retry creates a duplicate checkpoint event.
- **Fix:** Add idempotency key `${featureId}:checkpoint:${phase}:${counter}`.

#### handleCancel — `workflow.compensation`, `workflow.cancel`

**Source:** `servers/exarchos-mcp/src/workflow/cancel.ts:35-224`

| Step | Operation |
|------|-----------|
| 1 | Read state, guard against already-cancelled |
| 2 | Execute compensation actions |
| 3 | Bridge compensation events to store (best-effort, `catch {}`) |
| 4 | Execute HSM transition to `cancelled` |
| 5 | Append transition events (`catch {}` — **failures swallowed**) |
| 6 | Append `workflow.cancel` event (`catch {}` — **failures swallowed**) |
| 7 | Mutate state to `cancelled` |
| 8 | Write state file |

- **Finding F-CANCEL-1 (VIOLATION):** Code claims "Event-first: emit to external event store BEFORE mutating state" but `catch {}` blocks swallow all event emission failures. State transitions to `cancelled` even when zero events are recorded. This violates the event-first contract.
- **Finding F-CANCEL-2 (VIOLATION):** No idempotency keys on any cancel events. Retries produce duplicates.
- **Fix:** For v2 event-sourced path, propagate event emission failure and return error (matching `handleCleanup` v2 pattern). Add idempotency keys: `${featureId}:cancel:compensation:${action}`, `${featureId}:cancel:transition:${from}:cancelled`, `${featureId}:cancel:complete`.

#### handleCleanup — `state.patched`, `workflow.cleanup`

**Source:** `servers/exarchos-mcp/src/workflow/cleanup.ts:185-403`

**v2 path:**
| Step | Operation |
|------|-----------|
| 1 | Read state, validate guards |
| 2 | Build mutations (synthesis backfill, review resolution) |
| 3 | Execute HSM transition |
| 4 | Apply mutations in memory |
| 5 | **Event-first (v2):** `emitCleanupEvents()` BEFORE writing state |
| 6 | On append failure: return error, no state write |
| 7 | Write state file |

- **Idempotency keys (v2):** `${featureId}:cleanup:patch:${currentPhase}`, `${featureId}:cleanup:transition:${from}:${to}:${currentPhase}`, `${featureId}:cleanup:complete`.
- **v1 path:** State-first, best-effort events after. By design for legacy compatibility.
- **Verdict: COMPLIANT (v2) / PARTIAL (v1, by design)**

### 8.3 Task Event Emission

**Source:** `servers/exarchos-mcp/src/tasks/tools.ts`

#### handleTaskClaim — `task.claimed`

- **Pattern:** Event-only (no separate state mutation). Optimistic concurrency via `expectedSequence`.
- **Agent validation:** `validateAgentEvent()` enforces `agentId` and `source`.
- **No idempotency key** — relies on `expectedSequence` for conflict detection.
- **Verdict: COMPLIANT** — pure event-sourced with optimistic concurrency.

#### handleTaskComplete — `task.completed`

- **Pattern:** Direct `store.append('task.completed')`.
- **Finding F-TASK-1 (PARTIAL):** No `expectedSequence`, no idempotency key. Duplicate completions possible.
- **No agent metadata validation** — `task.completed` is not in `AGENT_EVENT_TYPES`.
- **Fix:** Add idempotency key `${streamId}:task.completed:${taskId}`.

#### handleTaskFail — `task.failed`

- **Same pattern as taskComplete.**
- **Finding F-TASK-2 (PARTIAL):** No `expectedSequence`, no idempotency key.
- **Fix:** Add idempotency key `${streamId}:task.failed:${taskId}`.

### 8.4 Team Event Emission (Hook-Driven)

**Source:** `servers/exarchos-mcp/src/cli-commands/gates.ts:405-486`

The `handleTeammateGate` emits `team.task.completed` and `team.task.failed` events via `appendTeamEvent()`:

```typescript
async function appendTeamEvent(stateDir, streamId, event) {
  const eventFile = path.join(stateDir, `${streamId}.events.jsonl`);
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(eventFile, line, 'utf-8');
}
```

**Finding F-GATE-1 (VIOLATION):** This function bypasses the EventStore entirely:
1. **No Zod validation** — event not validated against `WorkflowEventBase`
2. **Sequence = `Date.now()`** — a 13-digit timestamp, not a monotonic integer. Breaks the sequence invariant (`firstEvent.sequence === 1`, `lastEvent.sequence === lines.length`)
3. **No idempotency** — no deduplication of any kind
4. **No locking** — raw `fs.appendFile` could interleave with EventStore writes
5. **No backend dual-write** — SQLite doesn't see these events
6. **No outbox** — events never replicated via outbox
7. **Sequence corruption** — `EventStore.initializeSequence` will throw `Sequence invariant violated` on next read

**Fix:** Create an EventStore instance in the gate handler (or use a lightweight append protocol that respects sequence invariants). Since hooks run in separate processes, they cannot share the MCP server's EventStore instance. Options:
- (a) Create a standalone `EventStore` in the hook process, acquire PID lock, append properly.
- (b) Write events to a sidecar file (`{streamId}.hook-events.jsonl`) and merge them on next MCP server startup during hydration.
- (c) Have the hook communicate the event payload to the MCP server via a marker file, and let the MCP server emit the event on next tool call.

Option (b) is recommended: it avoids PID lock contention and leverages the existing hydration path.

### 8.5 Telemetry Event Emission

**Source:** `servers/exarchos-mcp/src/telemetry/middleware.ts`

- Events: `tool.invoked`, `tool.completed`, `tool.errored`, `quality.hint.generated`
- All go through `EventStore.append()` on the `telemetry` stream
- All failures swallowed (`.catch(() => {})`) — by design, telemetry never breaks handlers
- `tool.invoked` is fire-and-forget (not awaited); `tool.completed`/`tool.errored` await the invoked promise first for ordering
- No idempotency keys (acceptable for auxiliary telemetry)
- **Verdict: COMPLIANT** — correctly auxiliary, failures properly swallowed.

### 8.6 Review/Quality Event Emission

**Source:** `servers/exarchos-mcp/src/review/tools.ts`, `review/findings.ts`, `quality/regression-detector.ts`

| Event | Path | Idempotency | Verdict |
|-------|------|-------------|---------|
| `review.routed` | `handleReviewTriage` | `${featureId}:review.routed:${pr}` | **PARTIAL** (F-REVIEW-1) |
| `review.finding` | `emitReviewFindings` | None | **PARTIAL** |
| `review.escalated` | `emitReviewEscalated` | None | **PARTIAL** |
| `quality.regression` | `emitRegressionEvents` | None (caller-side dedup) | **PARTIAL** |

**Finding F-REVIEW-1 (PARTIAL):** `handleReviewTriage` creates a **new `EventStore` instance** per call (`new EventStore(stateDir)`) without initialization, bypassing the singleton, PID lock, and shared idempotency cache.

**Fix:** Use a shared EventStore factory or accept the EventStore as a dependency.

### 8.7 Event Schema Gaps

**Source:** `servers/exarchos-mcp/src/event-store/schemas.ts`

**Finding F-SCHEMA-1 (GAP):** `WorkflowEventBase` makes `correlationId`, `causationId`, `agentId`, `source` all **optional**. The ADR implies these should be required for traceability. Only 4 event types (`task.claimed`, `task.progressed`, `team.task.completed`, `team.task.failed`) enforce `agentId`+`source` via `validateAgentEvent()`.

**Finding F-SCHEMA-2 (GAP):** Event `data` field uses `z.record(z.string(), z.unknown())` — a generic map. Per-type data schemas exist but are not validated at append time. An event with `type: "task.completed"` and `data: { garbage: true }` passes validation.

**Fix (incremental):**
1. Make `source` required on `WorkflowEventBase` (identifies emission origin: `"workflow"`, `"hook"`, `"telemetry"`, `"agent"`).
2. Add optional per-type data validation in `EventStore.append()` with a discriminated union, enabled by a `strictValidation` flag (default off for backward compatibility, on for new code paths).

### 8.8 Audit Summary

| ID | Severity | Component | Issue | Fix |
|----|----------|-----------|-------|-----|
| **F-GATE-1** | **P0 VIOLATION** | `gates.ts:appendTeamEvent` | Bypasses EventStore, corrupts sequence invariant | Sidecar file + hydration merge |
| **F-CANCEL-1** | **P0 VIOLATION** | `cancel.ts:125,179` | Swallows event failures, allows state mutation without events | Propagate failures in v2 path |
| **F-CANCEL-2** | **P0 VIOLATION** | `cancel.ts:120,157,169` | No idempotency keys on cancel events | Add version-scoped keys |
| F-CHECKPOINT-1 | P1 PARTIAL | `tools.ts:787` | No idempotency key on checkpoint | Add `${featureId}:checkpoint:${phase}:${counter}` |
| F-TASK-1 | P1 PARTIAL | `tasks/tools.ts:200` | No idempotency on task.completed | Add `${streamId}:task.completed:${taskId}` |
| F-TASK-2 | P1 PARTIAL | `tasks/tools.ts:261` | No idempotency on task.failed | Add `${streamId}:task.failed:${taskId}` |
| F-REVIEW-1 | P2 PARTIAL | `review/tools.ts:112` | Standalone EventStore instance | Use shared factory |
| F-SCHEMA-1 | P3 GAP | `schemas.ts` | Optional metadata on all events | Make `source` required |
| F-SCHEMA-2 | P3 GAP | `schemas.ts` | No per-type data validation | Discriminated union with opt-in flag |
| F-STORE-1 | P4 MINOR | `store.ts:262-263` | Sequence pre-increment before write | Move increment after write |
| F-STORE-2 | P4 MINOR | `store.ts:240-244` | Idempotency eviction allows duplicates | Acceptable (documented trade-off) |

---

## 9. Implementation Scope

### Phase A: Event Emission Hardening (prerequisite)

Fix the P0 violations before building session provenance. Session data correlated to an unreliable event foundation produces unreliable intelligence.

1. **F-GATE-1:** Sidecar event file pattern for hook-driven events
2. **F-CANCEL-1/F-CANCEL-2:** Event-first enforcement + idempotency keys in cancel path
3. **F-CHECKPOINT-1, F-TASK-1, F-TASK-2:** Add missing idempotency keys

### Phase B: Session Provenance Core

1. **Manifest writer** — enhance SessionStart hook to write manifest entries
2. **Transcript extraction function** — parse transcript JSONL into structured events
3. **SessionEnd hook** — register hook, wire extraction, batch-write session events
4. **Retry mechanism** — SessionStart detects unextracted sessions, re-extracts
5. **Lifecycle manager** — prune session files on SessionStart (7-day retention, 50MB cap)

### Phase C: Query Layer

1. **`session_provenance` view** — lazy materialization from session JSONL files
2. **Query modes** — by session, by workflow, by metric (cost, attribution)
3. **View integration** — register in `exarchos_view` action router

### Phase D: Basileus Preparation (future)

1. **Session summary event type** — define `session.summary` in event schema
2. **Summary projection** — materialize from session events on SessionEnd
3. **Outbox integration** — route summary events through outbox for Basileus replication

---

## 10. Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| SessionStart overhead | +~5ms | One `appendFile` to manifest + `readdir` for pruning |
| SessionEnd overhead | ~200-500ms | Transcript parse + batch write (500 typical lines) |
| SessionEnd worst case | ~1-2s | Monster session (2000 lines) |
| Per-tool-call overhead | **Zero** | No PostToolUse hook |
| Cold start impact | **Zero** | Session tier never hydrated into main SQLite |
| Local storage per session | ~40KB-1MB | Compact field names, no raw transcript duplication |
| Basileus sync volume | **Zero** (Phase 1) | O(1) summary event per session (Phase D) |

---

## 11. References

- [Storage Layer Audit](./2026-02-21-storage-layer-audit.md) — hybrid JSONL+SQLite design, performance findings
- [optimize.md](../prompts/optimize.md) — architectural audit principles (token economy, operational performance, determinism)
- [Distributed SDLC Pipeline](../adrs/distributed-sdlc-pipeline.md) — event sourcing, CQRS views, telemetry middleware, Basileus integration phases
- [MLflow Claude Code Tracing](https://learn.microsoft.com/azure/databricks/mlflow3/genai/tracing/integrations/claude-code) — external validation of hook-based session capture
- Entire.io Checkpoints CLI — competitive reference (git shadow branches, session capture)
