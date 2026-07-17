# Implementation plan: rehydration machinery refactor (overhaul track)

**Workflow:** `rehydration-machinery-refactor` (refactor / overhaul)
**Date:** 2026-05-08
**Brief:** [`docs/refactors/2026-05-08-rehydration-machinery-brief.md`](../refactors/2026-05-08-rehydration-machinery-brief.md)
**Design-of-record:** [`docs/research/2026-05-08-rehydrate-machinery-reinit.md`](../research/2026-05-08-rehydrate-machinery-reinit.md)

## Plan summary

33 TDD tasks across six phases. Total estimated implementation: ~5,500 LoC of deletions and ~600 LoC of modifications/additions, distributed across ~25 files. Parallelism: P1 and P4 ship in parallel; P2 → P3 sequential against P1; P5 + P6 sequential against P2/P3.

**Phase ordering:** `P1 ∥ P4 → P2 → P3 → P5 → P6`

Each task is RED → GREEN → REFACTOR per Iron Law. Pure deletion tasks (P5) document the deletion-first test (RED = "module no longer imported") and treat absence-of-import as the green-bar.

## Branch topology

Single integration branch `feature/rehydration-machinery-refactor` off `main`. Per-task branches `T-NN-<slug>` merge first-parent into the integration branch. Merges run through `merge_orchestrate` per the merge-pending HSM substate. PR #N opens when all 33 tasks merge.

Per CLAUDE.md "Workflow Dispatch Conventions": dispatch sub-agents from the integration branch, not main. Verify base branch before each wave.

---

## Phase 1 — Schema bump v:2 → v:3

Adds the new envelope shape and the upgrade path. v:2 demoted to read-back-only; writers always emit v:3 going forward. **Five tasks, sequential within phase.** Parallel-safe with P4.

### T-01 — Add `PhasePlaybookSchema` and v:3 envelope

| | |
|---|---|
| **RED** | `schema.test.ts`: `RehydrationDocumentSchema.parse({ v: 3, ..., phasePlaybook: null })` succeeds; `RehydrationDocumentSchema.parse({ v: 3, ..., phasePlaybook: { skill: "delegation", ... } })` succeeds; v:2 documents fail to parse against the new schema (they should route through V2 read-back path instead). |
| **GREEN** | `schema.ts`: declare `PhasePlaybookSchema` mirroring `SerializedPhasePlaybook` from `playbooks.ts`. Rename current `RehydrationDocumentSchema` → `RehydrationDocumentSchemaV2` (read-back only). Define new `RehydrationDocumentSchema` with `v: z.literal(3)` and `phasePlaybook: PhasePlaybookSchema.nullable()` in `VolatileSectionsSchema`. Drop `BehavioralGuidanceSchema` from `StableSectionsSchema`; `StableSectionsSchema` now wraps `workflowState` only. |
| **REFACTOR** | Co-locate `PhasePlaybookSchema` mirroring with `SerializedPhasePlaybookSchema` if a shared zod schema is appropriate. |
| **Files** | `servers/exarchos-mcp/src/projections/rehydration/schema.ts`, `schema.test.ts` |
| **Risk** | Schema strict-mode rejection. Verify `.strict()` on the new schema by attempting to parse with extra keys. |
| **Estimated complexity** | Medium (~120 LoC) |

### T-02 — v:2 → v:3 upgrade migration

| | |
|---|---|
| **RED** | `upgrade.test.ts`: arbitrary v:2 doc with `behavioralGuidance: { skill: "", skillRef: "" }` upgrades to v:3 doc with `behavioralGuidance` absent and `phasePlaybook: null`. Property test: any valid v:2 → upgrade → parse against v:3 = success. |
| **GREEN** | `upgrade.ts`: add `upgradeRehydrationDocumentV2toV3(doc: V2) → V3`. Pure field drop; `phasePlaybook` is recomputed at handler time. |
| **REFACTOR** | Mirror the existing v:1 → v:2 chain shape and naming so future v:N → v:N+1 migrations follow a uniform pattern. |
| **Files** | `servers/exarchos-mcp/src/projections/rehydration/upgrade.ts`, `upgrade.test.ts` |
| **Risk** | None significant — strictly additive code. |
| **Estimated complexity** | Low (~50 LoC) |

