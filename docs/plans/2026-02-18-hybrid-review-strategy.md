# Implementation Plan: Hybrid Review Strategy

## Source Design
Link: `docs/designs/2026-02-18-hybrid-review-strategy.md`

## Scope
**Target:** Phases 1-3 (Deterministic Router, Self-Hosted Review Agent, Merge Gate Extension)
**Excluded:** Phase 4 (Semantic Augmentation) — depends on Basileus Phase 4 (ADR timeline). Deferred until vector search and Cohere rerank infrastructure are available.

## Summary
- Total tasks: 13
- Parallel groups: 3
- Estimated test count: 28
- Design coverage: 8 of 9 Technical Design subsections covered (Semantic Scoring Layer deferred)

## Spec Traceability

| Design Section | Key Requirements | Task(s) | Coverage |
|---|---|---|---|
| Deterministic Scoring Layer | PRDiffMetadata/RiskFactor/PRRiskScore types, scorePR function with 6 risk factors, path-pattern matching, weighted scoring | T1, T4 | Full |
| Semantic Scoring Layer (Basileus) | Vector search, Cohere rerank, score augmentation | Deferred | Phase 4 |
| Velocity Detection | VelocityTier type, detectVelocity function, active workflow + pending review queries | T2, T5 | Full |
| Dispatch Logic | Threshold map, dispatchReviews function, velocity-adjusted routing | T2, T6 | Full |
| Self-Hosted Review Agent | Review scope definition, finding emission, event format | T9 | Full |
| Review Merge Gate | Dual-track result merging, gate decision matrix, secondary escalation | T7, T8 | Full |
| Event Taxonomy | review.routed, review.finding, review.escalated Zod schemas | T3 | Full |
| Developer Override | Label-based gating, skip-coderabbit label application | T10, T11 | Full |
| CodeRabbit Configuration | ignore_labels in .coderabbit.yaml | T11 | Full |
| Validation Script | verify-review-triage.sh | T12 | Full |
| Integration: review skill | Triage step before review dispatch | T13 | Full |

## Section Coverage Notes

### Architecture
The Architecture section is the overview diagram showing how all components connect. It has no standalone implementation — it is fully covered by the aggregate of T1-T13 which implement every component shown in the diagram (triage router, scoring layers, dispatch, merge gate, self-hosted track, CodeRabbit track).

### Semantic Scoring Layer (Basileus Augmentation)
Explicitly deferred to Phase 4 per design document. Depends on Basileus knowledge system (NLP Sidecar, IVectorSearchAdapter, Cohere rerank). The `dispatchReviews` function (T6) includes the `basileusConnected` guard so semantic augmentation can be added without modifying the dispatch interface.

## Task Breakdown

### Group A: Foundation Types & Event Schemas (Parallelizable)

---

### Task 1: Define PR risk scoring types

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `scorePR_Types_ExportedCorrectly`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/review-triage.test.ts`
   - Tests: Import types (PRDiffMetadata, RiskFactor, PRRiskScore), verify they accept valid objects and reject invalid ones via type assertions
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement types
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/types.ts`
   - Define: `PRDiffMetadata` (number, paths, linesChanged, filesChanged, newFiles), `RiskFactor` (name, weight, matched, detail), `PRRiskScore` (pr, score, factors, recommendation)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Add JSDoc comments for public interfaces

**Dependencies:** None
**Parallelizable:** Yes (with T2, T3)

---

### Task 2: Define velocity and dispatch types

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `dispatchTypes_ExportedCorrectly`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/review-triage.test.ts`
   - Tests: Import types (VelocityTier, ReviewContext, ReviewDispatch), verify type-safe object construction
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement types
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/types.ts`
   - Define: `VelocityTier` ("normal" | "elevated" | "high"), `ReviewContext` (activeWorkflows, pendingCodeRabbitReviews), `ReviewDispatch` (pr, riskScore, coderabbit, selfHosted, velocity, reason)
   - Run: `npm run test:run` - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (with T1, T3)

---

