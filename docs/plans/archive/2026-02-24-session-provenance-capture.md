# Implementation Plan: Session Provenance Capture & Event Emission Hardening

## Source Design
Link: `docs/designs/2026-02-24-session-provenance-capture.md`

## Scope
**Target:** Full design — Phases A (event emission hardening), B (session provenance core), C (query layer)
**Excluded:**
- Phase D (Basileus preparation) — deferred until Basileus HTTP client is wired (Phase 4 of distributed-sdlc-pipeline ADR)
- F-STORE-1 (sequence pre-increment) — P4 minor, deferred
- F-STORE-2 (idempotency eviction) — P4 minor, documented trade-off
- F-REVIEW-1 (standalone EventStore in review) — P2, separate refactor
- F-SCHEMA-1, F-SCHEMA-2 (schema gaps) — P3, separate hardening pass

## Summary
- Total tasks: 14
- Parallel groups: 4 layers
- Estimated test count: ~42
- Design coverage: 13 of 15 sections covered (2 deferred with rationale)

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| 5.1 Three-category event model | Formalize domain/infrastructure/session event categories | 001-004 (hardening establishes categories) | Covered |
| 5.2 Write path — SessionStart manifest | Manifest entry on session start (sessionId, workflowId, transcriptPath) | 005 | Covered |
| 5.3 Write path — SessionEnd extraction | Parse transcript, extract structured events, batch-write | 006, 007, 008, 009 | Covered |
| 5.4 Extraction schema | Compact event types: tool, turn, summary | 006, 007 | Covered |
| 5.5 Read path — session_provenance view | Lazy materialization, aggregate queries | 013, 014 | Covered |
| 5.6 Lifecycle | 7-day retention, 50MB cap, prune on SessionStart | 012 | Covered |
| 5.7 Session→workflow correlation | Manifest file with session→workflow mapping | 005 | Covered |
| 5.8 Basileus integration | Local-only Phase 1; summary replication Phase 2 | — | Deferred: Phase D, pending Basileus HTTP client |
| 6 Hook configuration | SessionEnd hook registration in hooks.json | 010 | Covered |
| 7 Transcript format coupling | Versioned parser, graceful degradation, test fixtures | 006, 007 | Covered |
| 8.4 F-GATE-1 | Sidecar event file for hook-driven events | 001, 002, 003 | Covered |
| 8.2 F-CANCEL-1/F-CANCEL-2 | Event-first enforcement + idempotency in cancel | 004 | Covered |
| 8.2/8.3 F-CHECKPOINT-1, F-TASK-1, F-TASK-2 | Missing idempotency keys | 004 | Covered |
| 8.7 F-SCHEMA-1, F-SCHEMA-2 | Optional metadata, no per-type validation | — | Deferred: P3, separate hardening pass |
| 10 Performance characteristics | Zero per-tool overhead, ~200-500ms SessionEnd, zero cold start | 009 (integration test validates) | Covered |

---

## Task Breakdown

### Phase A: Event Emission Hardening

---

### Task 001: Hook event sidecar writer

**Phase:** RED → GREEN → REFACTOR

**Context:** F-GATE-1 requires a way for hook subprocesses (which can't share the MCP server's EventStore) to emit events safely. A sidecar file pattern decouples hook-time writes from EventStore sequences.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `writeHookEvent_ValidEvent_AppendsToSidecarFile`
   - `writeHookEvent_NonExistentDir_CreatesFileAndAppends`
   - `writeHookEvent_MultipleEvents_AppendsInOrder`
   - `writeHookEvent_IncludesIdempotencyKey_KeyPresentInOutput`
   - File: `servers/exarchos-mcp/src/event-store/hook-event-writer.test.ts`
   - Expected failure: `writeHookEvent` function does not exist