### T-03 — `loadRehydrationDocument` routes v:2 → upgrade → v:3

| | |
|---|---|
| **RED** | `serialize.test.ts`: integration — load a v:2 snapshot from disk, get back a v:3 document with `behavioralGuidance` absent. v:1 → v:2 → v:3 chain still works (chained upgrade). v:3 native pass-through. Invalid envelopes still raise `InvalidEnvelopeError`. |
| **GREEN** | `serialize.ts`: extend `loadRehydrationDocument` envelope-routing to detect `v: 2` and apply `upgradeRehydrationDocumentV2toV3`. Update the union schema for envelope detection. |
| **REFACTOR** | Extract version-routing as a small switch table to avoid nested if/else chains. |
| **Files** | `servers/exarchos-mcp/src/projections/rehydration/serialize.ts`, `serialize.test.ts` |
| **Risk** | Chain of upgrades (v:1 → v:2 → v:3) must produce identical output to (v:2 → v:3) when starting from a v:2 source. Property-test the chain. |
| **Estimated complexity** | Low (~40 LoC) |

### T-04 — Reducer initial drops `behavioralGuidance`

| | |
|---|---|
| **RED** | `reducer.test.ts`: `rehydrationReducer.initial.behavioralGuidance` is `undefined`. `RehydrationDocumentSchema.parse(rehydrationReducer.initial)` succeeds (v:3 conformant). |
| **GREEN** | `reducer.ts`: update `initialRehydrationDocument` literal to drop `behavioralGuidance`. The schema parse at module load enforces v:3 shape. |
| **REFACTOR** | None — single-line field removal. |
| **Files** | `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`, `reducer.test.ts` |
| **Risk** | Tests asserting empty-default `behavioralGuidance: { skill: "", skillRef: "" }` will fail. Audit and migrate. |
| **Estimated complexity** | Low (~10 LoC + test updates) |

### T-05 — `STABLE_KEYS` and cache-prefix logic reflect v:3

| | |
|---|---|
| **RED** | `serialize.test.ts`: `STABLE_KEYS` includes `workflowState` but not `behavioralGuidance`. Cache-prefix serialization for v:3 docs is deterministic per `(workflowType, phase)` even before `phasePlaybook` is composed (composition happens at envelope-wrap, not snapshot time). |
| **GREEN** | `serialize.ts`: derive `STABLE_KEYS` from updated `StableSectionsSchema.shape`. Update any cache-hint helpers. |
| **REFACTOR** | Confirm `applyCacheHints` still produces stable prefixes; document the field-order discipline if not already. |
| **Files** | `servers/exarchos-mcp/src/projections/rehydration/serialize.ts`, `serialize.test.ts`, `format.ts` if cache-hint helpers live there |
| **Risk** | Cache prefix invalidation is a one-time cost, not a regression. Document in CHANGELOG. |
| **Estimated complexity** | Low (~20 LoC) |

---

## Phase 4 — Event emissions (parallel-safe with Phase 1)

Two new event-stream signals for v2.12 lifecycle alignment. **Four tasks, parallel-safe with P1.**

### T-10 — Extend `WorkflowRehydratedData` schema additively

| | |
|---|---|
| **RED** | `event-store/schemas.test.ts`: legacy `workflow.rehydrated` events (without new fields) parse successfully (optional fields). New events with `phaseHasPlaybook: true, phasePlaybookComposed: true` also parse. |
| **GREEN** | `event-store/schemas.ts`: extend `WorkflowRehydratedDataSchema` with `phaseHasPlaybook?: boolean` and `phasePlaybookComposed?: boolean`. Optional, additive — no version bump on the event schema. |
| **REFACTOR** | None. |
| **Files** | `servers/exarchos-mcp/src/event-store/schemas.ts`, `event-store/schemas.test.ts` |
| **Risk** | None — strictly additive. |
| **Estimated complexity** | Low (~15 LoC) |

### T-11 — Register `session.machinery_consumed` event type