### Task 3: Add review event schemas to event store

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `reviewEventSchemas_ValidateCorrectly`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Tests: Validate review.routed, review.finding, review.escalated events pass Zod schema; verify invalid events (missing required fields, wrong types) fail validation
   - Expected failure: Unknown event types in schema
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add event types to schemas
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`
   - Add `review.routed` (pr, riskScore, factors, destination, velocityTier, semanticAugmented)
   - Add `review.finding` (pr, source, severity, filePath, lineRange?, message, rule?)
   - Add `review.escalated` (pr, reason, originalScore, triggeringFinding)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Ensure event types are added to the discriminated union consistently with existing patterns

**Dependencies:** None
**Parallelizable:** Yes (with T1, T2)

---

### Group B: Core Scoring Logic (Sequential, depends on Group A)

---

### Task 4: Implement scorePR deterministic scoring function

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `scorePR_SecurityPath_ReturnsHighScore` — PR touching auth/ path → score >= 0.30
   - `scorePR_ApiSurface_IncludesApiWeight` — PR touching api/controller → score includes 0.20
   - `scorePR_DiffComplexity_LargeChange_IncludesWeight` — 400 lines, 12 files → score includes 0.15
   - `scorePR_NewFiles_IncludesWeight` — PR introducing new files → score includes 0.10
   - `scorePR_InfraConfig_IncludesWeight` — PR touching Dockerfile/.yaml → score includes 0.15
   - `scorePR_CrossModule_MultipleDirs_IncludesWeight` — paths across 3+ top-level dirs → score includes 0.10
   - `scorePR_AllFactorsMatched_ReturnsMaxScore` — all factors match → score = 1.0
   - `scorePR_NoFactorsMatched_ReturnsZero` — trivial PR → score = 0.0
   - `scorePR_AboveThreshold_RecommendsCoderabbit` — score >= 0.4 → recommendation = "coderabbit"
   - `scorePR_BelowThreshold_RecommendsSelfHosted` — score < 0.4 → recommendation = "self-hosted"
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/review-triage.test.ts`
   - Expected failure: Function not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement scorePR
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/scoring.ts`
   - Implement 6 risk factors with path regex matching and weight accumulation per design spec
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract risk factor definitions into a configurable array constant for future extensibility

**Dependencies:** T1
**Parallelizable:** No (sequential with T5, T6)

---

### Task 5: Implement detectVelocity function

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `detectVelocity_NoPressure_ReturnsNormal` — 0 active stacks, 0 pending reviews → "normal"
   - `detectVelocity_MultipleStacks_ReturnsElevated` — 2 active stacks, 3 pending → "elevated"
   - `detectVelocity_HighPendingReviews_ReturnsHigh` — 1 stack, 7 pending reviews → "high"
   - `detectVelocity_HighPendingOverridesStacks_ReturnsHigh` — 2 stacks, 8 pending → "high" (pending takes priority)
   - `detectVelocity_SingleStack_ReturnsNormal` — 1 stack, 2 pending → "normal"
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/review-triage.test.ts`
   - Expected failure: Function not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement detectVelocity
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/velocity.ts`
   - Query active workflows in delegate/review/synthesize phases, count pending CodeRabbit reviews
   - Run: `npm run test:run` - MUST PASS

**Dependencies:** T2
**Parallelizable:** No (sequential with T4, T6)

---

### Task 6: Implement dispatchReviews function

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `dispatchReviews_NormalVelocity_AllToCodeRabbit` — threshold 0.0 → all PRs get coderabbit=true
   - `dispatchReviews_ElevatedVelocity_FiltersByThreshold` — threshold 0.3 → only score >= 0.3 get CodeRabbit
   - `dispatchReviews_HighVelocity_OnlyHighRisk` — threshold 0.5 → only score >= 0.5 get CodeRabbit
   - `dispatchReviews_AllPRs_AlwaysGetSelfHosted` — regardless of velocity, selfHosted=true for all
   - `dispatchReviews_ReasonIncludesScore` — dispatch reason contains score and threshold values
   - `dispatchReviews_BasileusNotConnected_SkipsSemantic` — basileusConnected=false → no semantic augmentation
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/review-triage.test.ts`
   - Expected failure: Function not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement dispatchReviews
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/dispatch.ts`
   - Combine scorePR + detectVelocity with threshold map; return ReviewDispatch array
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract THRESHOLDS constant and ensure it's exported for configuration

**Dependencies:** T4, T5
**Parallelizable:** No (depends on T4, T5)

---

### Group C: Review Merge Gate Script (Depends on Group A for event schema)

---

### Task 7: Implement review merge gate decision logic

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `mergeGate_SelfHostedPass_CodeRabbitPass_Approves`
   - `mergeGate_SelfHostedPass_CodeRabbitSkipped_Approves`
   - `mergeGate_SelfHostedFindings_CodeRabbitPass_Approves` (minor findings only)
   - `mergeGate_SelfHostedPass_CodeRabbitFindings_Waits` (critical/major)
   - `mergeGate_SelfHostedFail_Blocks` (regardless of CodeRabbit)
   - `mergeGate_CodeRabbitCritical_Blocks` (regardless of self-hosted)
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/merge-gate.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement merge gate decision function
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/merge-gate.ts`
   - Dual-track result combination: selfHosted (PASS/FINDINGS/FAIL) × coderabbit (PASS/FINDINGS/SKIPPED/PENDING) → decision (APPROVED/WAIT/BLOCK)
   - Run: `npm run test:run` - MUST PASS

