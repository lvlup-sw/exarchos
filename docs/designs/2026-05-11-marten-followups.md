# v2.10.0-preview.2 Follow-ups: PID Lock Demotion, Snapshot Substrate Migration, and Two-Event-Split Rollout

**Status:** draft  
**Issues:** #1343 (PID lock contradiction), #1342 P1.B/D/E (two-event split rollout + CI grep gates)  
**Base branch:** `release/v2.10.0-preview.2`  
**Integration branch:** `feature/v2.10.0-preview.2-followups`  
**Workflow:** `refactor-marten-followups` (overhaul track)

## Problem

`v2.10.0-preview.2` shipped Marten primitives and a single reference consumer (merge-orchestrate) but left two correctness gaps in the substrate and four underused primitives at the consumer layer.

**#1343 — PID lock contradicts the runtime architecture.** `EventStore.initialize()` holds an exclusive `.event-store.lock` PID lock per `stateDir` and throws `PidLockError('live-holder')` when a second process attempts to attach. The documented model (`docs/architecture/runtime.md` §1, §4, §8) is multi-process serialized at the SQLite WAL layer; the lock contradicts that. Two `claude` sessions in the same repo cannot both connect to the exarchos MCP. The substrate is genuinely safe via `BEGIN IMMEDIATE` + `PRIMARY KEY (stream_id, sequence)` — the lock is policy, not safety.

Residue worth fixing alongside: the projection snapshot sidecar (`projections/store.ts`) still writes `<streamId>.projections.jsonl` with an explicit single-writer caveat. This is the last JSONL holdout in the persistence layer; SQLite WAL already handles concurrent access on every other table.

**#1342 P1.B — Two-event split rollout.** Only `merge-orchestrate` consumes the two-event split pattern (`*.requested` event commits before side-effect; `*.executed` event commits after). Five non-idempotent side-effect handlers remain at-risk of retry-storm replay if `withStateRetry` catches a `ConcurrencyError` or `StorageBusyError`:

| Handler | File | Side effect |
|---|---|---|
| `create_pr` | `orchestrate/vcs/create-pr.ts` | `gh pr create` |
| `add_pr_comment` | `orchestrate/vcs/add-pr-comment.ts` | `gh pr comment` |
| `create_issue` | `orchestrate/vcs/create-issue.ts` | `gh issue create` |
| `delete-feature-branches` (compensation) | `workflow/compensation.ts:206` | `git branch -D` + `git push origin --delete` |
| `cleanup-worktrees` (compensation) | `workflow/compensation.ts:147` | `git worktree remove --force` |

**#1342 P1.D/E — CI grep gates.** Two compile-review checks prevent regressions of the audit §F1.1 (`withSession` without idempotency contract) and §F1.2 (`BEGIN IMMEDIATE` outside the substrate) anti-patterns.

## Goals

1. **Demote the PID lock.** `EventStore.initialize()` no longer throws on concurrent process attach. Two `claude` sessions in the same repo can both connect.
2. **Migrate snapshot sidecar into SQLite.** Replace `<streamId>.projections.jsonl` with a `projection_snapshots` table; existing concurrency, size-cap, and read-latest semantics preserved.
3. **Roll out two-event split to five remaining non-idempotent handlers.** Each handler emits `*.requested` (committed) before its side effect and `*.executed` (committed) after. The `*.requested` event becomes the retry-safety boundary; the `*.executed` event records the observed effect.
4. **Ship two CI grep gates.** Forbid `withSession` calls that omit both `operationId` and `allowNonIdempotent: true`. Forbid `BEGIN IMMEDIATE` outside the substrate module.

## Non-goals