| | |
|---|---|
| **RED** | `event-store/schemas.test.ts`: `EVENT_EMISSION_REGISTRY['session.machinery_consumed'] === 'auto'`. Schema parse for valid payload `{ rehydrateSequence: 0, firstActionVerb: "...", firstActionAt: "...iso..." }` succeeds. |
| **GREEN** | `event-store/schemas.ts`: register the new event type in `EVENT_EMISSION_REGISTRY` with `source: 'auto'`. Add `SessionMachineryConsumedDataSchema`. |
| **REFACTOR** | None. |
| **Files** | `servers/exarchos-mcp/src/event-store/schemas.ts`, `event-store/schemas.test.ts` |
| **Risk** | Event type naming convention must match the existing `<surface>.<verb>` style. Confirmed: `session.machinery_consumed` matches `merge.executed` / `task.completed` patterns. |
| **Estimated complexity** | Low (~25 LoC) |

### T-12 — Dispatch-core interceptor emits `session.machinery_consumed`

| | |
|---|---|
| **RED** | `core/dispatch.test.ts`: after a `workflow.rehydrated` event lands on stream X, the next non-rehydrate L5 handler invocation against stream X causes one `session.machinery_consumed` event emission with `rehydrateSequence` matching the rehydrated event's sequence. Subsequent invocations produce no further emissions until another `workflow.rehydrated` lands. |
| **GREEN** | `core/dispatch.ts`: add interceptor that, before handler execution, queries the latest `workflow.rehydrated` event on the stream, checks for any `session.machinery_consumed` since, and emits if absent. Short-circuit on event types `workflow.rehydrated` and `session.machinery_consumed` to avoid loop. |
| **REFACTOR** | Extract the "last-rehydrate / has-machinery-event" lookup into a helper if used by other interceptors. |
| **Files** | `servers/exarchos-mcp/src/core/dispatch.ts`, `core/dispatch.test.ts`. Possibly a new `core/interceptors/session-machinery.ts`. |
| **Risk** | Interceptor must be cheap (one stream tail query per dispatch). Consider caching the "last machinery_consumed sequence" per stream in process-local memory to avoid repeated tail queries. Verify it doesn't break the parity harness (CLI and MCP both intercept identically). |
| **Estimated complexity** | Medium (~80 LoC) |

### T-13 — Idempotency property: one emission per rehydrate-sequence

| | |
|---|---|
| **RED** | `core/dispatch.test.ts`: two rehydrates separated by activity produce two `session.machinery_consumed` events with distinct `rehydrateSequence` values. Multiple activity calls between rehydrates produce only one machinery_consumed per rehydrate. |
| **GREEN** | Refine T-12 logic: emission keyed by `rehydrateSequence`; `idempotencyKey = "session.machinery_consumed:${stream}:${rehydrateSequence}"`. |
| **REFACTOR** | Promote idempotency-key construction to a shared helper. |
| **Files** | same as T-12 |
| **Risk** | Idempotency-key semantics must align with the event-store's `UNIQUE INDEX (idempotency_key)` collapse behavior (RT-5). |
| **Estimated complexity** | Low (~20 LoC) |

---

## Phase 2 — Handler composition (depends on P1)

Both `handleRehydrate` and `handleCheckpoint` compose `phasePlaybook` from the L4 playbook registry. **Five tasks, sequential within phase.**

### T-20 — `handleRehydrate` composes `phasePlaybook`

| | |
|---|---|
| **RED** | `workflow/rehydrate.test.ts`: rehydrating a delegate-phase feature workflow returns envelope with `phasePlaybook.skill === "delegation"` and `phasePlaybook.events` non-empty. Rehydrating a terminal-phase workflow returns `phasePlaybook: null`. |
| **GREEN** | `workflow/rehydrate.ts`: after fold completes, before `workflow.rehydrated` emission, call `getPlaybook(document.workflowState.workflowType, document.workflowState.phase)`. If present, serialize via `serializePhasePlaybookEntry(playbook)` and attach as `document.phasePlaybook`. If absent, attach `null`. |
| **REFACTOR** | Extract `composePhasePlaybook(workflowType, phase): SerializedPhasePlaybook | null` helper into `workflow/playbooks.ts`. |
| **Files** | `servers/exarchos-mcp/src/workflow/rehydrate.ts`, `workflow/rehydrate.test.ts`, `workflow/playbooks.ts` |
| **Risk** | None — pure additive composition; existing degraded paths unchanged. |
| **Estimated complexity** | Medium (~60 LoC) |