**Dependencies:** T3 (event schemas for finding types)
**Parallelizable:** Yes (with T4, T5)

---

### Task 8: Implement secondary escalation logic in merge gate

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `escalation_SelfHostedMediumFinding_CodeRabbitSkipped_Escalates` — medium+ finding on skipped PR → triggers escalation
   - `escalation_SelfHostedMinorFinding_CodeRabbitSkipped_NoEscalation` — minor finding on skipped PR → no escalation
   - `escalation_SelfHostedMediumFinding_CodeRabbitReviewed_NoEscalation` — medium finding when CR already reviewed → no escalation
   - `escalation_EmitsReviewEscalatedEvent` — verify event payload matches schema
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/merge-gate.test.ts`
   - Expected failure: Escalation function not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement escalation detection
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/merge-gate.ts`
   - Check if self-hosted finding severity >= medium AND CodeRabbit status = SKIPPED → emit ReviewEscalated event, remove skip-coderabbit label
   - Run: `npm run test:run` - MUST PASS

**Dependencies:** T7
**Parallelizable:** No (extends T7)

---

### Group D: Scripts & Configuration (Parallelizable after Group B)

---

### Task 9: Create self-hosted review agent prompt

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: Validation script checks prompt template exists and contains required sections
   - File: `scripts/verify-review-triage.test.sh`
   - Test: Verify `plugins/exarchos/agents/self-hosted-reviewer.md` exists and contains review scope sections
   - Expected failure: Agent file not found
   - Run: `bash scripts/verify-review-triage.test.sh` - MUST FAIL

2. [GREEN] Create agent prompt
   - File: `plugins/exarchos/agents/self-hosted-reviewer.md`
   - Content: Role definition, review scope (SOLID, style, TDD, error handling, DRY, test quality), excluded scope (security, cross-file semantic), output format (review.finding events), integration with .coderabbit.yaml coding guidelines
   - Run: `bash scripts/verify-review-triage.test.sh` - MUST PASS

**Dependencies:** T3 (event schema for review.finding format)
**Parallelizable:** Yes (with T10, T11, T12)

---

### Task 10: Extend coderabbit-review-gate.sh with --allow-skipped flag

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests in existing test file:
   - `allowSkipped_CodeRabbitSkipped_Approves` — with --allow-skipped, skipped PRs pass
   - `noAllowSkipped_CodeRabbitSkipped_Waits` — without flag, skipped PRs wait (existing behavior)
   - File: `scripts/coderabbit-review-gate.test.sh` (extend existing)
   - Expected failure: Unknown flag --allow-skipped
   - Run: `bash scripts/coderabbit-review-gate.test.sh` - MUST FAIL

2. [GREEN] Add --allow-skipped flag
   - File: `scripts/coderabbit-review-gate.sh`
   - Parse new flag, when set: if PR has skip-coderabbit label and no CodeRabbit review, treat as APPROVED instead of WAIT
   - Run: `bash scripts/coderabbit-review-gate.test.sh` - MUST PASS

**Dependencies:** None (extends existing script)
**Parallelizable:** Yes (with T9, T11, T12)

---

### Task 11: Update .coderabbit.yaml with ignore_labels

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: YAML validation checks ignore_labels exists
   - File: `scripts/verify-review-triage.test.sh`
   - Test: Parse .coderabbit.yaml, verify `auto_review.ignore_labels` contains "skip-coderabbit"
   - Expected failure: ignore_labels not found
   - Run: `bash scripts/verify-review-triage.test.sh` - MUST FAIL

2. [GREEN] Update CodeRabbit config
   - File: `.coderabbit.yaml`
   - Add `ignore_labels: ["skip-coderabbit"]` under `auto_review` section
   - Run: `bash scripts/verify-review-triage.test.sh` - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (with T9, T10, T12)

---

### Task 12: Create verify-review-triage.sh validation script

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: verify-review-triage.test.sh tests the validation script itself
   - File: `scripts/verify-review-triage.test.sh`
   - Tests: Script with valid state → exit 0; script with missing ReviewRouted events → exit 1; script with missing args → exit 2
   - Expected failure: Script not found
   - Run: `bash scripts/verify-review-triage.test.sh` - MUST FAIL