2. [GREEN] Implement `writeHookEvent` function
   - File: `servers/exarchos-mcp/src/event-store/hook-event-writer.ts`
   - Exports: `writeHookEvent(stateDir: string, streamId: string, event: HookEvent): Promise<void>`
   - `HookEvent` type: `{ type: string, data: Record<string, unknown>, timestamp?: string, idempotencyKey?: string }`
   - Writes to `{stateDir}/{streamId}.hook-events.jsonl` (sidecar naming convention)
   - Simple `appendFile` — no sequences, no validation, no locks

3. [REFACTOR] Extract `HookEvent` type to shared types if reused

**Verification:**
- [ ] Tests fail for the right reason (missing function)
- [ ] Tests pass after implementation
- [ ] Sidecar file uses `.hook-events.jsonl` suffix to distinguish from main `.events.jsonl`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Sidecar event merger in hydration path

**Phase:** RED → GREEN → REFACTOR

**Context:** Sidecar events written by hooks must be merged into the main EventStore on next startup. The hydration path already scans JSONL files — extend it to discover and merge sidecar files.

**Testing Strategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["idempotence: merge(merge(sidecar)) === merge(sidecar) — reprocessing produces no duplicates", "completeness: all sidecar events appear in main stream after merge"] }`

**TDD Steps:**
1. [RED] Write tests:
   - `mergeSidecarEvents_SingleEvent_AppendsToMainStream`
   - `mergeSidecarEvents_WithIdempotencyKey_DeduplicatesOnRetry`
   - `mergeSidecarEvents_DeletesSidecarAfterMerge`
   - `mergeSidecarEvents_EmptySidecar_NoopAndDelete`
   - `mergeSidecarEvents_CorruptLine_SkipsAndContinues`
   - Property: `mergeSidecarEvents_Idempotent_RemergeProducesNoDuplicates`
   - File: `servers/exarchos-mcp/src/storage/sidecar-merger.test.ts`
   - Expected failure: `mergeSidecarEvents` function does not exist

2. [GREEN] Implement `mergeSidecarEvents`
   - File: `servers/exarchos-mcp/src/storage/sidecar-merger.ts`
   - Exports: `mergeSidecarEvents(stateDir: string, eventStore: EventStore): Promise<MergeResult>`
   - Scans `{stateDir}/*.hook-events.jsonl`
   - For each file: read lines, parse JSON, append to EventStore with idempotency key
   - Delete sidecar file after successful merge
   - Returns `{ merged: number, skipped: number, errors: number }`

3. [REFACTOR] Clean up error handling patterns

**Verification:**
- [ ] Tests fail for the right reason
- [ ] Idempotency property holds (re-merge with same keys produces no duplicates)
- [ ] Sidecar files deleted after merge

**Dependencies:** Task 001
**Parallelizable:** No (sequential with 001)

---

### Task 003: Migrate gates.ts to sidecar writer

**Phase:** RED → GREEN → REFACTOR

**Context:** Replace the raw `appendTeamEvent` in gates.ts (which bypasses EventStore, uses `Date.now()` as sequence, and corrupts the stream) with the sidecar writer from Task 001.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write/update tests:
   - `emitTeamTaskEvent_OnSuccess_WritesSidecarWithIdempotencyKey`
   - `emitTeamTaskEvent_OnFailure_WritesSidecarWithFailureReason`
   - `emitTeamTaskEvent_IdempotencyKey_IncludesTaskIdAndStreamId`
   - File: `servers/exarchos-mcp/src/cli-commands/gates.test.ts`
   - Expected failure: existing `appendTeamEvent` doesn't use sidecar writer or idempotency keys

2. [GREEN] Replace `appendTeamEvent` with `writeHookEvent`
   - File: `servers/exarchos-mcp/src/cli-commands/gates.ts`
   - Remove raw `fs.appendFile` with `Date.now()` sequence
   - Call `writeHookEvent(stateDir, streamId, { type: 'team.task.completed', data: {...}, idempotencyKey: '${streamId}:team.task.completed:${taskId}' })`
   - Same for `team.task.failed`

3. [REFACTOR] Remove dead `appendTeamEvent` function

**Verification:**
- [ ] Old `appendTeamEvent` function removed
- [ ] Events now written to `*.hook-events.jsonl` sidecar files
- [ ] Idempotency keys follow pattern `${streamId}:team.task.${status}:${taskId}`
- [ ] No raw `fs.appendFile` to main `.events.jsonl` remains

**Dependencies:** Task 001
**Parallelizable:** No (sequential with 001, parallel with 002)

---

### Task 004: Fix cancel event-first violation + missing idempotency keys

**Phase:** RED → GREEN → REFACTOR

**Context:** F-CANCEL-1 (swallowed event failures), F-CANCEL-2 (no idempotency keys), F-CHECKPOINT-1 (no checkpoint idempotency key), F-TASK-1/F-TASK-2 (no task complete/fail idempotency keys).

**Testing Strategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["idempotence: retry with same idempotency key produces no duplicate events"] }`

**TDD Steps:**
1. [RED] Write tests:
   - `handleCancel_EventAppendFails_ReturnsErrorNotMutatesState` (cancel.ts)
   - `handleCancel_CompensationEvents_HaveIdempotencyKeys` (cancel.ts)
   - `handleCancel_TransitionEvents_HaveIdempotencyKeys` (cancel.ts)
   - `handleCancel_CancelEvent_HasIdempotencyKey` (cancel.ts)
   - `handleCheckpoint_EventAppend_HasIdempotencyKey` (workflow/tools.ts)
   - `handleTaskComplete_EventAppend_HasIdempotencyKey` (tasks/tools.ts)
   - `handleTaskFail_EventAppend_HasIdempotencyKey` (tasks/tools.ts)
   - Property: `handleCancel_RetryAfterFailure_NoDuplicateEvents`
   - Files:
     - `servers/exarchos-mcp/src/__tests__/workflow/cancel.test.ts`
     - `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts`
     - `servers/exarchos-mcp/src/tasks/tools.test.ts`
   - Expected failure: no idempotency keys on any of these paths; cancel swallows errors

2. [GREEN] Fix event emission:
   - `servers/exarchos-mcp/src/workflow/cancel.ts`:
     - Remove `catch {}` blocks on event emission (v2 path)
     - Propagate failures: if event append fails, return error, don't mutate state
     - Add idempotency keys: `${featureId}:cancel:compensation:${action}:${i}`, `${featureId}:cancel:transition:${from}:cancelled`, `${featureId}:cancel:complete`
   - `servers/exarchos-mcp/src/workflow/tools.ts`:
     - Add idempotency key to `handleCheckpoint`: `${featureId}:checkpoint:${phase}:${state._version}`
   - `servers/exarchos-mcp/src/tasks/tools.ts`:
     - Add idempotency key to `handleTaskComplete`: `${streamId}:task.completed:${taskId}`
     - Add idempotency key to `handleTaskFail`: `${streamId}:task.failed:${taskId}`

3. [REFACTOR] Align cancel error handling with cleanup v2 pattern

**Verification:**
- [ ] Cancel returns error when event emission fails (not silent swallow)
- [ ] All 7 event emission paths now have idempotency keys
- [ ] Retry produces no duplicates (property test)

**Dependencies:** None
**Parallelizable:** Yes (parallel with Tasks 001-003)

---

### Phase B: Session Provenance Core

---

### Task 005: Session types and manifest writer

**Phase:** RED → GREEN → REFACTOR

**Context:** The manifest file (`sessions/.manifest.jsonl`) maps sessions to workflows and tracks extraction status. SessionStart writes the initial entry; SessionEnd appends the extraction result.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `writeManifestEntry_ValidEntry_AppendsToManifestFile`
   - `writeManifestEntry_CreatesSessionsDir_IfNotExists`
   - `readManifestEntries_ReturnsAllEntries`
   - `readManifestEntries_EmptyFile_ReturnsEmptyArray`
   - `findUnextractedSessions_ReturnsSessionsWithoutEventsFile`
   - File: `servers/exarchos-mcp/src/session/manifest.test.ts`
   - Expected failure: module does not exist

2. [GREEN] Implement manifest module
   - File: `servers/exarchos-mcp/src/session/types.ts`
     - `SessionManifestEntry`: `{ sessionId, workflowId?, transcriptPath, startedAt, cwd, branch }`
     - `SessionManifestCompletion`: `{ sessionId, extractedAt, endReason, toolCalls, turns, totalTokens }`
     - `SessionToolEvent`: `{ t: 'tool', ts, tool, cat, in?, inB, outB, files?, dur?, sid, wid? }`
     - `SessionTurnEvent`: `{ t: 'turn', ts, model, tokIn, tokOut, tokCacheR, tokCacheW, dur, sid, wid? }`
     - `SessionSummaryEvent`: `{ t: 'summary', ts, sid, wid?, tools, tokTotal, files, dur, turns }`
     - `SessionEvent = SessionToolEvent | SessionTurnEvent | SessionSummaryEvent`
   - File: `servers/exarchos-mcp/src/session/manifest.ts`
     - `writeManifestEntry(stateDir, entry): Promise<void>` — append to `sessions/.manifest.jsonl`
     - `readManifestEntries(stateDir): Promise<SessionManifestEntry[]>`
     - `findUnextractedSessions(stateDir): Promise<SessionManifestEntry[]>` — entries without `.events.jsonl`

3. [REFACTOR] Clean up type exports

**Verification:**
- [ ] Types exported from `session/types.ts`
- [ ] Manifest I/O works with JSONL format
- [ ] `findUnextractedSessions` correctly identifies sessions needing extraction

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 006: Transcript parser — tool call extraction

**Phase:** RED → GREEN → REFACTOR

**Context:** Parse Claude Code transcript JSONL to extract structured tool call events. Each tool call spans two transcript lines: an `assistant` entry with `tool_use` content block and a `user` entry with matching `tool_use_id`.

**Testing Strategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["completeness: every tool_use block in input produces exactly one SessionToolEvent in output", "roundtrip: tool_use_id links are correctly resolved for all pairs"] }`

**TDD Steps:**
1. [RED] Write tests:
   - `extractToolCalls_SingleToolUse_ReturnsOneToolEvent`
   - `extractToolCalls_MultipleToolUses_ReturnsAllToolEvents`
   - `extractToolCalls_ToolUseWithFileInput_ExtractsFilePaths`
   - `extractToolCalls_MissingToolResult_SkipsGracefully`
   - `extractToolCalls_UnrecognizedLineType_SkipsGracefully`
   - `extractToolCalls_CategorizesMcpVsNativeTools`
   - Property: `extractToolCalls_AllToolUseBlocksProduceEvents`
   - File: `servers/exarchos-mcp/src/session/transcript-parser.test.ts`
   - Expected failure: module does not exist
   - **Test fixture:** Create `servers/exarchos-mcp/src/session/__fixtures__/sample-transcript.jsonl` with representative transcript data

2. [GREEN] Implement tool call extraction
   - File: `servers/exarchos-mcp/src/session/transcript-parser.ts`
   - `extractToolCalls(lines: TranscriptLine[]): SessionToolEvent[]`
   - Parse `assistant` entries for `content[].type === 'tool_use'`
   - Match with `user` entries by `tool_use_id`
   - Categorize tools: `native` (Read/Write/Edit/Bash/Grep/Glob), `mcp_exarchos`, `mcp_other`
   - Extract file paths from `tool_input.file_path` or `tool_input.path`

3. [REFACTOR] Extract tool categorization to a separate helper

**Verification:**
- [ ] Tool calls correctly extracted from assistant→user pairs
- [ ] Categories assigned correctly
- [ ] Graceful degradation on malformed lines

**Dependencies:** Task 005 (for types)
**Parallelizable:** No (sequential with 005)

---

### Task 007: Transcript parser — token/timing extraction + summary

**Phase:** RED → GREEN → REFACTOR

**Context:** Extract token usage from `assistant` entries (`message.usage`) and turn duration from `system` entries. Aggregate into a session summary event.

**Testing Strategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["conservation: sum of per-turn tokens equals summary total tokens", "completeness: every assistant entry contributes to token totals"] }`

**TDD Steps:**
1. [RED] Write tests:
   - `extractTurns_AssistantEntry_ReturnsTokenBreakdown`
   - `extractTurns_WithCacheTokens_IncludesCacheReadAndWrite`
   - `extractTurns_SystemEntry_ExtractsTurnDuration`
   - `buildSessionSummary_AggregatesToolCallsTokensFiles`
   - `buildSessionSummary_CalculatesTotalDuration`
   - Property: `buildSessionSummary_TokenTotalsEqualSumOfTurns`
   - File: `servers/exarchos-mcp/src/session/transcript-parser.test.ts` (append to existing)
   - Expected failure: functions do not exist

2. [GREEN] Implement extraction and summary
   - File: `servers/exarchos-mcp/src/session/transcript-parser.ts` (extend)
   - `extractTurns(lines: TranscriptLine[]): SessionTurnEvent[]`
   - `buildSessionSummary(toolEvents: SessionToolEvent[], turnEvents: SessionTurnEvent[], metadata: SessionMetadata): SessionSummaryEvent`
   - `parseTranscript(transcriptPath: string, metadata: SessionMetadata): Promise<SessionEvent[]>` — top-level function combining all extraction

3. [REFACTOR] Ensure `parseTranscript` is the single public entry point

**Verification:**
- [ ] Token totals aggregate correctly (conservation property)
- [ ] Duration calculated from first to last entry timestamp
- [ ] Summary includes tool breakdown by category

**Dependencies:** Task 006
**Parallelizable:** No (sequential with 006)

---

### Task 008: SessionStart manifest integration

**Phase:** RED → GREEN → REFACTOR

**Context:** Enhance the existing SessionStart hook handler to write a manifest entry on each new session. The handler receives `session_id`, `transcript_path`, and `cwd` from stdin.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `handleSessionStart_WritesManifestEntry_WithSessionMetadata`
   - `handleSessionStart_ResolvesWorkflowId_FromActiveWorkflows`
   - `handleSessionStart_NoActiveWorkflow_ManifestEntryHasNullWorkflowId`
   - `handleSessionStart_ManifestWriteFailure_DoesNotBreakExistingBehavior`
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.test.ts` (extend existing)
   - Expected failure: no manifest writing logic exists

2. [GREEN] Enhance `handleSessionStart`
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - After existing workflow discovery, call `writeManifestEntry` with session metadata from stdin
   - Extract `session_id`, `transcript_path` from `stdinData` parameter (currently `_stdinData`)
   - Resolve `workflowId` from discovered workflows (first active workflow or null)
   - Wrap in try/catch — manifest failure must not break existing session-start behavior

3. [REFACTOR] Remove underscore prefix from `_stdinData` parameter

**Verification:**
- [ ] Manifest entry written with correct fields
- [ ] Existing session-start behavior unchanged on manifest failure
- [ ] `stdinData` now used (not ignored)

**Dependencies:** Task 005 (manifest writer)
**Parallelizable:** No (sequential with 005)

---

### Task 009: SessionEnd CLI command and hook registration

**Phase:** RED → GREEN → REFACTOR

**Context:** Register the `session-end` command in the CLI router and add the SessionEnd hook to hooks.json.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `routeCommand_SessionEnd_CallsSessionEndHandler`
   - `handleSessionEnd_ValidStdin_ReturnsSuccess`
   - `handleSessionEnd_MissingSessionId_ReturnsError`
   - `handleSessionEnd_MissingTranscriptPath_ReturnsError`
   - File: `servers/exarchos-mcp/src/cli-commands/session-end.test.ts`
   - Expected failure: command and handler do not exist

2. [GREEN] Implement command registration
   - File: `servers/exarchos-mcp/src/cli.ts`
     - Add `'session-end'` to `KNOWN_COMMANDS`
     - Add handler entry in `commandHandlers`
   - File: `servers/exarchos-mcp/src/cli-commands/session-end.ts`
     - `handleSessionEnd(stdinData: Record<string, unknown>, stateDir: string): Promise<CommandResult>`
     - Validate required fields: `session_id`, `transcript_path`
     - Stub: return success (extraction wired in Task 010)
   - File: `hooks/hooks.json`
     - Add `SessionEnd` hook entry with 30s timeout

3. [REFACTOR] Align error response format with other CLI commands

**Verification:**
- [ ] `session-end` command routed correctly
- [ ] Input validation for required fields
- [ ] Hook registered in hooks.json

**Dependencies:** None
**Parallelizable:** Yes (parallel with Tasks 005-008)

---

### Task 010: SessionEnd extraction and batch write

**Phase:** RED → GREEN → REFACTOR

**Context:** Wire the transcript parser into the SessionEnd handler. Parse the transcript, extract structured events, batch-write to session JSONL, update manifest with completion metadata.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true, performanceSLAs: [{ operation: "session-extraction-500-lines", metric: "p99_ms", threshold: 1000 }] }`

**TDD Steps:**
1. [RED] Write tests:
   - `handleSessionEnd_ValidTranscript_WritesSessionEventsFile`
   - `handleSessionEnd_ValidTranscript_UpdatesManifestWithCompletion`
   - `handleSessionEnd_ValidTranscript_SessionEventsContainToolAndTurnAndSummary`
   - `handleSessionEnd_TranscriptNotFound_ReturnsErrorGracefully`
   - `handleSessionEnd_AlreadyExtracted_SkipsReextraction`
   - Benchmark: `handleSessionEnd_500LineTranscript_CompletesUnder1Second`
   - File: `servers/exarchos-mcp/src/cli-commands/session-end.test.ts` (extend)
   - Expected failure: stub handler from Task 009 doesn't perform extraction

2. [GREEN] Wire extraction into `handleSessionEnd`
   - File: `servers/exarchos-mcp/src/cli-commands/session-end.ts`
   - Read manifest entry for this session
   - Call `parseTranscript(transcriptPath, metadata)`
   - Batch-write events to `sessions/{sessionId}.events.jsonl`
   - Append completion entry to manifest
   - Guard: skip if `.events.jsonl` already exists (idempotent)

3. [REFACTOR] Extract batch-write helper if needed

**Verification:**
- [ ] End-to-end: transcript → structured events → session JSONL
- [ ] Manifest updated with extraction metadata
- [ ] Idempotent (re-running doesn't duplicate)
- [ ] 500-line transcript completes under 1 second

**Dependencies:** Tasks 007 (parser), 009 (CLI command)
**Parallelizable:** No (sequential after 007 and 009)

---

### Task 011: Session retry mechanism

**Phase:** RED → GREEN → REFACTOR

**Context:** If SessionEnd hook fails (timeout, crash), extraction retries on next SessionStart. The hook scans manifest for sessions with entries but no `.events.jsonl`.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `handleSessionStart_UnextractedSession_RetriesExtraction`
   - `handleSessionStart_TranscriptGone_MarksSessionAsOrphan`
   - `handleSessionStart_MultipleUnextracted_ProcessesAll`
   - `handleSessionStart_RetryFailure_DoesNotBreakStartup`
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.test.ts` (extend)
   - Expected failure: no retry logic exists

2. [GREEN] Add retry logic to `handleSessionStart`
   - File: `servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - After existing logic, call `findUnextractedSessions(stateDir)`
   - For each unextracted session: attempt extraction via `parseTranscript` + batch-write
   - If transcript file doesn't exist: mark session as orphan in manifest (append `{ sessionId, orphanedAt, reason: 'transcript_not_found' }`)
   - Wrap in try/catch — retry failure must not break session startup

3. [REFACTOR] Extract retry loop to a helper function

**Verification:**
- [ ] Unextracted sessions detected and retried
- [ ] Missing transcripts handled gracefully (orphan marking)
- [ ] Startup not blocked by retry failures

**Dependencies:** Tasks 008 (manifest integration), 010 (extraction wiring)
**Parallelizable:** No (sequential after 008, 010)

---

### Task 012: Session lifecycle manager

**Phase:** RED → GREEN → REFACTOR

**Context:** Prune stale session files older than retention period (7 days). Enforce 50MB total cap. Triggered on SessionStart.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `pruneSessionFiles_OlderThanRetention_Deletes`
   - `pruneSessionFiles_WithinRetention_Keeps`
   - `pruneSessionFiles_ExceedsSizeCap_DeletesOldestFirst`
   - `pruneSessionFiles_EmptyDir_Noop`
   - `pruneSessionFiles_ManifestFile_NeverDeleted`
   - File: `servers/exarchos-mcp/src/session/lifecycle.test.ts`
   - Expected failure: module does not exist

2. [GREEN] Implement lifecycle manager
   - File: `servers/exarchos-mcp/src/session/lifecycle.ts`
   - `pruneSessionFiles(stateDir: string, options?: { retentionDays?: number, maxSizeMB?: number }): Promise<PruneResult>`
   - Default: 7-day retention, 50MB cap
   - Scans `sessions/*.events.jsonl` — sort by mtime, delete oldest first
   - Never deletes `.manifest.jsonl`
   - Returns `{ deleted: number, freedBytes: number }`

3. [REFACTOR] Share retention/cap constants with lifecycle.ts in storage module

**Verification:**
- [ ] Old files pruned correctly
- [ ] Size cap enforced
- [ ] Manifest file protected

**Dependencies:** Task 005 (session directory structure)
**Parallelizable:** Yes (parallel with Tasks 006-011 after 005)

---

### Phase C: Query Layer

---

### Task 013: Session provenance projection

**Phase:** RED → GREEN → REFACTOR

**Context:** CQRS view projection that materializes session events into queryable aggregates. Lazy — never hydrated at startup.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true, performanceSLAs: [{ operation: "session-view-materialization", metric: "p99_ms", threshold: 500 }] }`

**TDD Steps:**
1. [RED] Write tests:
   - `materializeSession_ToolEvents_ReturnsToolBreakdownByCategory`
   - `materializeSession_TurnEvents_ReturnsTokenTotals`
   - `materializeSession_SummaryEvent_ReturnsSessionOverview`
   - `materializeWorkflow_MultipleSessions_AggregatesAcrossSessions`
   - `materializeMetric_Cost_ReturnsTokenTotalsBySession`
   - `materializeMetric_Attribution_ReturnsFileToToolMapping`
   - Benchmark: `materializeSession_1000Events_CompletesUnder500ms`
   - File: `servers/exarchos-mcp/src/session/session-provenance-projection.test.ts`
   - Expected failure: module does not exist

2. [GREEN] Implement projection
   - File: `servers/exarchos-mcp/src/session/session-provenance-projection.ts`
   - `materializeSessionProvenance(stateDir: string, query: SessionProvenanceQuery): Promise<SessionProvenanceResult>`
   - Query types: `{ sessionId }`, `{ workflowId }`, `{ workflowId, metric: 'cost' | 'attribution' }`
   - Reads session JSONL files on-demand (lazy, no startup cost)
   - In-memory LRU cache for recently accessed sessions (bounded, default 20 entries)

3. [REFACTOR] Extract query dispatch to separate handlers per metric

**Verification:**
- [ ] Correct aggregation by session and workflow
- [ ] Cost metric returns token breakdown
- [ ] Attribution metric returns file→tool mapping
- [ ] Performance within SLA

**Dependencies:** Tasks 005 (types), 010 (session events exist)
**Parallelizable:** No (sequential after 010)

---

### Task 014: View integration in exarchos_view

**Phase:** RED → GREEN → REFACTOR

**Context:** Register `session_provenance` as a queryable view in the `exarchos_view` action router. Follows existing view registration pattern.

**Testing Strategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `exarchosView_SessionProvenance_BySession_ReturnsSessionData`
   - `exarchosView_SessionProvenance_ByWorkflow_ReturnsAggregatedData`
   - `exarchosView_SessionProvenance_InvalidQuery_ReturnsError`
   - File: `servers/exarchos-mcp/src/views/tools.test.ts` (extend existing)
   - Expected failure: `session_provenance` view not registered

2. [GREEN] Register view
   - File: `servers/exarchos-mcp/src/views/tools.ts`
   - Add `session_provenance` to view dispatch in the view handler
   - Wire to `materializeSessionProvenance` from Task 013
   - Return compact result (respect token economy — summaries, not raw events)

3. [REFACTOR] Align response format with other view responses

**Verification:**
- [ ] View accessible via `exarchos_view { view: 'session_provenance', ... }`
- [ ] Returns structured data matching query type
- [ ] Token-efficient response (summaries, not raw event dumps)

**Dependencies:** Task 013
**Parallelizable:** No (sequential after 013)

---

## Parallelization Strategy

```
Layer 1 (parallel, no dependencies):
├── Worktree A: Tasks 001 → 002 → 003  (sidecar infrastructure)
├── Worktree B: Task 004                (cancel fix + idempotency keys)
├── Worktree C: Tasks 005 → 006 → 007  (session types + transcript parser)
└── Worktree D: Task 009               (SessionEnd CLI + hook registration)

Layer 2 (depends on Layer 1):
├── Worktree E: Tasks 008, 011         (SessionStart manifest + retry) [depends on C]
├── Worktree F: Task 010               (SessionEnd extraction wiring) [depends on C, D]
└── Worktree G: Task 012               (lifecycle manager) [depends on C]

Layer 3 (depends on Layer 2):
└── Worktree H: Tasks 013 → 014        (session provenance view) [depends on F]
```

**Summary:**
- Layer 1: 4 worktrees in parallel (max parallelism)
- Layer 2: 3 worktrees in parallel
- Layer 3: 1 worktree (sequential)
- Total: 8 worktrees across 3 layers

---

## Deferred Items

| Item | Rationale |
|------|-----------|
| Phase D: Basileus summary replication | Pending Basileus HTTP client (Phase 4 of distributed-sdlc-pipeline ADR). Session summary event type and outbox integration deferred. |
| F-STORE-1: Sequence pre-increment | P4 minor. In-memory counter diverges on write failure; restart recovers. Low-priority fix. |
| F-STORE-2: Idempotency eviction | P4 minor. Documented trade-off; retries within same session are deduplicated. |
| F-REVIEW-1: Standalone EventStore in review | P2. Review module creates `new EventStore()` per call. Separate refactor. |
| F-SCHEMA-1: Optional metadata fields | P3. Making `source` required on all events is a schema migration. Separate hardening pass. |
| F-SCHEMA-2: Per-type data validation | P3. Adding discriminated union validation requires touching all event emission paths. Separate pass. |

---

## Completion Checklist
- [ ] All tests written before implementation (TDD compliance)
- [ ] All tests pass
- [ ] F-GATE-1 resolved (sidecar pattern replaces raw appendFile)
- [ ] F-CANCEL-1/F-CANCEL-2 resolved (event-first enforced, idempotency keys added)
- [ ] F-CHECKPOINT-1, F-TASK-1, F-TASK-2 resolved (idempotency keys added)
- [ ] Session manifest written on SessionStart
- [ ] Transcript parsed into structured events on SessionEnd
- [ ] Retry mechanism recovers from failed extraction
- [ ] Lifecycle pruning enforces 7-day retention and 50MB cap
- [ ] session_provenance view queryable via exarchos_view
- [ ] Zero per-tool-call overhead (no PostToolUse hook)
- [ ] Zero cold start impact (session data not in main SQLite)
- [ ] Code coverage meets standards
- [ ] Ready for review