### T-21 — `handleRehydrate` emits extended `workflow.rehydrated` fields

| | |
|---|---|
| **RED** | `workflow/rehydrate.test.ts`: emitted `workflow.rehydrated` event includes `phaseHasPlaybook` and `phasePlaybookComposed` matching the envelope's `phasePlaybook !== null`. |
| **GREEN** | `workflow/rehydrate.ts`: extend the `WorkflowRehydrated` data construction to include the two new fields. |
| **REFACTOR** | None. |
| **Files** | `servers/exarchos-mcp/src/workflow/rehydrate.ts`, `workflow/rehydrate.test.ts` |
| **Risk** | None. |
| **Estimated complexity** | Low (~15 LoC) |

### T-22 — Degraded paths preserve `phasePlaybook: null` contract

| | |
|---|---|
| **RED** | `workflow/rehydrate.test.ts`: each of `reducer-throw`, `snapshot-corrupt`, `event-stream-unavailable` degraded paths returns envelope with `phasePlaybook: null` (the schema-default). The shape of the rest of the degraded envelope is unchanged. |
| **GREEN** | `buildDegradedResponse` and `minimalFromStateStore` already build documents from `rehydrationReducer.initial`, which after T-04 has no `behavioralGuidance`. Confirm `phasePlaybook` is `null` (or omitted-as-null) on the degraded shape. |
| **REFACTOR** | None — should be no-op after T-01..T-04 land. |
| **Files** | `servers/exarchos-mcp/src/workflow/rehydrate.ts`, `workflow/rehydrate.test.ts` |
| **Risk** | A degraded path that accidentally constructs a non-null phasePlaybook would violate the "events as authoritative" contract on degradation. Test pins this. |
| **Estimated complexity** | Low (~10 LoC of test) |

### T-23 — `handleCheckpoint` composes `phasePlaybook`

| | |
|---|---|
| **RED** | `workflow/tools.test.ts` (or co-located checkpoint tests): checkpointing a delegate-phase workflow returns envelope with `phasePlaybook.skill === "delegation"`. Terminal-phase checkpoint returns `phasePlaybook: null`. |
| **GREEN** | `workflow/tools.ts` `handleCheckpoint`: after the `workflow.checkpoint` event lands, before envelope return, compose `phasePlaybook` via `composePhasePlaybook(workflowType, phase)`. |
| **REFACTOR** | None — uses the helper from T-20 REFACTOR step. |
| **Files** | `servers/exarchos-mcp/src/workflow/tools.ts`, `workflow/tools.test.ts` |
| **Risk** | The checkpoint envelope is consumed by the slash command for the post-checkpoint summary. Verify renderer handles the field. |
| **Estimated complexity** | Low (~30 LoC) |

### T-24 — Parity harness fixture for v:3 rehydrate envelopes

| | |
|---|---|
| **RED** | `workflow/parity.test.ts`: CLI and MCP carriers produce byte-equivalent envelopes for `rehydrate(featureId)` against a delegate-phase fixture. The byte-equivalence assertion includes the `phasePlaybook` field. |
| **GREEN** | Add fixture to the parity harness. The fixture mirrors `__tests__/parity-harness.ts` shape conventions. |
| **REFACTOR** | None. |
| **Files** | `servers/exarchos-mcp/src/workflow/parity.test.ts`, `__tests__/parity-harness.ts` if the helper layer needs extension |
| **Risk** | INV-2 critical — if CLI and MCP diverge on phasePlaybook composition, parity fails. |
| **Estimated complexity** | Low (~30 LoC) |

---

## Phase 3 — Renderer rewrites (depends on P2)

Two slash commands rewritten with the House Rules block. **Three tasks.**

### T-30 — `commands/rehydrate.md` House Rules block

