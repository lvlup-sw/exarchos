---
title: v2.10.0-preview.1 — Substrate Stabilization
date: 2026-05-09
milestone: v2.10.0 — Agent Output Contract
release-tag: 2.10.0-preview.1
anchor-issue: 1303
bundle:
  - 1303  # merge-orchestrate idempotency wiring
  - 1325  # canonical buildValidatedEvent across workflow/
  - 1333  # AgentSpec.capabilities runtime cleanup
  - 1334  # prune-stale-workflows typed-contract scorer
  - 1335  # storage/lifecycle + subagent-context comment+verify
  - 1336  # LoadTopologyOptions vestigial `emit` field
  - 1324  # bun:sqlite ESM CI failures (cut-if-bloating)
preview-roadmap:
  - preview.1: this doc — substrate stabilization (Approach A)
  - preview.2: Marten R-1 + R-2 — anchor #1312
  - preview.3: Agent Output Contract carrier swap — anchor #1287
parent-prs:
  - 1323  # SQLite source-of-truth substrate
  - 1331  # rehydration machinery — two-verb resume + v:3 envelope
  - 1332  # v2.11 substrate cut — JSONL rip + DR-4/6/7 hard-cuts
---

# v2.10.0-preview.1 — Substrate Stabilization

## Problem

Three large foundation PRs landed back-to-back: #1323 made SQLite the source of truth; #1331 rewrote rehydration as a two-verb explicit-handoff model and bumped manifests to v2.10.0; #1332 ripped the JSONL substrate and removed three deprecation shims (DR-4 `set({phase})` rerouting, DR-6 legacy `capabilities[]`, DR-7 single-signal pruner heuristic).

The substrate is in place. What's missing is the consequential-consumer wiring and the post-cut cleanup. Two specific gaps drive this preview:

1. **`merge-orchestrate` doesn't actually use the new substrate guarantees.** SQLite enforces `UNIQUE INDEX (idempotency_key)` and `PRIMARY KEY (stream_id, sequence)`, but `merge-orchestrate.ts:410`, `execute-merge.ts:306`, and `:321` still call `eventStore.append` without `idempotencyKey` or `expectedSequence`. The most consequential write path in the system is silently bypassing the correctness guarantees the substrate added (issue #1303 acceptance §S-1 §S-2).
2. **Eighteen workflow-handler sites bypass the canonical `buildValidatedEvent` + `appendValidated` path** (#1325). Envelope validation (`correlationId`, `source`, `schemaVersion`) and per-event-type data schemas are inconsistently enforced.

Plus four post-#1332 follow-ups that #1332 itself flagged out-of-scope, and one CI-infra item (#1324) carried as nice-to-have.

This is a stabilization-shaped preview. It introduces no new agent surface, no schema migration, no behavioral changes operators will notice — except that race conditions and crash-replay scenarios stop producing duplicate events on the merge path.

## Scope

Seven issues, anchored at #1303. Order is by leverage (highest first) and by blast-radius (smallest at the back):

| # | Issue | Touchpoint | Shape |
|---|---|---|---|
| 1 | **#1303** | `verbs/merge/merge-orchestrate.ts:410`, `verbs/pure/execute-merge.ts:306,321` | Wire `idempotencyKey` + `expectedSequence` on three append sites; reuse prefix builder from `next-actions-computer.ts:118` |
| 2 | #1325 | 18 sites across `workflow/{cancel,hsm-transition-guard,rehydrate,tools}.ts` | Migrate `eventStore.append(…)` → `buildValidatedEvent` + `appendValidated` |
| 3 | #1333 | `agents/types.ts:42`, `agents/definitions.ts` (4+ literals), `capabilities/resolver.ts`, `agents/adapters/{codex,cursor,opencode,copilot,claude}.ts` | Drop `capabilities: readonly Capability[]` from `AgentSpec` runtime interface; derive from `posture` via existing resolver; remove array literals from definitions |
| 4 | #1334 | `verbs/team/prune-stale-workflows.ts:222–249`, `topology/phase-contract.ts` | Migrate the multi-signal heuristic to typed-contract scorer (Option B from issue body — thread `Topology` through handler) |
| 5 | #1335 | `storage/lifecycle.ts`, `cli-commands/subagent-context.ts` | Comment-scrub stale "Pre-v2.11" prose; grep-verify no live JSONL reader paths remain |
| 6 | #1336 | `topology/loader.ts:LoadTopologyOptions` | Drop vestigial `emit?:` field from options shape (no `TopologyEventEmitter` class exists despite #1332 punt-list naming) |
| 7 | #1324 | `event-store/cli-concurrency.test.ts`, `__tests__/integration/doctor-workflow.test.ts` (×2) | Refactor 3 subprocess-spawning tests to in-process `EventStore` (Option 1 from issue body); remove `it.skip` markers added in #1323 |

**Sizing reality check:** items 5 and 6 are smaller than #1332's punt-list framing suggested — recon (`rg TopologyEventEmitter` returns no matches; lifecycle.ts JSONL mentions are doc-comments only) shows they're prose-and-options-field cleanups, not code rips. They stay in scope because they close the punt-list honestly; they don't drive sequencing.

## Non-goals

- **No schema migration.** Preview.2 carries V3→V4 (R-1 `workflow_type` column). Preview.1 stays on the V3 schema #1323 introduced.
- **No new event types.** The existing `merge.preflight | merge.executed | merge.recovered` set is preserved; #1303 changes how they're appended, not what's appended.
- **No agent-surface changes.** No new MCP actions, no `outputSchema` work, no `next_actions` shape edits — that's preview.3.
- **No deprecation-shim removal.** #1332 removed three shims; preview.1 removes none. The `_meta.deprecation` envelope slot stays in place per #1332's CHANGELOG promise.
- **No `additionalCapabilities` escape hatch on `AgentSpec`.** #1333's issue body offers two options; the design picks **Option 1** (extend posture-derived capability set). If long-tail capabilities surface during implementation that posture can't cover, they go to a follow-up issue rather than expanding preview.1's scope mid-flight.

## Approach per item

### #1303 — merge-orchestrate idempotency wiring (the headline)

Each append site rewrites to:

```ts
const idempotencyKey = `${args.featureId}:merge_orchestrate:${args.taskId}:merge.executed`;
const expectedSequence = await ctx.eventStore.getStreamTailSequence(args.featureId);
await ctx.eventStore.appendValidated(
  args.featureId,
  buildValidatedEvent(args.featureId, expectedSequence, { type: 'merge.executed', data: {…} }),
  { idempotencyKey, expectedSequence },
);
```

Acceptance: integration test in `merge-orchestrate.integration.test.ts` simulates crash-after-append-before-state-write, then `resume: true`; asserts exactly one `merge.executed` event in the stream. Race test extension in `store.race.test.ts` covers two concurrent `merge_orchestrate` invocations on the same stream.

Reuse the prefix builder from `next-actions-computer.ts:118` rather than duplicating — `${streamId}:merge_orchestrate:${taskId}:${eventType}` is the existing convention.

### #1325 — canonical event emission (the wide-but-shallow item)

Eighteen sites, mechanically transformed. Per-site review confirms each call's correlation context (some sites have `correlationId` already; some need it threaded). Property-test-style assertion: every event in the timeline after this PR has a non-empty `correlationId` and a registered `source`.

**Open question for implementation:** if any site has correlation context that doesn't fit `buildValidatedEvent`'s shape, file as a sub-issue and skip in preview.1. Don't widen the helper to accommodate a single caller.

### #1333 — `AgentSpec.capabilities` runtime cleanup (Option 1)

`AgentSpec` interface drops `capabilities: readonly Capability[]`. The resolver in `capabilities/resolver.ts` becomes the single source of truth: `(posture, agentId) → Capability[]`. The five adapters (`codex/cursor/opencode/copilot/claude`) call `resolveCapabilities(spec.posture, spec.id)` instead of reading `spec.capabilities`.

Posture-mapping in `posture-mapping.ts` extends to cover the long-tail capabilities currently in `definitions.ts` literals (`mcp:exarchos`, `session:resume`, `tool:Read`, etc.). The mapping is the test artifact: `posture-mapping.test.ts` becomes the spec of which capabilities each posture implies.

If the long tail doesn't fit posture cleanly during implementation, abort to Option 2 (`additionalCapabilities?: Capability[]` escape hatch) and downscope by deferring the offending agents — don't ship a half-converted resolver.

### #1334 — prune-stale-workflows typed-contract migration (Option B)

`selectPruneCandidates` accepts `topology: Topology`. Per-phase `staleness` blocks in `topology.yaml` declare the policy. The handler's multi-signal heuristic at `prune-stale-workflows.ts:222–249` deletes; `scoreEntryThroughTopology` from `pruner/score.ts` resolves the per-phase contract.

CLI fast-exit paths that today run without a topology need topology fixtures or a documented "no-topology = skip pruning" branch. Decide during implementation; bias toward fixtures.

### #1335 + #1336 — post-#1332 cleanups

Mechanical. Code review converts to a grep-verify checklist:

- `rg -n 'jsonl|JSONL' servers/exarchos-mcp/src/storage/lifecycle.ts servers/exarchos-mcp/src/cli-commands/subagent-context.ts` → returns no matches after PR
- `rg -n 'emit\??:' servers/exarchos-mcp/src/topology/loader.ts` → returns no matches after PR

### #1324 — bun:sqlite subprocess test fix (cut-if-bloating)

Refactor three tests to in-process `EventStore`. If the in-process refactor reveals that the tests were genuinely exercising subprocess concurrency that in-process can't reproduce, file the actual coverage gap as a follow-up and keep the `.skip` for preview.1 — better to be honest about test coverage than to ship a green suite that no longer asserts what it claimed.

## Risk + sequencing

**Sequencing inside the PR(s):** items 1, 3, and 4 each have a non-trivial blast radius. The cleanest split is **two PRs**:

- PR α: #1303 + #1325 (event-emission consistency — same conceptual seam)
- PR β: #1333 + #1334 (post-DR-6/DR-7 follow-ups — same conceptual seam) + #1335 + #1336 (post-#1332 cleanup) + #1324 if scope-permitting

If capacity is tight, PR β is the cuttable one. PR α is the substrate-stabilization core; without it, preview.1 doesn't earn its name.

**Risk register:**

| Risk | Severity | Mitigation |
|---|---|---|
| #1303's crash-replay integration test depends on test-runtime support for SQLite under subprocess. If that's blocked by #1324, the headline test can't be written. | HIGH | Bundle #1324 fix into PR α, not PR β; or use in-process crash simulation (mock `eventStore.append` to throw mid-write). |
| #1333's posture-mapping extension may surface a capability that no posture cleanly implies, forcing Option 2 mid-flight. | MEDIUM | Document the abort condition (above). Don't widen the schema in this preview. |
| #1334's `Topology` threading touches CLI fast-exit paths that may not have a loaded topology. | MEDIUM | Decide in design phase whether "no topology = skip pruning" or fixtures. Either is reversible. |
| #1325's 18 sites are mechanical but `correlationId` threading isn't always boilerplate. | LOW | Per-site review during the PR; downscope individual sites if they need design attention. |

**Out of preview, on deck for GA:** #1290 (Roots-based workspace discovery), #1291 (dispatch-boundary correlation — three-field metadata), #1321 (description-budget guard), #1277 (JSON Schema 2020-12 conformance), #1244 (markdown-aware checkpoint lint). These are not gated on preview.1 but should be triaged during preview.2/3 windows.

---

## /design-invariants audit

Walking INV-1..INV-5 for the design.

### INV-1 — Event-Sourcing Integrity

**Verdict:** PASS (constructive — strengthens INV-1).

#1303 makes RT-3 (atomic append), RT-4 (single writer per stream), and RT-5 (idempotency) physically enforced on the merge path for the first time. Prior to this preview, those guarantees existed at the storage layer (#1259/#1323) but the consequential consumer (`merge-orchestrate`) didn't pass the keys, so the enforcement had no effect on the surface that needs it most. Acceptance question 4 ("can the output be reconstructed from events alone?") gets a stronger PASS after #1325 — every workflow event flows through `buildValidatedEvent` so envelope shape is uniform.

No reducer changes in this preview, no new event types, no projection schema changes. State-immutability harness (`assertReducerImmutable`) is unaffected.

**Severity guide application:** zero HIGH findings. The wider risk in this preview category is **MEDIUM (constructive)** — closes a `missing optimistic-concurrency guard on a write path` finding that's been latent since #1259's substrate landed.

### INV-2 — Facade Equivalence

**Verdict:** PASS.

No new actions across CLI/MCP carriers. #1303 changes the body of three append sites; both carriers route through the same composite-action handler. CLI ↔ MCP parity test in `parity.test.ts` (added in #1331) continues to assert equivalence post-merge.

### INV-3 — Basileus-Forward

**Verdict:** PASS.

`StorageBackend` interface is unchanged. The idempotency keys #1303 introduces are application-layer values, not transport-coupled — a remote backend can implement them as primitives. No new runtime tokens; #1333's resolver-based capability derivation is local to Exarchos and doesn't constrain remote-agent shape.

### INV-4 — Platform-Agnosticity

**Verdict:** PASS.

#1324 explicitly addresses the only platform-agnosticity wart left after #1332: `bun:sqlite` ESM scheme failures under subprocess Node. The fix is to remove the subprocess dependency, not to hardcode either runtime. No `runtimes/<name>.yaml` field is read at runtime by any code in this preview.

### INV-5 — Agent-First Interface Design

**5a Input ergonomics — PASS.** No new tool descriptions; existing descriptions inherit unchanged "do NOT use for" guidance from #1331/#1332.

**5b Output contract — PASS.** No envelope changes. `next_actions` shape unchanged. The `_meta.deprecation` slot (added in #1331) is preserved per non-goals.

**5c Aspire verbs — PASS.** No new verbs. All work is internal to existing `merge_orchestrate` and `prune_stale_workflows` actions.

**5d Action discriminator — PASS.** #1325 strengthens 5d by routing all workflow events through one canonical emission path; that's exactly the discipline 5d names.

---

## /axiom:design audit

Walking DIM-1..DIM-8 design questions.

### DIM-1 Topology

- **Lifecycle ownership:** Single source of truth for capabilities post-#1333 is `capabilities/resolver.ts`. `AgentSpec.capabilities` field disappears. Adapters call the resolver at render time.
- **Dependency injection:** `Topology` threaded through `selectPruneCandidates` (#1334) — no module-global topology cache introduced. `eventStore` continues to be DI'd via `DispatchContext` (per #1323).
- **Fallback policy:** No silent fallbacks introduced. CLI fast-exit paths in #1334 either get a fixture topology or skip pruning explicitly with a logged reason — never silently degrade to the old heuristic.
- **Graph shape:** No new cycles. `orchestrate/` continues to depend on `event-store/` and `topology/`; neither depends back.

### DIM-2 Observability

- **Catch posture:** No new catch blocks introduced. Existing `try/catch` in `merge-orchestrate` and `execute-merge` continues to log with structured context (per #1331's F-05 fix).
- **Error context:** Errors raised by SQLite OCC failures (`expectedSequence` mismatch) propagate with the structured envelope `{streamId, expected, actual}` already standardized in #1323.
- **Fallback visibility:** N/A — no fallback paths added.
- **Promise discipline:** No `.catch(() => {})`. All async error paths re-throw or surface via the existing logger.

### DIM-3 Contracts

- **Schema boundaries:** Zero schema changes. `event-store/schemas.ts` untouched. `AgentSpecSchema` already rejects `capabilities[]` post-#1332; #1333 aligns the runtime interface to that decision.
- **Versioning posture:** Non-breaking. The `_meta.deprecation` envelope slot from #1331 stays in place for one more release per CHANGELOG promise.
- **Type assertions:** No new `as` or `!` introduced. `posture` type is already a discriminated union (`'read-only' | 'task-isolated' | 'shared-mutating'`).
- **Cross-boundary contracts:** `eventStore.appendValidated` is the boundary; both caller and `EventStore` validate.

### DIM-4 Test Fidelity

- **Wiring parity:** #1303's crash-replay integration test wires the same `EventStore` instance production uses (no test-only mock). #1324 specifically addresses test-production divergence by removing the subprocess harness, not by adding mocks.
- **Mock boundary:** No new mocks at internal boundaries. The 3 `it.skip` markers added in #1323 are removed by #1324's refactor (or honestly downgraded to `it.todo` with linked follow-up if the in-process refactor reveals genuine coverage gaps).
- **Integration coverage:** #1303 acceptance includes both crash-replay and concurrent-invocation integration tests against `merge_orchestrate`.
- **Skip discipline:** Removes 3 existing `.skip`s. Adds zero new ones. If implementation forces a skip, the issue is filed before the skip lands.

### DIM-5 Hygiene

- **Single implementation:** #1325 consolidates 18 divergent emission sites into one canonical path. #1333 collapses two capability-derivation paths (`spec.capabilities` array + posture resolver) into one (resolver only).
- **Reachability:** #1335 + #1336 explicitly remove unreachable code (stale comments + vestigial options field).
- **Comment policy:** No commented-out code added. Stale "Pre-v2.11" comments removed.
- **Feature-flag horizon:** No new feature flags.

### DIM-6 Architecture

- **Dependency direction:** `merge-orchestrate` (orchestration layer) depends on `event-store` (storage layer). `agents/adapters/*` depend on `capabilities/resolver` (domain). All inward.
- **Module responsibility:** Resolver — "derive Capability set from AgentSpec posture." Pruner score — "score one workflow entry against one phase contract." Both single-sentence.
- **Interface placement:** `EventStore` interface lives in `event-store/`; consumers depend on the interface, not the SQLite implementation. Unchanged.
- **Change surface:** PR α touches ~6 files (3 append sites + 3-4 `buildValidatedEvent` migration sites per cluster). PR β touches ~12 files (definitions + adapters + handler + loader). Neither hits the >5 shotgun-surgery threshold meaningfully — most edits are mechanical and the cluster is conceptually one change per PR.

### DIM-7 Resilience

- **Cache bounds:** No new caches.
- **Timeout coverage:** SQLite operations inherit `BEGIN IMMEDIATE` semantics; OCC failures fail-fast rather than block. No new external calls.
- **Retry shape:** #1303 deliberately does **not** add retry logic. Idempotency keys make safe retry possible at the *caller's* discretion — the handler itself doesn't loop.
- **Resource lifecycle:** No new file handles, connections, or locks.

### DIM-8 Prose Quality

- **Audience and tone:** This design doc, the #1303 commit message, and the release notes for preview.1 target operators upgrading from v2.9.0 — name file paths and event types directly, no AI register.
- **Specificity check:** Every cleanup item names files and lines. No "various sites" or "several locations."
- **Voice ownership:** Prose written to match #1331's and #1332's PR-body voice — terse, audit-table-driven, parallel CHANGELOG breadcrumbs.
- **Removal threshold:** Zero new code comments planned beyond the JSDoc that already lives at each touched file.

---

## Acceptance criteria

Per-issue acceptance is captured in each issue body and re-stated in the implementation plan. At the preview level:

1. `npm run typecheck` clean (root + `servers/exarchos-mcp`)
2. `cd servers/exarchos-mcp && npm run test:run` — all green; no new `.skip`s; the 3 `.skip`s from #1323 are either removed (preferred) or converted to `.todo` with linked follow-up issue
3. `npm run skills:guard` clean (no skills source touched but rendered output may shift due to manifest version refresh)
4. `bash scripts/sync-versions.sh --check` reports `2.10.0-preview.1` after version bump
5. Replay-determinism property tests under SQLite (introduced in #1323) continue to pass
6. New crash-replay integration test in `merge-orchestrate.integration.test.ts` asserts exactly one `merge.executed` event after simulated crash-then-resume
7. Race extension in `store.race.test.ts` asserts no duplicate sequences from two concurrent `merge_orchestrate` invocations against the same stream
8. Posture-mapping table in `posture-mapping.test.ts` lists every capability previously declared in `agents/definitions.ts` literals; no capability lost in the migration

## Release notes shape

CHANGELOG entry for `[2.10.0-preview.1] - 2026-05-XX`:

- **Hardened (constructive — substrate guarantees now reach the merge path):** `merge-orchestrate` and `execute-merge` pass `idempotencyKey` + `expectedSequence` to event appends; crash-replay and concurrent-invocation scenarios no longer duplicate events (#1303). Eighteen workflow-handler emission sites migrated to canonical `buildValidatedEvent` + `appendValidated` (#1325).
- **Removed:** `AgentSpec.capabilities` runtime interface field (#1333) — derivation moves to `capabilities/resolver.ts` keyed on `posture`. `LoadTopologyOptions.emit` vestigial field (#1336). Stale "Pre-v2.11" doc-comments in `storage/lifecycle.ts` and `cli-commands/subagent-context.ts` (#1335).
- **Refactored:** `prune-stale-workflows` migrated from custom multi-signal heuristic to typed-contract scorer (#1334) — pruning policy now lives in `topology.yaml` `staleness` blocks per phase, not in handler code.
- **Fixed (CI):** Three subprocess-spawning tests refactored to in-process `EventStore`, removing the `bun:sqlite` ESM scheme failure on Node CI runners (#1324). `it.skip` markers added in #1323 lifted.
- **No schema migration. No agent-surface changes. No deprecation-shim removal.** This preview is internal-only.

Operator note: upgrading from v2.10.0 main (substrate-cut tip) to v2.10.0-preview.1 is a no-op at the data layer. Stay on this preview through preview.2 — that's where the V3→V4 schema migration lands.

## Roadmap

| Release | Theme | Anchor | Bundle |
|---|---|---|---|
| **2.10.0-preview.1** (this) | Substrate stabilization (Approach A) | #1303 | #1303, #1325, #1333, #1334, #1335, #1336, #1324 |
| 2.10.0-preview.2 | Marten R-1 + R-2 (Approach B) | #1312 epic | #1313, #1314 |
| 2.10.0-preview.3 | Agent Output Contract carrier swap (Approach C) | #1287 | #1287, #1288, #1289 |
| 2.10.0 GA | preview.3 stabilization + remaining milestone scope | — | #1290, #1291, #1321, #1277, #1244 |