- Outbox row leasing (`leasedBy` / `leaseExpiresAt` columns). Track as separate issue.
- `decide` rollout (P2 of #1342).
- `aggregateStream` adoption beyond Wave 4 (P2).
- In-memory store audit (P2).
- `workflow_type` reader wiring (deferred to #1090/#1316).
- `design-invariants` skill check for cross-process locks (P3 follow-up).

## Approach

### Wave A — Substrate (#1343)

1. **A1.** Add `projection_snapshots` table to SQLite schema with migration:
   ```sql
   CREATE TABLE projection_snapshots (
     stream_id TEXT NOT NULL,
     projection_id TEXT NOT NULL,
     projection_version TEXT NOT NULL,
     sequence INTEGER NOT NULL,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (stream_id, projection_id, projection_version, sequence)
   );
   CREATE INDEX idx_projection_snapshots_latest
     ON projection_snapshots(stream_id, projection_id, projection_version, sequence DESC);
   ```
   Schema migration test added in `storage/__tests__/schema-migration.test.ts`.

2. **A2.** Extend `StorageBackend` interface with `readLatestProjectionSnapshot(...)` and `appendProjectionSnapshot(...)`. Implement in `SqliteBackend` and `InMemoryBackend`.

3. **A3.** Rewrite `projections/store.ts` to delegate to `StorageBackend`. Existing `readLatestSnapshot` / `appendSnapshot` exports become thin wrappers. Size-cap policy (`resolveMaxRecords`, `applySizeCap`) preserved — applied as a `DELETE` of oldest rows post-insert. Remove `atomicWriteFile` / `getSnapshotSidecarPath` / `readIfExists` once nothing imports them.

4. **A4.** Demote PID lock in `event-store/store.ts`:
   - Delete `acquirePidLock`, `acquirePidLockWithWait`, `lockFilePath`, `PidLockError` class.
   - Remove `InitializeOptions.waitForLock*` fields.
   - `initialize()` becomes a no-op marker; keep it for back-compat (some callers `await store.initialize()` before first use).
   - Update inline comments at lines 162–167 and 258–288 to reflect the SQLite-WAL ownership model.

5. **A5.** New cross-process test: spawn two `EventStore` instances against the same `stateDir`, run interleaved `append`/`query` from each, assert both observe each other's events with no `PidLockError`.

6. **A6.** Update `docs/architecture/runtime.md` §1, §4, §8: substitute "PID lock per stateDir" language with "SQLite WAL + `BEGIN IMMEDIATE`". Verify §RT-1..RT-6 read truthfully.

### Wave B — Two-Event-Split Rollout (#1342 P1.B)

Five handler migrations follow the same shape (mirrors `execute-merge.ts`):

1. **B1–B5.** For each handler — `create-pr`, `add-pr-comment`, `create-issue`, `delete-feature-branches`, `cleanup-worktrees`:
   - Define paired event types in `event-store/schemas.ts` (e.g., `pr.create.requested` / `pr.create.executed`). Each carries an `operationId` (UUID) for idempotency.
   - Refactor the handler:
     - Append `*.requested` event with `operationId` + input args BEFORE the side effect. Use `appendComputed` keyed by `operationId`.
     - If the requested event commit fails → return error, no side effect attempted.
     - Run the side effect.
     - On success, append `*.executed` with `operationId` + observed result. On failure, append `*.failed` (or equivalent compensating event) with the error.
   - RED → GREEN per task: write a `non-refire` fixture (the side effect MUST NOT re-execute when a Phase-A `ConcurrencyError`/`StorageBusyError` triggers retry).

2. **B6.** Update `event-store/schemas.ts` registration. Each new event type added BEFORE first append (INV-1 acceptance question 2).

### Wave C — CI Grep Gates (#1342 P1.D + P1.E)

1. **C1.** `scripts/grep-gates/forbid-withsession-without-idempotency.sh` — fails if any call to `.withSession(` lacks BOTH `operationId:` and `allowNonIdempotent: true` in the same call site. Exempt tests via path filter.

2. **C2.** `scripts/grep-gates/forbid-begin-immediate-outside-substrate.sh` — fails if any TypeScript file outside `servers/exarchos-mcp/src/storage/` or `servers/exarchos-mcp/src/event-store/` contains the literal `BEGIN IMMEDIATE`. Tests for the substrate module itself are allowed via path filter.

3. **C3.** Wire both into the CI workflow (`.github/workflows/*`). Run as a fast-fail step before tests.

### Wave D — Documentation

1. **D1.** Update `docs/architecture/runtime.md` (covered in A6 but called out here for tracking).
2. **D2.** New section in `docs/architecture/projections.md` documenting the SQLite-backed snapshot store.
3. **D3.** Update `docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md` to mark §F1.1 and §F1.2 resolved.

## Success criteria

From #1343 acceptance:

- [ ] Two concurrent `claude` sessions in the same repo both connect to exarchos MCP and can read/write the same workflow streams.
- [ ] No `.event-store.lock` file appears in `stateDir`.
- [ ] Projection snapshots are stored in SQLite; the `*.projections.jsonl` sidecar files are no longer created.
- [ ] `runtime.md` §4 reads truthfully against the implementation.
- [ ] Existing concurrency tests (`cli-concurrency.test.ts`, `store.race.test.ts`, `wal-concurrency.test.ts`) all still pass.
- [ ] One new test exercises the two-MCP-process case end-to-end.

From #1342 P1.B/D/E acceptance:

- [ ] All five handlers emit paired `*.requested`/`*.executed` events with `operationId`-keyed idempotency.
- [ ] Each handler has a `non-refire` fixture proving the side effect does not re-execute on Phase-A retry (`ConcurrencyError` or `StorageBusyError`).
- [ ] CI grep gate fails the build on `withSession` without idempotency contract.
- [ ] CI grep gate fails the build on `BEGIN IMMEDIATE` outside the substrate.

## Design quality and invariants audit

`/axiom:design` walk against DIM-1..DIM-8 with `/design-invariants` overlays:

### DIM-1 Topology + INV-1 Event-Sourcing Integrity

- **Lifecycle ownership.** SQLite WAL becomes the single source of truth for cross-process serialization. PID lock removed — no shared-resource lifecycle hazard.
- **Stores-as-projections.** The new `projection_snapshots` SQLite table is an optimization over the event log, not a second source of truth. Cold rebuild via `rebuildProjection` still works when the table is empty (per `docs/architecture/projections.md` §1).
- **Two-event split preserves INV-1.** `*.requested` and `*.executed` events are intent-named facts. The handler reads no state across the boundary — the `operationId` carries idempotency. INV-1 acceptance question 4 (reconstructable from events alone) is upheld: replay produces the same observable timeline.
- **Risk:** Each new event type must register in `event-store/schemas.ts` BEFORE first append (INV-1 MEDIUM severity guide). Wave B6 captures this explicitly.

### DIM-2 Observability + INV-1 (overlap)

- **Catch posture.** No new silent catches introduced. Existing `try/catch` in `delete-feature-branches` (`workflow/compensation.ts:236,242`) and `cleanup-worktrees` (`:185`) currently swallow errors; the two-event split rollout changes the shape — the `*.executed` event becomes the success witness, and a missing `*.executed` event becomes the observability signal. Document the rationale per dimension question.
- **Fallback visibility.** Removing the PID lock removes a fallback path (sidecar fallback was already deleted in v2.11). No new fallbacks introduced.

### DIM-3 Contracts + INV-1

- **Schema boundaries.** New `projection_snapshots` table needs schema migration (Wave A1). Existing `SnapshotRecord` Zod schema unchanged — only the storage carrier swaps.
- **Versioning posture.** Backward-compatible: the JSONL sidecar reader is removed in the same change that introduces the SQLite reader. No dual-read window required because v2.11 substrate cut has not shipped to users with sidecar-format snapshots (v2.10.0-preview.2 is pre-release).
- **Event types are new contracts.** Five paired `*.requested`/`*.executed` event types added — each registered in `event-store/schemas.ts` before first emission (INV-1 + INV-3 alignment).

### DIM-4 Test Fidelity + INV-2 Facade Equivalence

- **Wiring parity.** New 2-process test (Wave A5) constructs two real `EventStore` instances — no mocking.
- **Parity harness coverage.** Each new event type should have a parity fixture confirming both CLI and MCP carriers observe the same event sequence. The two-event split is a behavior change visible at the dispatch boundary — INV-2 acceptance question 3 applies.
- **Non-refire fixtures.** Each handler migration includes a fixture exercising Phase-A retry (mirrors `execute-merge.ts` pattern from Wave 4.2b).
- **Skip discipline.** No `.skip` introduced.

### DIM-5 Hygiene

- **Dead code removal.** PID lock removal deletes `acquirePidLock`, `acquirePidLockWithWait`, `lockFilePath`, `PidLockError` class, `InitializeOptions.waitForLock*` fields, and (if unused) `atomicWriteFile` callsites in `projections/store.ts`. No commented-out code left behind.
- **Single implementation.** Snapshot storage consolidates from JSONL sidecar + SQLite events into one substrate. Two-event split consolidates from "per-handler ad-hoc" to "one canonical pattern" already documented in audit §F1.2.

### DIM-6 Architecture + INV-3 Basileus-Forward

- **Dependency direction.** Storage layer (SqliteBackend) gains snapshot APIs — projections module depends on storage interface, not vice versa. Inward-pointing.
- **Module responsibility.** `projections/store.ts` becomes a thin adapter over `StorageBackend`. Single responsibility per module preserved.
- **INV-3 alignment.** Removing the filesystem-bound PID lock is a prerequisite for the remote-MCP variant (INV-3 explicitly cites this: "a filesystem PID lock can't work over the remote-MCP variant"). The refactor *enables* basileus-forward without coupling to a specific transport.

### DIM-7 Resilience

- **Cache bounds.** Snapshot size cap (`SNAPSHOT_MAX_RECORDS`, default 500) preserved by deleting oldest rows post-insert.
- **Timeout coverage.** No new external calls introduced. Existing `gh` CLI calls in VCS handlers already have provider-level timeouts.
- **Retry shape.** `withStateRetry` already bounds attempts. Two-event split makes retry safe at the handler level — the `*.requested` event commits before any external side effect, so a retry from before the side effect doesn't re-fire.
- **Resource lifecycle.** No new file handles or connections. PID lock file removal is itself a resource cleanup.

### DIM-8 Prose Quality

- Doc updates (Wave D) follow project voice: concrete file:line references, no AI-vocabulary clustering, no inflated significance language.

## Verdict (self-assessed)

**Conditional pass.** No HIGH findings against DIM-1..DIM-8 or INV-1..INV-5d. Two MEDIUM-severity items to address during implementation:

1. Each of the five new event-type pairs must register in `event-store/schemas.ts` BEFORE first append. Wave B6 makes this explicit; the per-task TDD plan should put the schema registration in the RED commit.
2. The two-event split changes the observable event timeline at the dispatch boundary. INV-2 parity-harness fixtures must cover both carriers for the new event types. The plan phase should extract a per-handler parity task.

This audit will be re-run against the implementation plan once `/exarchos:plan` produces it.

## Wave dependency graph

```
Wave A (substrate)        Wave C (CI gates)
   │                            │
   ├─ A1 schema migration       ├─ C1 withSession gate
   ├─ A2 backend interface      ├─ C2 BEGIN IMMEDIATE gate
   ├─ A3 projections/store.ts   └─ C3 wire into CI
   ├─ A4 demote PID lock
   ├─ A5 2-process test
   └─ A6 runtime.md update
              │
              ▼
Wave B (two-event split)
   ├─ B1 create-pr
   ├─ B2 add-pr-comment
   ├─ B3 create-issue
   ├─ B4 delete-feature-branches
   ├─ B5 cleanup-worktrees
   └─ B6 schema registration (could pull earlier; left here for narrative)
              │
              ▼
Wave D (documentation)
   ├─ D1 runtime.md (rolls A6 forward)
   ├─ D2 projections.md
   └─ D3 audit findings update
```

Waves A and C are independent — they can dispatch in parallel.  
Wave B depends on A2 (the `StorageBackend` snapshot APIs aren't needed, but the new event types share the same schema-registration discipline that A1-A2 establish).  
Wave D depends on A, B, C completing — final consolidation.

## Stacked-PR plan

| PR | Targets | Scope |
|---|---|---|
| PR 1 | `release/v2.10.0-preview.2` ← `feature/v2.10.0-preview.2-followups-wave-a` | A1–A6 (substrate) |
| PR 2 | PR 1 ← `feature/v2.10.0-preview.2-followups-wave-c` | C1–C3 (CI gates) — gates land before B so B's compliance is enforced from day one |
| PR 3 | PR 2 ← `feature/v2.10.0-preview.2-followups-wave-b` | B1–B6 (two-event split) |
| PR 4 | PR 3 ← `feature/v2.10.0-preview.2-followups-wave-d` | D1–D3 (docs) |

Merge order: bottom-up. GitHub auto-retargets each PR to `main` after the parent merges.

## Open questions

1. **Should the `projection_snapshots` migration backfill existing JSONL sidecars?** Probably not — v2.10.0-preview.2 is pre-release. A1 includes a migration test that confirms a clean install works; a separate task could add JSONL→SQLite migration if users have run preview.2 and accumulated sidecar data. Recommend: skip backfill, document the pre-release migration story.

2. **Does removing `PidLockError` from the public API count as a breaking change?** It's exported from `event-store/index.ts` — consumers downstream may import it. Audit on Wave A4 entry. If exported, keep the class as `@deprecated` for one release, throw nothing from `initialize()`.

3. **CI grep gates: should they live in the same script directory as existing checks?** Verify on Wave C entry — `scripts/grep-gates/` is the proposed location but there may already be a `scripts/ci/` or similar convention.

## `/design-invariants` audit (INV-1..INV-5d)

Independent walk of INV-1..INV-5d against this brief. Format matches the skill output contract (severity + invariant + location + description + required_fix + axiom_overlap).

```json
{
  "verdict": "conditional",
  "findings": [
    {
      "invariant": "INV-1",
      "severity": "MEDIUM",
      "file": "docs/designs/2026-05-11-marten-followups.md",
      "line": "Wave B section",
      "description": "The two-event split is safe at the event-store level (operationId-keyed appendComputed dedupes the *.requested event). But the side effect itself (gh pr create, gh pr comment, etc.) is not idempotent — re-running create-pr after the *.requested event commits but *.executed never lands will create a duplicate PR. The brief does not require a pre-side-effect idempotency check at the call site.",
      "required_fix": "Each handler must check whether the side effect has already been performed before invoking it. For create-pr: query existing PRs by (head, base) before calling gh pr create — if one exists, skip to *.executed emission. For create-issue: skip if an issue with the same idempotency-key marker exists. For branch/worktree deletion: skip if already absent (the current handlers already do this — confirm during implementation). Plan phase should extract a per-handler 'idempotent side-effect check' task as part of each migration.",
      "axiom_overlap": "DIM-7"
    },
    {
      "invariant": "INV-1",
      "severity": "LOW",
      "file": "docs/designs/2026-05-11-marten-followups.md",
      "line": "Wave B (B1-B5)",
      "description": "The brief does not specify the data payload shape for the new *.requested events. INV-1 'event design discipline' says events should capture intent. For full replay-reconstruction (INV-1 acceptance Q4), each *.requested event should carry the complete input args (title/body/base/head for create-pr, etc.), not just operationId.",
      "required_fix": "Plan phase: each handler's TDD task should define the *.requested event schema with full input args. Register schemas in event-store/schemas.ts before first emission (already captured in Wave B6).",
      "axiom_overlap": "DIM-3"
    },
    {
      "invariant": "INV-3",
      "severity": "LOW",
      "file": "docs/designs/2026-05-11-marten-followups.md",
      "line": "Wave A5",
      "description": "The new 2-process test exercises local cross-process via two EventStore instances against the same stateDir. Forward-compatible with the remote-MCP variant (the SQLite path doesn't assume process-local filesystem beyond the DB file), but the brief doesn't make this explicit. INV-3 'no MCP-second-class assumptions' is satisfied by the removal, but the test design could explicitly note forward-compatibility.",
      "required_fix": "In Wave A5 task description, note that the test design must avoid assumptions that would break under remote-MCP (e.g., do not bind to process-local PID paths). The SQLite WAL substrate already meets this; the note is for future authors.",
      "axiom_overlap": null
    },
    {
      "invariant": "INV-5b",
      "severity": "LOW",
      "file": "servers/exarchos-mcp/src/errors.ts:8",
      "line": 8,
      "description": "PidLockError is publicly exported from errors.ts (re-exported from event-store/store.ts:42). Removing the class is a breaking change to the public API. The brief 'Open question 2' flags this but does not resolve it.",
      "required_fix": "Wave A4 task: either (a) keep PidLockError as a deprecated stub that is never thrown (one-release deprecation window, matches INV-5b 'no breaking field renames without an envelope version bump' posture), or (b) treat v2.10.0-preview.X as a pre-release where removals are acceptable and delete outright. Decision should be made at plan-review checkpoint; if (a), add a deprecation comment with removal target version.",
      "axiom_overlap": "DIM-3"
    }
  ],
  "summary": {
    "INV-1": "Pass with MEDIUM (idempotent side-effect check) + LOW (event payload shape).",
    "INV-2": "Pass — facade equivalence preserved; both carriers see the same event timeline; parity-harness fixtures are in scope per the brief's DIM-4 section.",
    "INV-3": "Pass with LOW — PID lock removal directly serves basileus-forward; 2-process test is forward-compatible.",
    "INV-4": "N/A — design does not touch skills-src, runtimes, or capability surfaces.",
    "INV-5a": "N/A — no new tool inputs introduced.",
    "INV-5b": "Pass with LOW — PidLockError public-API removal needs deprecation decision.",
    "INV-5c": "N/A — no new CLI verbs.",
    "INV-5d": "N/A — no new top-level tools; new event types land on existing exarchos_event composite."
  }
}
```

**Verdict: conditional.** Zero HIGH findings. One MEDIUM (per-handler idempotent side-effect check at the dispatch boundary) and three LOW that the implementation plan must address during task extraction. The brief is architecturally sound; the per-task TDD plan needs to make the four items explicit.

## References

- #1343 (parent issue) — PID lock contradicts runtime architecture
- #1342 (parent epic) — Post-preview.2 leverage
- `docs/architecture/runtime.md` §1, §4, §8
- `docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md` §F1.1, §F1.2
- `docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md` §"ConcurrencyError envelope", §"StorageBusyError envelope"
- `servers/exarchos-mcp/src/event-store/store.ts:162-410` (PID lock implementation)
- `servers/exarchos-mcp/src/projections/store.ts` (JSONL sidecar)
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts:998` (`atomicAppend`)
- `servers/exarchos-mcp/src/orchestrate/execute-merge.ts` (two-event split exemplar, audit §F1.2 GREEN)
- INV-1 → `.claude/skills/design-invariants/references/INV-1-event-sourcing.md`
- INV-2 → `.claude/skills/design-invariants/references/INV-2-facade-equivalence.md`
- INV-3 → `.claude/skills/design-invariants/references/INV-3-basileus-forward.md`
- Axiom dimensions → cached at `/home/reedsalus/.claude/plugins/cache/lvlup-sw/axiom/0.3.0/skills/backend-quality/references/dimensions.md`