| | |
|---|---|
| **RED** | New test `commands-rehydrate-validation.test.ts` (or extension of existing): rendered output for a delegate-phase workflow contains the literal strings `### House Rules`, `task.progressed`, `exarchos_event`, `(none — phase machinery satisfied)` for absent missing-events case, and the discipline-reminder sentence verbatim. Phase-with-no-playbook renders `(no playbook for this phase)` rather than empty headers. |
| **GREEN** | `commands/rehydrate.md`: rewrite the Output Format per the brief's section 5.4 sketch. Key sections: `### House Rules` (skill / tools / events / auto-emitted / transition / validation scripts), `### Event Emission Hints` (always-on `_eventHints.missing` rendering), trailing discipline reminder. |
| **REFACTOR** | Cross-runtime variant rendering — `npm run build:skills` regenerates `skills/<runtime>/...` from `skills-src/*` and `commands/*`. Verify `npm run skills:guard` passes. |
| **Files** | `commands/rehydrate.md`, validation test (new or extended) |
| **Risk** | The validation test is currently the only mechanical guard against renderer drift. Make assertions specific to verbatim strings the agent depends on. |
| **Estimated complexity** | Medium (~80 LoC of template + 50 LoC of test) |

### T-31 — `commands/checkpoint.md` House Rules block

| | |
|---|---|
| **RED** | Validation test: rendered checkpoint output contains the same `### House Rules` block when phase has a registered playbook. The summary section ("Checkpoint Saved", task counts) is preserved. |
| **GREEN** | `commands/checkpoint.md`: append the House Rules block to the existing template. The agent producing the checkpoint sees the contract it was operating under before context clears — correctness signal symmetry with rehydrate. |
| **REFACTOR** | If the House Rules block is identical between rehydrate.md and checkpoint.md, consider a shared snippet — but the slash-command system does not have a snippet primitive today, so duplicate text is acceptable for now. |
| **Files** | `commands/checkpoint.md`, validation test |
| **Risk** | Same as T-30. |
| **Estimated complexity** | Low (~30 LoC of template + 30 LoC of test) |

### T-32 — Regenerate `skills/<runtime>/...` from `skills-src/*` and `commands/*`

| | |
|---|---|
| **RED** | `npm run skills:guard` fails before T-30/T-31 are run. After regeneration, it passes. |
| **GREEN** | Run `npm run build:skills`. Commit regenerated tree. |
| **REFACTOR** | None — pure build artifact regeneration. |
| **Files** | `skills/claude/rehydrate.md`, `skills/codex/...`, all six runtime variants if rehydrate is rendered there. Same for checkpoint. |
| **Risk** | Forgotten regeneration would fail CI. Confirmed via `skills:guard`. |
| **Estimated complexity** | Trivial (single npm command + commit) |

---

## Phase 5 — Hook + side-channel removal (depends on P2 + P3)

Removes the SessionStart and PreCompact hook chain. **Ten tasks, mostly pure deletions.**

### T-40 — Drop `SessionStart` and `PreCompact` from `hooks/hooks.json`

| | |
|---|---|
| **RED** | `src/plugin-validation.test.ts`: hooks.json declares exactly six hooks (`PreToolUse`, `TaskCompleted`, `TeammateIdle`, `SubagentStart`, `SubagentStop`, `SessionEnd`); does not declare `SessionStart` or `PreCompact`. |
| **GREEN** | Delete the two entries from `hooks/hooks.json`. |
| **REFACTOR** | None. |
| **Files** | `hooks/hooks.json`, `src/plugin-validation.test.ts` |
| **Risk** | Plugin manifest validation must pass with six hooks. |
| **Estimated complexity** | Trivial |

### T-41 — Drop `pre-compact` and `session-start` from `adapters/hooks.ts`

| | |
|---|---|
| **RED** | `adapters/hooks.test.ts`: `isHookCommand("pre-compact") === false`, `isHookCommand("session-start") === false`. The other six hook commands still return `true`. Calling `handleHookCommand("pre-compact", ...)` returns `{ handled: false }`. |
| **GREEN** | Remove `pre-compact` and `session-start` from `HOOK_COMMANDS` set. Remove their dispatch branches in `handleHookCommand`. |
| **REFACTOR** | If the dispatch branches share helpers with the remaining six, audit for orphans. |
| **Files** | `servers/exarchos-mcp/src/adapters/hooks.ts`, `adapters/hooks.test.ts` |
| **Risk** | The interceptor must not regress for the remaining six hooks. |
| **Estimated complexity** | Low (~30 LoC delete + test updates) |

