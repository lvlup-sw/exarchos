# Design — v2.10.0-preview.4 substrate hygiene bundle (RC1-ready)

> **Status:** Draft
> **Author:** @rsalus
> **Date:** 2026-05-17
> **Epic:** #1441 — v2.10.0-preview.4 polish + post-bundle follow-ups
> **Closes:** #1446 (residue), #1434, #1448 (hygiene), #1438 FINDING-4..8
> **Philosophy:** Audit + INV-aligned hardening (F-5+F-6 co-design as one subsystem; F-8 explicitly considered + rejected for hardening)

---

## Context

The v2.10.0-preview.4 bundle landed two substrates: the EventSourcedTaskStore (#1430) and the correlation-tuple indexed columns + telemetry filters (#1447 + #1449). Both received post-merge audits identifying follow-up findings; all HIGH-severity TaskStore correctness issues (#1443/#1444/#1445) and the consumer-side correlation wiring (#1449) have landed.

The remaining open follow-ups span two subsystems but share a single coherence theme: **close the post-#1430+#1447 audit follow-ups before v2.10.0-RC1**. Two of the open items also affect the live operator surface — #1434 crashes the `exarchos_view pipeline` action on any repo with a `__migration__` sentinel stream (every upgraded repo), and the 3 unregistered view actions silently bypass DR-5 schema validation at dispatch. Both are RC1-visible.

This bundle groups the work into one design surface because:

- All findings are MEDIUM/LOW severity (no HIGH-class correctness gap remains);
- All ship together cleanly against the same RC1 sequencing decision;
- Each finding is small enough to be a wave within one PR rather than a standalone landing;
- The user accepted the multi-subsystem blast-radius tradeoff explicitly during ideation.

The audit recommendations (`docs/research/2026-05-16-event-sourced-task-store-audit.md` and the #1434/#1446 issue bodies) are taken as the floor. F-5 + F-6 receive INV-aligned hardening as one co-designed "cursor + hydration" subsystem; F-8 is explicitly evaluated for hardening and the audit-aligned answer retained with documented rationale.

## Decision

Ship a single feature branch `feature/preview-4-substrate-hygiene` containing two parallel-safe waves of work mapped to the eight findings:

**Wave V (views layer, parallel-safe):**

- T1 — Register `session_provenance`, `provenance`, `ideate_readiness` in `TOOL_REGISTRY.viewActions` (#1446 residue). Mirror the Wave 5 pattern from `registry.ts:2731–2784`. Each schema is a `z.object({...})` derived from the composite handler's existing arg shape, with `CORRELATION_TUPLE_FILTER_SHAPE` included for the two that touch the event store.
- T2 — Add an internal-sentinel skip to `ViewMaterializer`'s stream iterator: streams whose `streamId.startsWith('__')` are excluded from snapshot/load (option (a) from #1434). Narrower than relaxing `SAFE_ID_PATTERN`; preserves the kebab-only constraint for user-facing featureIds.
- T3 — Hygiene close: add resolution comment to #1448 confirming items 2–5 landed via PR #1449, update epic #1441 checklist.

**Wave T (task-store layer):**

- T4 — Size-cap reap on `createTask` when `this.tasks.size > 1024` (F-4 verbatim).
- T5 — `logger.warn` on the `(createdData['request'] ?? {}) as Request` coerce site in `projectTask:455`, including streamId + event sequence (F-7 verbatim).
- T6 — Persist `requestId` on the `task.created` event payload going forward. Fallback synthesizer `replayed:${taskId}` retained for existing events (F-8 audit-aligned, see §F-8 disposition below).
- **T7+T8 co-designed — Cursor + Hydration subsystem (F-5 + F-6)**: see §Subsystem design.

Sequencing within the branch: Wave V tasks are parallel-safe (touch different files). Wave T tasks T4/T5/T6 are parallel-safe; T7+T8 are sequential and depend on each other's design contract.

## Subsystem design — Cursor + Hydration (F-5 + F-6)

Today `listTasks` reads `Array.from(this.tasks.values())` in Map insertion order, then paginates. Insertion order is set by `hydrateFromEventStore` enumeration order on cold start and by `createTask` insertion sequence afterward — neither stable across processes, and `hydrateFromEventStore` enumerates every `task-store/*` stream on every `listTasks` call.

The co-designed surface introduces one rule and one mechanism:

**Sort rule** — tasks are ordered by `(createdAt ASC, taskId ASC)`. `createdAt` is deterministic from the `task.created` event timestamp; `taskId` is the tie-break for events with identical timestamps (possible on fast paths). The cursor encodes the sort key:

```ts
type ListTasksCursor = {
  readonly createdAt: string;   // ISO-8601 from the last task on the prior page
  readonly taskId: string;      // tie-break
};
// Wire format: base64url(JSON.stringify(cursor))
```

**Hydration mechanism** — `hydrateFromEventStore` becomes cursor-anchored and incremental:

1. On a `listTasks` call, query the event store for `task.created` events with `createdAt >= cursor.createdAt` (or all if no cursor), capped at `limit + lookahead` (lookahead is small, e.g., 8, to absorb tie-break churn).
2. For each `task.created` event in the page, hydrate the per-task projection from `task-store/{taskId}` if not already cached in `this.tasks`. Skip already-cached tasks.
3. Apply the sort rule to the union of (newly hydrated) + (cached) tasks within the page window, slice to `limit`, emit `nextCursor` from the last item.

Trade-offs vs alternatives:

- *(LRU cache of projections only)* — rejected: doesn't fix the O(N) enumeration; only caches what's already loaded.
- *(Separate (createdAt, taskId, streamId) index table)* — rejected for now: adds a second source of truth that must stay consistent with the event log. Re-evaluable in v2.11 if the lookahead approach degrades under load.
- *(Sort by sequence # of task.created in the dispatched stream)* — rejected: harder to compute, and the audit doc already prefers `createdAt`.

**Event-store query surface** — this design assumes the call `EventStore.queryByType('task.created', { streamPrefix: 'task-store/', since, limit })` is available (signature: `queryByType(eventType, filters)` where `filters` is `QueryFilters & { streamPrefix?: string }`; see `servers/exarchos-mcp/src/event-store/store.ts:526`). Wave T implementation must verify this against the V6 schema and, if missing, file a sub-issue for the minimal extension (NOT widen scope inside this bundle).

## F-8 disposition (requestId)

The hardening philosophy invited reconsidering the audit-aligned "keep the fallback synthesizer" answer. Evaluation:

| Option | INV-1 status | Operational cost | Benefit |
|---|---|---|---|
| (A) Audit-aligned: add `requestId` to new `task.created` events; keep synthesizer for old | Compliant | None | Forward-clean; back-fill is read-only |
| (B) Compensating event: emit `task.requestIdHydrated` for each existing task | Compliant | N new events (one per existing task) | Removes synthesizer wart |
| (C) Mutate existing `task.created` rows in DR sweep | **Violates INV-1** | Migration risk | Rejected on principle |

**Decision: (A).** The synthesizer is read-side only (no event payload is written from the synthetic value); its presence is a 1-line projection branch. Option (B) produces an operationally meaningful N-event footprint to remove a 1-line branch — not worth it. The audit-aligned answer survives INV-aligned re-evaluation. Documented here so future audits don't relitigate.

## Components touched

| File | Why | Wave |
|---|---|---|
| `servers/exarchos-mcp/src/registry.ts` | T1 — add 3 viewActions entries | V |
| `servers/exarchos-mcp/src/views/materializer.ts` | T2 — sentinel-skip in stream iterator | V |
| `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts` | T4/T5/T6/T7/T8 | T |
| `servers/exarchos-mcp/src/event-store/store.ts` (or sqlite-backend) | T7 — verify `queryByType(eventType, { streamPrefix, since, limit })` is wired through to `SqliteBackend` | T |
| `servers/exarchos-mcp/src/__tests__/...` co-located | regression tests per task | both |

No schema migration. No event payload changes for existing events. No CLI surface changes (T1 schemas auto-emit flags via `addFlagsFromSchema` per memory note `project_cli_schema_driven_flags`).

## Design invariants (#1109 catalog)

| Invariant | Status | Note |
|---|---|---|
| **INV-1** event-sourcing integrity | ✓ Preserved | No event mutation. F-8 fallback is read-side; F-6 hydration anchors on event timestamps. Cursor is a read-side construct. |
| **INV-2** facade equivalence over shared dispatch core | ✓ Preserved | T1 brings 3 actions under the standard dispatch validation path; net+ for facade symmetry. |
| **INV-3** basileus-forward | ✓ Preserved | Multi-process correctness (cursor stability across restarts) is exactly the F-5 fix. Removes a basileus-blocker. |
| **INV-4** platform-agnosticity | ✓ Preserved | All changes are storage-backend-agnostic. Materializer sentinel-skip is filesystem-symmetric. |
| **INV-5a** input ergonomics | ✓ Preserved | Cursor is opaque to callers; default limit unchanged. T1 makes 3 actions schema-validatable (input contract honesty). |
| **INV-5b** spec-aligned output contract | ✓ Preserved | `nextCursor` field shape unchanged externally; internal encoding shifts. Envelope shape preserved. |
| **INV-5c** Aspire-inspired control-plane verbs | n/a | No new verbs. |
| **INV-5d** action discriminator pattern | ✓ Preserved | T1's 3 actions retain their existing discriminator strings. |
| **INV-6** workflow-agnosticism | ✓ Preserved | No skill/playbook changes. |

## Axiom dimensions (DIM-1..8)

| Dimension | Status | Note |
|---|---|---|
| **DIM-1** topology / cohesion | ↑ Improved | Cursor + hydration co-designed reduces "dual sources of truth" smell flagged in audit (in-memory Map vs event stream). |
| **DIM-2** observability | ↑ Improved | F-7 coerce-and-warn closes a silent fold-time hazard. T1 surfaces 3 actions in `describe()`. |
| **DIM-3** context economy | ↑ Improved | Cursor + hydration reduces per-`listTasks` O(N) stream scan. |
| **DIM-4** complexity budget | → Neutral | Each task is small. Cursor sort+lookahead adds modest complexity; offset by removing per-call full enumeration. |
| **DIM-5** dependency direction | ✓ Preserved | views→event-store, task-store→event-store. No cycles introduced. |
| **DIM-6** testability | ↑ Improved | Stable cursor enables deterministic pagination tests across restarts; F-5/F-6 was previously test-fragile. |
| **DIM-7** lifecycle | ↑ Improved | F-4 size-cap reap removes the "unread tasks never reaped" hazard. |
| **DIM-8** contract honesty | ↑ Improved | T1 closes the DR-5 schema validation gap for 3 actions; #1446 issue body is explicit: "input is cast (rest as {...}) at the composite layer but never Zod-parsed at runtime." |

No dimension regresses.

## Out of scope

- T17 `next_actions` real-handler integration (already closed via #1449's "no production auto-dispatch handler exists" investigation — replaced with permanent justification + roundtrip guard).
- Cross-tier correlation propagation (basileus / remote MCP — INV-3 deferred to v3+ roadmap).
- Filter-aware materializer cache keying (rejected in PR #1447 design).
- TaskStore: any reopening of FINDING-1/2/3 (already landed in #1443/#1444/#1445).
- `_eventHints.missing` auto-emit audit (#1395) — separate bundle.
- Invariant content audit (#1370 + #1439) — separate bundle.

## Risks

- **F-7 coerce-and-warn log noise**: if many existing streams contain malformed `request` payloads, the warn may fire repeatedly. *Mitigation*: include streamId in the log so it's deduplicable; if noise becomes operational, downgrade to debug or sample 1/N. Land as `warn` and observe.
- **F-6 cursor lookahead under-shoots tie-break churn**: if many `task.created` events share a millisecond timestamp, lookahead=8 may leave gaps. *Mitigation*: lookahead is configurable; integration tests assert lookahead=8 is sufficient at expected creation rates. If observed in the wild, raise.
- **T2 sentinel-skip hides a legitimate `__`-prefixed stream**: the only known sentinel is `__migration__`. *Mitigation*: log at debug level when a `__`-prefixed stream is skipped; explicit allowlist (`__migration__`) reviewable in v2.11 if other sentinels emerge.
- **Event-store query surface assumption**: T7's cursor mechanism assumes the call shape `EventStore.queryByType(eventType, { streamPrefix, since, limit })` is available. *Mitigation*: T7 implementation verifies this first; on miss, files a 1-line `EventStore.queryByType` extension issue and falls back to existing query + post-filter (degrades to today's behavior for the cold-start path only).

## Acceptance

- [ ] #1446 residue closed: `session_provenance`, `provenance`, `ideate_readiness` registered; `exarchos_view describe` exposes all 17 dispatched actions; per-action dispatch validation fires for each.
- [ ] #1434 closed: `exarchos_view pipeline` succeeds on a repo with a `__migration__` stream; sentinel-skip covered by a regression test.
- [ ] #1448 closed: resolution comment posted confirming items 2–5 landed via PR #1449; epic checklist updated.
- [ ] #1438 F-4 closed: `tasks.size > 1024` triggers reap on `createTask`; regression test.
- [ ] #1438 F-5 closed: cursor stable across process restarts; cross-process pagination test.
- [ ] #1438 F-6 closed: `listTasks` performs O(page) stream queries, not O(total tasks); benchmark or counter assertion.
- [ ] #1438 F-7 closed: `projectTask` malformed-request path emits a warn with streamId + sequence; coverage test.
- [ ] #1438 F-8 closed: new `task.created` events include `requestId`; old events fall back to synthetic; coverage test.
- [ ] Full MCP server suite passes: `cd servers/exarchos-mcp && npm run test:run`.
- [ ] Typecheck clean: `npm run typecheck`.

## Decision log

- **2026-05-17** — Bundle scope reframed mid-ideation: PR #1449 landed #1448 items 2–5 between epic-writing and design-writing. Original Bundle A reduced to #1446 residue + #1434 + #1448 hygiene; combined with TaskStore F-4..8 per user direction.
- **2026-05-17** — F-8 evaluated for compensating-event hardening (Option B); rejected on operational footprint vs benefit. Audit-aligned answer retained.
- **2026-05-17** — F-5 + F-6 co-designed as one cursor + hydration subsystem per hardening philosophy; separate `(createdAt, taskId, streamId)` index table rejected as second source of truth (re-evaluable in v2.11).

## Event vocabulary note

This design references `task.created`, `task.polled`, `task.result`, and `task.cancelled`. These are the **SDK task-store lifecycle events** (see `@modelcontextprotocol/sdk/experimental/tasks/interfaces.ts:TaskStore`), declared at `servers/exarchos-mcp/src/event-store/schemas.ts:172-185` with an explicit comment block distinguishing them from the workflow-orchestration `task.assigned`/`task.claimed`/`task.progressed`/`task.completed`/`task.failed` family (declared earlier in the same file at lines 10-14).

These are **two distinct event domains** in this codebase:

- Task-store events back the `EventSourcedTaskStore` in `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts` — they durably record the SDK protocol's task lifecycle (create → poll → result/cancel).
- Workflow events back the orchestrator's workflow lifecycle (`task.assigned` when a subagent claims a workflow task, `task.completed` when its result lands, etc.).

Renaming `task.created` to `task.assigned` in this design would create doc–code divergence: the code emits `task.created` to the `task-store/{taskId}` stream, the V5→V6 schema migration backfills `task.created` rows, and `EventStore.queryByType('task.created', ...)` is the literal API call in `hydrateFromEventStore`. The design intentionally uses the same vocabulary as the code.

## References

- Epic: #1441
- TaskStore audit: `docs/research/2026-05-16-event-sourced-task-store-audit.md`
- Bundle audit: `docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md`
- Prior correlation design: `docs/designs/2026-05-16-correlation-indexed-columns.md`
- Prior correlation consumer wiring: `docs/designs/2026-05-16-correlation-consumer-wiring.md`
- PR #1449 (closes #1448 items 2–5)
- PR #1443/#1444/#1445 (closed #1438 F-1/F-2/F-3)
