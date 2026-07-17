# Design: Codebase Audit + Fix Sprint

**Issues:** #660 (codebase audit), #563 (validation script audit), #568 (telemetry auto-correction)
**Date:** 2026-02-21
**Feature ID:** `codebase-audit-fix`

---

## 1. Problem Statement

The MCP server has grown to 43 event types, 22 actions, 5 composite tools, and 190+ source files. An audit reveals:

- **3 untested production events** — `team.task.failed`, `workflow.cas-failed`, `review.routed` are emitted but have no test coverage
- **7 orphan event types** — defined in schema but never emitted or consumed: `stack.restacked`, `team.disbanded`, `team.context.injected`, `quality.regression`, `review.finding`, `review.escalated`, `quality.hint.generated`
- **No telemetry auto-correction** — Tier 3 feedback loop (#568) missing; hints exist but corrections aren't applied programmatically
- **Integration test gaps** — only 3 integration tests for a system with 5 composite tools and 22 actions
- **40 bash scripts without test companions** — 52% coverage (44/84)

## 2. Scope

### In Scope
1. **Event hygiene** — Test untested emissions, annotate orphans with `@planned` markers
2. **Telemetry auto-correction** (#568) — Middleware interceptor that applies parameter defaults when thresholds are consistently exceeded
3. **Integration test expansion** — MCP tool round-trip tests for all 5 composite tools
4. **Validation script hardening** (#563) — Add test companions for safety-critical untested scripts

### Out of Scope
- Convention compliance sweep (already clean: 0 `any`, 0 console statements)
- Full property-based test expansion
- Workflow lifecycle integration tests (already exist in `__tests__/workflow/integration.test.ts`)

---

## 3. Technical Design

### 3.1 Event Hygiene

**Untested emissions (add tests):**

| Event | Emitted In | Test Action |
|-------|-----------|-------------|
| `team.task.failed` | `cli-commands/gates.ts` | Test that gate failure emits event with correct shape |
| `workflow.cas-failed` | `workflow/tools.ts` | Test CAS conflict emits event with expected/actual versions |
| `review.routed` | `review/tools.ts` | Test review routing emits event with target and score |

**Orphan events (annotate, don't remove):**

Orphan events represent planned features (review system, quality regression tracking, team lifecycle). Rather than removing them from the schema, add `/** @planned — not yet emitted in production */` JSDoc annotations so they're clearly marked as scaffolding. This preserves forward compatibility for the test fixtures that already reference them.

**Files modified:**
- `src/event-store/schemas.ts` — Add `@planned` annotations to 7 orphan event types
- `src/__tests__/workflow/events.test.ts` (new tests for `team.task.failed`)
- `src/__tests__/workflow/tools.test.ts` (new tests for `workflow.cas-failed`)
- `src/review/tools.test.ts` (new tests for `review.routed`)

### 3.2 Telemetry Auto-Correction (#568)

**Architecture:**

```
Request → withTelemetry() → withAutoCorrection() → handler → response
                                    │
                                    ├── Check consistency window (last N calls)
                                    ├── Match correction rules
                                    ├── Apply parameter defaults (additive only)
                                    └── Append correction note to response
```

**Correction rules (matching existing hint thresholds):**

| Tool | Trigger | Correction |
|------|---------|------------|
| `exarchos_view` (tasks) | p95Bytes > 1200, no `fields` | Inject `fields: ["id","title","status","assignee"]` |
| `exarchos_event` (query) | p95Bytes > 2000, no `limit` | Inject `limit: 50` |
| `exarchos_workflow` (get) | p95Bytes > 600, no `query` and no `fields` | Inject `fields: ["phase","tasks","artifacts"]` |

**Design constraints:**
- **Consistency window:** Only trigger after 5+ consecutive threshold breaches (not first occurrence)
- **Additive only:** Never remove/override parameters the caller explicitly set
- **Transparent:** Append `_autoCorrection: { applied: [...], reason: string }` to response
- **Opt-out:** If request includes `skipAutoCorrection: true`, bypass entirely
- **Tracked:** Emit `quality.hint.generated` event when correction is applied (activates an orphan event type)

**New files:**
- `src/telemetry/auto-correction.ts` — Correction rules engine and application logic
- `src/telemetry/auto-correction.test.ts` — Unit tests for correction rules

**Modified files:**
- `src/telemetry/middleware.ts` — Integrate auto-correction into `withTelemetry()` pipeline
- `src/telemetry/middleware.test.ts` — Tests for auto-correction integration
- `src/telemetry/constants.ts` — Extract threshold constants from `hints.ts`
- `src/telemetry/hints.ts` — Refactor to use shared constants

### 3.3 Integration Test Expansion

**Strategy:** Add MCP tool round-trip tests that exercise action routing, Zod validation, and response formatting for each composite tool. Use the established pattern from `context-reload.integration.test.ts` (temp dirs, real file I/O).

**New test file:** `src/__tests__/mcp-tools.integration.test.ts`

**Test cases (one per composite tool + cross-tool):**

| Test | Tools | Validates |
|------|-------|-----------|
| `Workflow_InitGetSet_RoundTrip` | workflow | init → get → set → get confirms update |
| `Event_AppendQuery_RoundTrip` | event | append → query returns event with correct shape |
| `Event_BatchAppend_RoundTrip` | event | batch_append → query returns all events in order |
| `Orchestrate_TaskClaim_RoundTrip` | orchestrate | init workflow → claim task → verify event emitted |
| `View_Pipeline_MaterializesFromEvents` | view + event | append events → pipeline view reflects them |
| `View_Telemetry_ReflectsToolUsage` | view | instrument handler → view shows metrics |
| `Sync_Now_TriggersSync` | sync | configure sync → now → verify outbox processed |
| `UnknownAction_ReturnsError` | all | send unknown action → get UNKNOWN_ACTION error |
| `InvalidSchema_ReturnsValidationError` | workflow | send malformed params → Zod error returned |
| `CrossTool_WorkflowLifecycle` | workflow + event + view | init → transition → view reflects phase change |

### 3.4 Validation Script Test Companions (#563)

**Priority scripts to add tests for (safety-critical):**

| Script | Risk | Reason |
|--------|------|--------|
| `validate-rm.sh` | HIGH | Guards destructive `rm` operations |
| `validate-installation.sh` | HIGH | Validates symlink installation integrity |
| `setup-worktree.sh` | MEDIUM | Creates git worktrees for delegation |
| `review-diff.sh` | MEDIUM | Generates diff for review stage |
| `extract-task.sh` | MEDIUM | Parses tasks from plan documents |
| `new-project.sh` | LOW | Project scaffolding |

**New files:**
- `scripts/validate-rm.test.sh`
- `scripts/validate-installation.test.sh`
- `scripts/setup-worktree.test.sh`
- `scripts/review-diff.test.sh`
- `scripts/extract-task.test.sh`

**Pattern:** Follow established test convention — `set -euo pipefail`, temp dir isolation, exit code assertions.

---

## 4. Parallelization Strategy

Four independent worktrees:

| Worktree | Tasks | Dependencies |
|----------|-------|-------------|
| **A: Event Hygiene** | Annotate orphans, test untested emissions | None |
| **B: Telemetry Auto-Correction** | Constants extraction, correction engine, middleware integration | None |
| **C: Integration Tests** | MCP tool round-trip tests | None |
| **D: Script Test Companions** | Add test.sh for 5 safety-critical scripts | None |

All 4 worktrees are fully independent — no cross-dependencies.

---

## 5. Exit Criteria

- [ ] All 3 untested event emissions have test coverage
- [ ] 7 orphan event types annotated with `@planned`
- [ ] Auto-correction middleware applies parameter defaults for 3 rules
- [ ] Auto-correction is opt-out via `skipAutoCorrection: true`
- [ ] 10 integration tests covering all 5 composite tools
- [ ] 5 bash script test companions added for safety-critical scripts
- [ ] All existing tests continue to pass (zero regressions)

---

## 6. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Auto-correction breaks existing tool behavior | Medium | Additive-only rule, opt-out flag, consistency window |
| Integration tests flaky due to file I/O | Low | Temp dir isolation per test, deterministic inputs |
| Orphan event removal breaks test fixtures | Low | Annotate-only approach preserves all types |