### T-42 — Delete `cli-commands/session-start.ts` and tests

| | |
|---|---|
| **RED** | `git grep "from.*session-start"` returns zero results in non-deleted files. Typecheck passes. Test suite passes (no tests depend on these symbols). |
| **GREEN** | `rm servers/exarchos-mcp/src/cli-commands/session-start.ts servers/exarchos-mcp/src/cli-commands/session-start.test.ts`. |
| **REFACTOR** | None. |
| **Files** | Two files deleted (~2391 LoC). |
| **Risk** | Other callers — audit `version.ts`, `index.ts`, telemetry/hints — already inventoried in the brief. T-41 (hooks dispatch removal) is the only consumer; remaining references are documentation prose, addressed in P6. |
| **Estimated complexity** | Trivial |

### T-43 — Delete `cli-commands/pre-compact.ts` and tests

| | |
|---|---|
| **RED** | `git grep "from.*pre-compact"` returns zero in non-deleted files. Typecheck + test green. |
| **GREEN** | `rm servers/exarchos-mcp/src/cli-commands/pre-compact.ts servers/exarchos-mcp/src/cli-commands/pre-compact.test.ts`. |
| **REFACTOR** | None. |
| **Files** | Two files deleted (~634 LoC). |
| **Risk** | None — pre-compact has no callers besides the hook adapter. |
| **Estimated complexity** | Trivial |

### T-44 — Delete `cli-commands/assemble-context.ts` and tests

| | |
|---|---|
| **RED** | `git grep "from.*assemble-context"` returns zero in non-deleted files. Typecheck + test green. |
| **GREEN** | `rm servers/exarchos-mcp/src/cli-commands/assemble-context.ts assemble-context.test.ts assemble-context.integration.test.ts`. |
| **REFACTOR** | None. |
| **Files** | Three files deleted (~1553 LoC). |
| **Risk** | assemble-context's only callers were pre-compact + session-start, both removed in T-42/T-43. Verify via grep before deletion. |
| **Estimated complexity** | Trivial |

### T-45 — Delete `cli-commands/context-reload.integration.test.ts`

| | |
|---|---|
| **RED** | Test file is the *only* test for the reload-via-hook flow; without the hook, the test scenario is meaningless. |
| **GREEN** | `rm servers/exarchos-mcp/src/cli-commands/context-reload.integration.test.ts`. |
| **REFACTOR** | None. |
| **Files** | One file deleted (~301 LoC). |
| **Risk** | None — pure scenario test for a deleted flow. |
| **Estimated complexity** | Trivial |

### T-46 — Delete `commands/reload.md` and rendered variants

| | |
|---|---|
| **RED** | `npm run skills:guard` after deletion produces no diff (rendered variants regenerated). |
| **GREEN** | `rm commands/reload.md`. Run `npm run build:skills` to regenerate; commit the resulting tree (which removes any `skills/<runtime>/reload/` outputs). |
| **REFACTOR** | None. |
| **Files** | One source + rendered variants. |
| **Risk** | None. |
| **Estimated complexity** | Trivial |

### T-47 — Delete `hooks/session-start.sh`

| | |
|---|---|
| **RED** | `git grep "session-start.sh"` returns zero (besides hooks.json entry, removed in T-40). |
| **GREEN** | `rm hooks/session-start.sh`. |
| **REFACTOR** | None. |
| **Files** | One file deleted. |
| **Risk** | None. |
| **Estimated complexity** | Trivial |

### T-48 — Clean `cli-commands/version.ts`

| | |
|---|---|
| **RED** | Typecheck passes after deletion of imports. `version.ts` no longer references `session-start` or `pre-compact`. |
| **GREEN** | Remove any remaining references in version banner / module list. |
| **REFACTOR** | None. |
| **Files** | `servers/exarchos-mcp/src/cli-commands/version.ts` |
| **Risk** | None. |
| **Estimated complexity** | Trivial |

### T-49 — Clean `scripts/build-binary.ts`