2. [GREEN] Implement validation script
   - File: `scripts/verify-review-triage.sh`
   - Verifies: all PRs have ReviewRouted event, high-risk PRs sent to CodeRabbit, self-hosted ran for all PRs, no PR merged without review track completing
   - Exit codes: 0 (pass), 1 (fail), 2 (usage)
   - Run: `bash scripts/verify-review-triage.test.sh` - MUST PASS

**Dependencies:** T3 (event schema for ReviewRouted validation)
**Parallelizable:** Yes (with T9, T10, T11)

---

### Group E: Integration (Depends on Groups B, C, D)

---

### Task 13: Wire review triage into MCP server as composite tool action

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `reviewTriage_Action_ReturnsDispatchResults`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/review-triage.test.ts`
   - Tests: Call triage handler with mock PR metadata + mock workflow state → returns ReviewDispatch array, emits ReviewRouted events to event store
   - Expected failure: Handler not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement triage handler and register tool
   - File: `plugins/exarchos/servers/exarchos-mcp/src/review/tools.ts`
   - Handler: Extract PR diff metadata (paths, stats) from input, call scorePR for each, detectVelocity from state, dispatchReviews, emit review.routed events, return dispatch results
   - Registration: Add `registerReviewTools(server, stateDir)` call in `index.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Ensure tool response follows ToolResult shape with compact/full detail levels

**Dependencies:** T4, T5, T6, T7, T8 (all core logic)
**Parallelizable:** No (integration task)

---

## Parallelization Strategy

```
Group A (T1, T2, T3) ──────────────────── parallel ──────────────────
      │                                        │
      ▼                                        ▼
Group B (T4 → T5 → T6)              Group C (T7 → T8)
      │                                        │
      ├──── Group D (T9, T10, T11, T12) ───── parallel ──────────
      │
      ▼
Group E (T13) ── depends on B + C + D
```

**Worktree allocation:**
- Worktree 1: Group A + Group B (types → scoring → dispatch, sequential chain)
- Worktree 2: Group C (merge gate logic, independent once schemas exist)
- Worktree 3: Group D (scripts + config, independent once schemas exist)
- Worktree 4: Group E (integration, after all others complete)

## Deferred Items

### Semantic Scoring Layer (Phase 4) — [GitHub Issue #528](https://github.com/lvlup-sw/exarchos/issues/528)

**Rationale:** Depends on Basileus knowledge system infrastructure (ADR Phase 4 timeline). Cannot be implemented until NLP Sidecar, vector search, and rerank infrastructure are deployed.

**Full scope of deferred work:**

1. **PR Diff Embedding Pipeline**
   - Embed PR diff summaries via Basileus NLP Sidecar
   - Chunking strategy for large diffs (token-limited embedding input)
   - Embedding model selection (must match `review-findings` collection index)

2. **Vector Search Integration (`review-findings` collection)**
   - New vector collection populated by scraping historical CodeRabbit critical/major findings via GitHub API
   - Schema: finding description, affected file paths, diff context, severity, CodeRabbit rule ID
   - Population strategy: 90 days or 500 findings (whichever larger), periodic refresh
   - Query: top-K similar past diffs that triggered high-severity findings
   - Uses `IVectorSearchAdapter` interface from Basileus knowledge domain

3. **Cohere Rerank Integration**
   - Hosted rerank model (https://cohere.com/rerank) for cross-attention re-scoring
   - Query: current PR diff summary; Documents: historical finding descriptions + affected code from vector search results
   - Rerank eliminates embedding-only false positives via cross-attention (e.g., structurally similar but semantically different diffs)
   - Score thresholds: similarity > 0.7 → +0.25 risk adjustment; > 0.5 → +0.10; else no adjustment

4. **`augmentWithSemanticScore()` Implementation**
   - Wire into `dispatchReviews()` via existing `basileusConnected` guard (T6 pre-wired)
   - Merge semantic risk adjustment with deterministic score
   - Cap combined score at 1.0
   - Set `semanticAugmented: true` on ReviewRouted event

5. **Existing Collections Reuse**
   - `codebase-patterns` — known complexity hotspots inform risk scoring
   - `coding-sessions` — prior review outcomes provide additional training signal

**Interface contract (pre-wired in Phase 1):**
```typescript
// T6 dispatch.ts already includes this guard:
if (basileusConnected) {
  riskScore = augmentWithSemanticScore(riskScore, pr);
}
// augmentWithSemanticScore is a stub returning unmodified score until Phase 4
```

### Review Skill Integration

**Rationale:** Updating `/review` and `/synthesize` skills to invoke triage router is a content change that depends on the MCP tool being deployed and validated. Plan as a follow-up after this implementation lands.

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Ready for review
