# RCA: State-source integrity — pipeline streamId validator drift, rehydrate cold-probe store mutation, dual-source doc gap

## Summary

A `/exarchos:dogfood` trace surfaced three related defects in the rehydrate + views
subsystem of `servers/exarchos-mcp`: (CB-1) `exarchos_view pipeline` crashes on
valid two-segment streamIds because the write-side and projection-side streamId
validators disagree — an incomplete fix of closed #1434; (CB-2) `exarchos_workflow
rehydrate` of a non-existent featureId mutates the store by emitting a phantom
`workflow.rehydrated` event; (DOC-1) the SQLite-vs-`<id>.state.json` dual
source-of-truth is undocumented, which led an agent to assert a workflow was
"untracked" from filesystem evidence alone.

## Symptom

### CB-1 — pipeline view crash (HIGH)

```text
exarchos_view { action: "pipeline" }
→ VIEW_ERROR: Invalid streamId: "elicitation/0e24a37e-0043-46cc-9ae7-bdfa5bd8d2be"
  — must match /^[a-z0-9-]+$/
```

The pipeline view is entirely non-functional for any event store that contains a
two-segment (slash-separated) streamId.

#### Reproduction Steps

1. Have an event store containing a slash streamId. The live store
   `~/.claude/workflow-state/exarchos.db` contains: `elicitation/<uuid>` ×10,
   `workflow-state/meai-10-5`, `workflow-state/task-store-high-trio`,
   `workflow/preview-4-substrate-realization`, `invariants/user`.
2. Call `exarchos_view { action: "pipeline" }`.
3. The view iterates every discovered streamId into `ViewMaterializer.materialize`,
   which reaches `SnapshotStore.getSnapshotPath` → `assertSafeId` → throws.

#### Observed Behavior

`success:false`, `VIEW_ERROR`. One poisoned stream record breaks the entire
pipeline listing.

#### Expected Behavior

The pipeline view returns `success:true`, silently excluding streams that cannot be
projected (they are not user-facing workflows).

### CB-2 — rehydrate cold-probe mutates the store (MEDIUM)

```text
exarchos_workflow { action: "rehydrate", featureId: "merge-orchestrator-inv13-inv14-completion" }
→ success:true, data.workflowState.featureId:"", phasePlaybook:null
  …and a phantom seq1 `workflow.rehydrated` event is written to a previously-empty stream.