| | |
|---|---|
| **RED** | Build succeeds (`npm run build`). The bundle no longer contains `session-start.ts` or `pre-compact.ts` symbols. |
| **GREEN** | Remove deleted modules from the bundler entry list. |
| **REFACTOR** | None. |
| **Files** | `scripts/build-binary.ts` |
| **Risk** | Build artifact size should shrink; verify no stale imports remain. |
| **Estimated complexity** | Trivial |

---

## Phase 6 — Vestigial cleanup (depends on all above)

Final cleanup of orphaned schemas, helpers, and documentation. **Six tasks.**

### T-50 — Remove `BehavioralGuidanceSchema` from `schema.ts`

| | |
|---|---|
| **RED** | `git grep "BehavioralGuidanceSchema"` returns zero results in non-test files (T-50 deletes the export; tests should already be migrated by T-04). |
| **GREEN** | Delete the export from `schema.ts`. |
| **REFACTOR** | None. |
| **Files** | `servers/exarchos-mcp/src/projections/rehydration/schema.ts` |
| **Risk** | Imports in `serialize.ts` (we saw `BehavioralGuidanceSchema` imported there) — audit and remove. |
| **Estimated complexity** | Trivial |

### T-51 — Update `prose-lint.ts` lint targets

| | |
|---|---|
| **RED** | `prose-lint.test.ts`: lint runs against `phasePlaybook.compactGuidance` (the new prose surface) instead of `behavioralGuidance.skill`. |
| **GREEN** | `prose-lint.ts`: update the lint walker to traverse `phasePlaybook` rather than `behavioralGuidance`. The lint rules themselves are unchanged. |
| **REFACTOR** | None. |
| **Files** | `servers/exarchos-mcp/src/projections/rehydration/prose-lint.ts`, `prose-lint.test.ts` |
| **Risk** | If lint rules ran over `behavioralGuidance` empty strings (no-op today), nothing changes operationally. If they ran over the prose-rendered playbook (via the CLI side-channel), the new path uses the structured `compactGuidance` field. |
| **Estimated complexity** | Low (~40 LoC) |

### T-52 — `skills-src/*` documentation cleanup

| | |
|---|---|
| **RED** | `git grep -i "SessionStart\|PreCompact\|/exarchos:reload" skills-src/` returns zero results. |
| **GREEN** | Edit each affected file: `skills-src/workflow-state/SKILL.md`, `references/mcp-tool-reference.md`, `skills-src/debug/SKILL.md`, `skills-src/delegation/references/troubleshooting.md`, `skills-src/delegation/references/agent-teams-saga.md`, `skills-src/synthesis/references/troubleshooting.md`. Replace SessionStart-flow descriptions with explicit-verb-flow descriptions. |
| **REFACTOR** | None. |
| **Files** | Six skill source files. |
| **Risk** | Skill source-of-truth must stay aligned per CLAUDE.md "Skills source-of-truth" rule. |
| **Estimated complexity** | Medium (~100 LoC of doc edits across files) |

### T-53 — Regenerate `skills/<runtime>/...` and verify `skills:guard`

| | |
|---|---|
| **RED** | `npm run skills:guard` shows diff before regeneration; passes after. |
| **GREEN** | `npm run build:skills`. Commit the regenerated tree. |
| **REFACTOR** | None. |
| **Files** | All six runtime variants under `skills/`. |
| **Risk** | None — purely mechanical. |
| **Estimated complexity** | Trivial |

### T-54 — `CHANGELOG.md` entry

| | |
|---|---|
| **RED** | Manual review: CHANGELOG entry exists, calls out (a) two-verb resume model, (b) hook removal, (c) schema v:2 → v:3 bump, (d) on-disk side-channel files orphaned, (e) explicit `/exarchos:rehydrate` is the new resume path. |
| **GREEN** | Write the changelog block under the next minor-version heading. |
| **REFACTOR** | None. |
| **Files** | `CHANGELOG.md` |
| **Risk** | Breaking-change framing must be clear so users notice the auto-resume removal. |
| **Estimated complexity** | Low |

### T-55 — Version bump and final integration

| | |
|---|---|
| **RED** | All prior tasks merged; `npm run typecheck && npm run test:run && npm run skills:guard` all green. |
| **GREEN** | Bump `manifest.json` and `.claude-plugin/plugin.json` minor version. Open PR off the integration branch. |
| **REFACTOR** | None. |
| **Files** | `manifest.json`, `.claude-plugin/plugin.json` |
| **Risk** | None at this gate; this is the synthesize-phase entry. |
| **Estimated complexity** | Trivial |

