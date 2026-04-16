# RCA: sidecar-mode events invisible to materializers and queries (issue #1082)

## Summary

`EventStore.append()` (and `batchAppend` / `appendValidated`) route writes to `{streamId}.hook-events.jsonl` when the instance is in sidecar mode, but `EventStore.query()` only reads `{streamId}.events.jsonl`. The sidecar merger that drains sidecar files into the main stream runs **once, at startup of the primary process only** (`src/index.ts:242-249`), never while the primary is alive. Result: any event written by a sidecar-mode instance is stranded for the lifetime of the primary. Every CQRS materializer (`delegation-readiness-view`, `code-quality-view`, etc.) is downstream of `query()`, so all event-sourced gates observe a stale view and report workflows as not-ready despite `state.json` being correct.

## Symptom

From a live dogfooding session on workflow `cli-vs-mcp-facade-analysis`:

- Three concurrent MCP server PIDs against the same state dir. PID 11535 acquired `.event-store.lock`; PID 12282 and PID 82138 entered sidecar mode.
- From a sidecar-mode session: `ideate → plan → plan-review` via `exarchos_workflow set` (phase transitions and `planReview.approved: true`). All `set` calls return `success: true`.
- `exarchos_workflow get` returns fully correct state: `planReview.approved: true`, `artifacts.plan` populated, `phase: "delegate"`.
- `exarchos_orchestrate prepare_delegation` reports: `blockers: ["plan not approved", "no task.assigned events found", "Plan artifact is missing"]`.
- Inspection of `{streamId}.hook-events.jsonl` shows the events are present (4 × `state.patched`, 3 × `workflow.transition`, 1 × `workflow.started`, 1 × `workflow.compound-entry`) — but invisible to the materializer. Main `{streamId}.events.jsonl` contains only 10 `gate.executed` events from orchestrate handlers (those bypass the normal append path at time of filing).
- The user cannot proceed past `prepare_delegation` without killing the lock holder, manually replaying the sidecar, or restarting the session.

### Root Cause

Two code paths diverge on the same logical stream:

- **Write (sidecar-aware):** `EventStore.append`, `batchAppend`, `appendValidated` check `this.sidecarMode` and route to `writeToSidecar()` → `{streamId}.hook-events.jsonl` (`src/event-store/store.ts:247-276, 288-314, 321-340, 434-444`).
- **Read (sidecar-blind):** `EventStore.query()` computes `getEventFilePath(streamId)` and streams only `{streamId}.events.jsonl` (`src/event-store/store.ts:575-649`).

The one mechanism that reconciles the two paths — `mergeSidecarEvents()` in `src/storage/sidecar-merger.ts` — is called exactly once, at primary startup, and only when the current process is NOT in sidecar mode (`src/index.ts:244-249`). While any primary is alive, sidecar files grow without bound and are invisible to every reader. Materializers inherit the blind spot because they receive events via `store.query()`.

### Expected Behavior

Either (a) materializers and `query()` read from both files, or (b) sidecar-mode writes fail fast with a clear degraded-mode signal. The ticket prefers (a) — transparent to callers.

## Severity

**HIGH.** The plugin is designed for multi-session use. Every non-primary session silently breaks `delegate → review → synthesize`, with no operator-visible signal until a downstream gate fails for a reason that doesn't name the real cause.

## Fix (Tier 1 — read-fix, this RCA)

Modify `EventStore.query()` to also read `{streamId}.hook-events.jsonl` when present, normalize each sidecar line into a `WorkflowEvent` with a synthetic sequence continuing from the main stream's max, sort by timestamp, apply existing filters uniformly, return the merged stream.

Properties preserved:
- No sidecar file → existing fast path unchanged (bench & perf safe).
- `SidecarMode_QueryStillWorksFromJsonl` test continues to pass (no sidecar events written → identical result).
- Sidecar events are materialized by downstream views without any view-layer changes.
- Sidecar merger behavior (ingest on primary restart) is unchanged.

Properties intentionally *not* addressed here (future tiers):
- **Tier 2 (live merge):** have the primary periodically drain sidecars under lock, assigning real sequences. Eliminates the "query sees synthetic sequences" edge case for long-running primaries.
- **Tier 3 (UX signal):** have `exarchos_workflow set` return `sidecarPending: true` when the underlying append landed in sidecar, so callers can detect degraded mode explicitly.

## Risk

- Sidecar events surfaced by `query()` have synthetic sequences (main max + 1, +2, …). Once the primary restarts and the merger runs, the same events acquire real sequences. This is a **live correctness risk** for the incremental materializer in `servers/exarchos-mcp/src/views/materializer.ts:155` — it filters events by `sequence > highWaterMark` and advances the HWM to the max synthetic sequence. After the primary drains the sidecar, the replayed events carry lower (real) sequences and are silently dropped as "already seen." Two mitigations (either is sufficient, neither is in scope for Tier 1): (a) the primary invalidates affected view-cache entries when draining, or (b) materializers reset HWM on sidecar-mode boundary transitions. Tier 2 (live drain) closes this surface by ensuring sidecar sequences become real within a bounded window.
- No sidecar-mode-to-sidecar-mode dedupe at query time: two sidecar instances writing events with the same `idempotencyKey` will both be returned. The existing sidecar merger dedupes at merge time; query-time dedupe is out of scope for Tier 1.

## Related

- #987 (closed) — JSONL/SQLite dual-write gap for team lifecycle events. Same family of materializer/storage divergence.
- #971 — introduced sidecar mode (commit `aae93225`).
- #1001 (closed) — `workflow set` auto-emit behavior clarification.