```

#### Reproduction Steps

1. Call `rehydrate` with a featureId that was never `init`'d (no snapshot, no events).
2. Inspect the stream: it now contains exactly one `workflow.rehydrated` event with
   no `workflow.started`, no `streams` row, and no `workflow_state` row.

#### Observed Behavior

A pure read/probe creates a phantom stream. The empty-but-`success:true` document is
also ambiguous: "tracked but empty" and "never existed" are indistinguishable.

#### Expected Behavior

A cold probe of a non-existent feature is side-effect-free (no event emitted) and
returns an unambiguous existence signal, while preserving the documented
`success:true` cold-probe contract (callers need not wrap in try/catch).

### DOC-1 — dual source-of-truth undocumented (MEDIUM)

An agent running `/exarchos:rehydrate` concluded a branch was "untracked" because no
`~/.claude/workflow-state/*.state.json` file existed for it — using the filesystem as
the sole source of truth. The actual existence authority is the SQLite store
(`workflow_state` / `streams` / `events`); `<id>.state.json` is a secondary
"planner's stamp" that may be absent even for tracked workflows. Neither surface was
documented for agents, and the only discovery fallback (`pipeline`) was broken by CB-1.

## Root Cause

### CB-1 — validator drift (incomplete fix of #1434)

The event-store **write** path validates streamIds leniently; the view **projection**
path validates them strictly. IDs that are legal to write are illegal to project.

- Write side: `src/contract/shared/validation.ts:30` `validateStreamId` — accepts "single
  segment, or two segments separated by a single slash; alphanumeric, hyphens, dots,
  and underscores only".
- Projection side: `src/views/snapshot-store.ts:16` `SAFE_ID_PATTERN = /^[a-z0-9-]+$/`
  — single-segment kebab only.

#1434 patched the symptom at `src/views/materializer.ts:54` with
`isInternalSentinelStream = (id) => id.startsWith('__')`, which only skips
`__migration__`. It did not generalize to the other valid-to-write/invalid-to-project
classes (slash-separated streamIds), so the same crash recurs.

#### Code Location

File: `src/views/materializer.ts` Line: 54 (predicate), 151 + 259 (call sites)
File: `src/views/snapshot-store.ts` Line: 16 (`SAFE_ID_PATTERN`), 18 (`assertSafeId`)
File: `src/contract/shared/validation.ts` Line: 30 (`validateStreamId`)

### CB-2 — unconditional emission on empty stream

`src/workflow/rehydrate.ts:585` emits `workflow.rehydrated` after the projection fold
on every successful hydrate. The handler's documented cold-probe behavior
(`rehydrate.ts:333-341`) intentionally returns `reducer.initial` with `success:true`
for an empty stream — but the emission is not guarded against that case, so a probe of
an empty stream writes seq1 and materializes a phantom stream.

#### Code Location

File: `src/workflow/rehydrate.ts` Line: 585 (emission), 449/459 (snapshot + tailEvents
in scope to compute emptiness)

### DOC-1 — undocumented two-surface model

`<id>.state.json` is a live read/write surface (`src/views/tools.ts:295-303`
"state.json is the planner's stamp"; `src/storage/lifecycle.ts:78`;
`src/workflow/query.ts:53,294`) coexisting with the SQLite event store. No
agent-facing doc states which surface is authoritative for "does this workflow exist".

## Contributing Factors

- [x] Edge case not considered — #1434's fix covered only `__`-prefixed streams; the
      slash-separated classes (`elicitation/*` from MCP elicitation flows, and
      `workflow-state/*` / `workflow/*` from path-vs-id confusion) were not enumerated.
- [x] Missing test coverage — `materializer.sentinel-skip.test.ts` only tests
      `__migration__`, not slash streamIds; no test asserts a cold rehydrate probe is
      side-effect-free.
- [x] Other: two validators (write vs project) with no shared source-of-truth, so
      they drifted; dual state surfaces with no documented authority.

## Fix Approach

### CB-1 — reconcile the validators, generalize the skip

Export a single snapshot-safe predicate from `snapshot-store.ts` and have the
materializer use it. `__migration__` fails `SAFE_ID_PATTERN` (underscores) so the
broadened predicate subsumes #1434. Skip (return `projection.init()` / `false`) any
streamId that is not snapshot-safe, at both `materialize` and `loadFromSnapshot`. This
keeps the kebab-only constraint for snapshot filenames (no path-traversal risk —
#1434 option (b) stays rejected) while guaranteeing the pipeline never crashes.

### CB-2 — guard emission + surface existence

Compute `streamIsEmpty = snapshot === undefined && tailEvents.length === 0`. Skip the
`workflow.rehydrated` emission when empty. Add `_meta.workflowExists = !streamIsEmpty`
to the returned envelope so agents get an unambiguous existence signal without
breaking the `success:true` cold-probe contract.

### DOC-1 — document the model + canonical check

Document the two-surface model and a canonical existence check (use rehydrate
`_meta.workflowExists`, or `workflowState.featureId` non-empty — never filesystem
`.state.json` presence) in the rehydrate command/skill and `CLAUDE.md` Architecture.

### Changes Required

| File | Change |
|------|--------|
| `src/views/snapshot-store.ts` | Export `SAFE_ID_PATTERN` / `isSnapshotSafeId` predicate |
| `src/views/materializer.ts` | Replace `startsWith('__')` with `!isSnapshotSafeId(id)` at both call sites; update comments |
| `src/views/materializer.sentinel-skip.test.ts` | Add slash-class streamId cases (unit + pipeline integration) |
| `src/workflow/rehydrate.ts` | Guard emission on `!streamIsEmpty`; add `_meta.workflowExists` |
| `src/workflow/rehydrate.test.ts` | Add cold-probe-is-side-effect-free + `workflowExists:false` test |
| `skills-src/rehydrate/` + `CLAUDE.md` | Document dual source-of-truth + canonical existence check |
| `~/.claude/workflow-state/exarchos.db` | One-off cleanup of phantom rehydrated-only streams (data, not code) |

### Risks

- Broadening the skip predicate excludes slash streamIds from the pipeline view. These
  are not user workflows (elicitation flows; malformed path-derived ids), so exclusion
  is correct. Low risk.
- Suppressing emission on empty: the only callers asserting emission seed events first
  (non-empty), so existing tests are unaffected. Low risk.
- Always returning `_meta` from rehydrate (previously only when `projectionAsOf` set):
  additive; `envelopeWrap` merges `_meta`. Low risk.

## Prevention

### Immediate Actions

- [ ] Land the validator reconciliation so write-acceptance ⊆ project-acceptance.
- [ ] Add regression tests across ALL non-conforming stream classes (not just `__`).

### Long-term Improvements

- [ ] Single shared streamId/featureId validation module consumed by both write and
      projection paths to prevent future drift.
- [ ] Sweep the store for path-derived featureIds (`workflow-state/*`, `workflow/*`)
      and add a guard so a path is never accepted as a featureId at the tool boundary.

## Timeline

| Event | Date | Notes |
|-------|------|-------|
| Reported | 2026-05-30 | `/exarchos:dogfood` trace during a `/exarchos:rehydrate` session |
| Investigated | 2026-05-30 | Thorough track; root cause confirmed against live store + code |
| Fixed | 2026-05-30 | (pending PR) |
| Verified | 2026-05-30 | (pending) |

## Related

- Issue: regression of CLOSED #1434 ("exarchos_view pipeline crashes on internal `__migration__` stream (validator drift)")
- PR: (pending)
- Related RCAs: N/A