---

## Task dependency graph

```
P1: T-01 → T-02 → T-03 → T-04 → T-05
P4: T-10 → T-11 → T-12 → T-13          (parallel with P1)
                                     ↓
                                     ↓ P1 + P4 complete
                                     ↓
P2: T-20 → T-21 → T-22 → T-23 → T-24
                                     ↓
                                     ↓ P2 complete
                                     ↓
P3: T-30 → T-31 → T-32
                                     ↓
                                     ↓ P3 complete
                                     ↓
P5: T-40 → T-41 → T-42 → T-43 → T-44 → T-45 → T-46 → T-47 → T-48 → T-49
                                     ↓
                                     ↓ P5 complete
                                     ↓
P6: T-50 → T-51 → T-52 → T-53 → T-54 → T-55
```

Within P5, T-42..T-49 are pure deletions and parallelizable (each agent gets its own worktree off the same integration branch); they only need T-40 + T-41 to complete first (the manifests have to release the consumers before the source files vanish).

## Parallel dispatch waves

Wave-1 (5 agents, parallel): T-01, T-02, T-03, T-04, T-05 (P1 sequential within phase, but each task is self-contained for a single agent)

Actually, P1 is sequential because each task depends on the prior schema state. Reframe:

**Wave-1 (parallel):** T-10, T-11 (P4 schema additions, file-disjoint with P1)
**Wave-2 (sequential P1 chain):** T-01 → T-02 → T-03 → T-04 → T-05
**Wave-3 (sequential P4 chain):** T-12 → T-13 (after T-10/T-11)
**Wave-4 (sequential P2):** T-20 → T-21 → T-22 → T-23 → T-24 (after Wave-2)
**Wave-5 (sequential P3):** T-30 → T-31 → T-32 (after Wave-4)
**Wave-6 (parallel P5):** T-40, T-41 first (sequential, ~5 LoC each); then T-42..T-49 parallel (8 agents, pure deletions)
**Wave-7 (sequential P6):** T-50 → T-51 → T-52 → T-53 → T-54 → T-55

## Acceptance gates (per-phase)

| Phase | Gate | Verifier |
|---|---|---|
| P1 | All v:2 snapshots upgrade cleanly to v:3; envelope schema v:3 is round-trippable | `schema.test.ts`, `upgrade.test.ts`, `serialize.test.ts` |
| P4 | New event types parse; interceptor emits exactly-once per rehydrate | `event-store/schemas.test.ts`, `core/dispatch.test.ts` |
| P2 | Both rehydrate and checkpoint envelopes carry phasePlaybook for delegate-phase fixtures; degraded paths preserve null | `workflow/rehydrate.test.ts`, `workflow/tools.test.ts`, `workflow/parity.test.ts` |
| P3 | Rendered slash-command outputs contain House Rules section verbatim; `skills:guard` passes | `commands-rehydrate-validation.test.ts`, `npm run skills:guard` |
| P5 | hooks.json declares six hooks; HOOK_COMMANDS set has six entries; deleted modules absent from typecheck | `src/plugin-validation.test.ts`, `adapters/hooks.test.ts`, `npm run typecheck` |
| P6 | No remaining references to `behavioralGuidance` / `SessionStart` / `PreCompact` in non-test code; CHANGELOG present | `git grep`, manual CHANGELOG review |

## Synthesize phase entry criteria

After T-55:

- All 33 tasks merged to `feature/rehydration-machinery-refactor`
- `npm run typecheck && npm run test:run && npm run skills:guard && npm run build` all green
- Parity test green for v:3 rehydrate envelopes
- Stack ready for PR opening per [synthesize phase playbook](../../servers/exarchos-mcp/src/workflow/playbooks.ts)

## Stop point

Workflow halts at `overhaul-plan-review` (human checkpoint) for user review and approval before delegation begins. To advance:

```
exarchos_workflow transition featureId=rehydration-machinery-refactor target=overhaul-delegate
```

Or revise this plan and re-enter `overhaul-plan` for adjustments.
