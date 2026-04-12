# Design: Hybrid Review Strategy

> ## ⚠️ Phase 4 superseded (2026-04-10)
>
> The **Semantic Scoring Layer (Basileus Augmentation)** section and **Phase 4** of the Implementation Phases table below have been superseded by an architectural decision to move review triage with semantic scoring into basileus as a dedicated Phronesis Code Review agent, rather than as a cross-repo split with exarchos calling basileus via HTTP.
>
> **Rationale:** Review triage with semantic scoring is agent-shaped work (LLM reasoning, tool use, finding emission, reflective loops). Agent-shaped work belongs in the agent host (basileus), not the dev workflow harness (exarchos). The cross-repo `basileusConnected` guard + `augmentWithSemanticScore()` stub was a coordination tax that vanishes once the agent lives in basileus.
>
> **Tracking:**
> - [`lvlup-sw/basileus#146`](https://github.com/lvlup-sw/basileus/issues/146) — architectural decision
> - [`lvlup-sw/basileus#147`](https://github.com/lvlup-sw/basileus/issues/147) — Phronesis Code Review agent (the replacement)
> - [`lvlup-sw/basileus#148`](https://github.com/lvlup-sw/basileus/issues/148) — review-findings data fabric foundation (prerequisite)
> - [`lvlup-sw/exarchos#1077`](https://github.com/lvlup-sw/exarchos/issues/1077) — removes the orphaned `augmentWithSemanticScore()` stub and `basileusConnected` guard from this repo
>
> **What's NOT superseded:** Phases 1-3 (the deterministic triage router, velocity detection, label-based CodeRabbit gating, and the review merge gate) remain in effect pending the broader retention discussion in [`lvlup-sw/basileus#146`](https://github.com/lvlup-sw/basileus/issues/146). Those are useful even in a basileus-disconnected mode. This supersession applies only to Phase 4 (semantic augmentation) and the `augmentWithSemanticScore()` / `basileusConnected` / HTTP client machinery.

## Problem Statement

CodeRabbit provides high-value review capabilities — security/static analysis, cross-file semantic analysis, severity classification, and accumulated learnings — that are difficult to replicate with self-hosted agents. However, CodeRabbit enforces a per-PR rate limit (~5 min cooldown), which creates a bottleneck during high-velocity development. An 8-PR Graphite stack takes ~40 minutes for a single CodeRabbit review pass, with each fix cycle doubling that. Multiple features in flight compound the problem.

The current architecture (ADR section 11: Layered Quality Gates) positions CodeRabbit at Layer 4 as a per-stack advisory gate. This design doesn't address the rate limit tension: we want per-PR CodeRabbit review for critical/major issue detection, but can't afford to send every PR through CodeRabbit during velocity spikes.

Self-hosted agents can handle minor-severity findings (style, SOLID violations, test quality, error handling) but cannot replicate CodeRabbit's deep security analysis, cross-file semantic understanding, or severity classification model.

**Goal:** Achieve a 30-minute single-pass review target for a full stack, with per-PR CodeRabbit review at best and high-impact-subset review at worst, while maintaining full review coverage via self-hosted agents for all PRs.

## Options Evaluated

### Option 1: Adaptive Triage Router

Score each PR by risk using deterministic heuristics (path patterns, diff stats, change categories). During normal velocity, all PRs go to CodeRabbit. During high velocity, only PRs above a risk threshold go to CodeRabbit — the rest get self-hosted review only. Augment with Basileus semantic scoring when available.

**Pros:** Direct Task Router extension, deterministic/testable, 30-min target naturally achievable, zero LLM tokens for routing.
**Cons:** Risk classification could miss edge cases, triage thresholds need calibration.

### Option 2: CodeRabbit as Escalation Tier

Self-hosted agents review every PR first. When an agent detects uncertainty or a security-sensitive pattern, it escalates that PR to CodeRabbit. CodeRabbit becomes the escalation tier rather than the primary reviewer.

**Pros:** Every PR gets immediate review, CodeRabbit usage is demand-driven, naturally minimizes API calls.
**Cons:** Requires agents to "know what they don't know" (non-deterministic escalation), inverts the ADR's escalation model, higher token cost, harder to test.

### Option 3: Parallel Dual-Track with Timeout

Run both systems on every PR. Self-hosted runs immediately; CodeRabbit trickles in as rate limits allow. PRs can merge once self-hosted passes and either CodeRabbit reviews or a timeout expires for low-risk PRs.

**Pros:** Simplest mental model, eventual full coverage.
**Cons:** Doesn't solve the rate limit (still 40 min for full stack), timeout-based merge means some PRs merge without CodeRabbit.

**Selected: Option 1.** Deterministic routing aligns with the Task Router pattern, satisfies the optimization principle that validation steps should be executable functions (not agent judgment), and the Basileus semantic layer provides a learning path without blocking initial delivery.

## Chosen Approach

**Adaptive Triage Router** — a review dispatch layer that extends the Task Router pattern (ADR section 5) to the review domain. A deterministic scoring function classifies each PR by risk, a velocity detector determines current pipeline pressure, and the router dispatches PRs to CodeRabbit or self-hosted review accordingly. When Basileus knowledge is available, semantic scoring augments the deterministic heuristics using vectorized codebase data and Cohere rerank against historical findings.

**Rationale:**
- Direct extension of the existing Task Router pattern — same score-based routing, same event taxonomy, same developer override annotations
- Deterministic routing decisions are unit-testable, auditable via `ReviewRouted` events, and reproducible
- Zero LLM tokens for routing — triage is a pure function over diff metadata
- 30-minute target naturally achievable: 2-3 high-risk PRs × 5 min CodeRabbit + parallel self-hosted
- Graceful degradation: full CodeRabbit coverage when velocity is normal, intelligent subset when constrained
- Basileus semantic augmentation provides a learning path without blocking initial delivery

## Technical Design

### Architecture

```
Stack submitted (8 PRs)
  │
  ├─ Review Triage Router
  │    │
  │    ├─ Layer 1: Deterministic Scoring (always available)
  │    │    Path risk, diff stats, change categories
  │    │
  │    ├─ Layer 2: Semantic Scoring (when Basileus connected)
  │    │    Vector similarity to historical findings,
  │    │    Cohere rerank against critical/major corpus
  │    │
  │    └─ Layer 3: Velocity-Adjusted Dispatch
  │         Normal velocity  → all PRs to CodeRabbit
  │         High velocity    → threshold-filtered subset to CodeRabbit
  │         Critical velocity → only critical-path PRs to CodeRabbit
  │
  ├─ CodeRabbit track (rate-limited, sequential)
  │    High-risk PRs only during velocity pressure
  │    All PRs during normal operations
  │
  ├─ Self-hosted track (no rate limit, parallel)
  │    All PRs always — covers minor/medium findings
  │    Leverages .coderabbit.yaml coding guidelines + review skill
  │
  └─ Review Merge Gate
       Combines findings from both tracks
       Applies existing severity-based approval logic
```

### Deterministic Scoring Layer

The deterministic layer scores each PR using metadata extractable from `git diff --stat` and file path analysis. No file content reading required — this runs in milliseconds.

```typescript
interface PRRiskScore {
  pr: number;
  score: number;           // 0.0 - 1.0
  factors: RiskFactor[];
  recommendation: "coderabbit" | "self-hosted" | "both";
}

interface RiskFactor {
  name: string;
  weight: number;
  matched: boolean;
  detail: string;
}

function scorePR(pr: PRDiffMetadata): PRRiskScore {
  const factors: RiskFactor[] = [
    // Security-sensitive paths
    {
      name: "security-path",
      weight: 0.30,
      matched: pr.paths.some(p =>
        /auth|security|crypto|token|secret|credential|permission/i.test(p)
      ),
      detail: "Touches security-sensitive code paths"
    },
    // API surface changes
    {
      name: "api-surface",
      weight: 0.20,
      matched: pr.paths.some(p =>
        /api\/|controller|endpoint|middleware|handler/i.test(p)
      ),
      detail: "Modifies public API surface"
    },
    // Diff complexity (high line count or many files)
    {
      name: "diff-complexity",
      weight: 0.15,
      matched: pr.linesChanged > 300 || pr.filesChanged > 10,
      detail: `${pr.linesChanged} lines across ${pr.filesChanged} files`
    },
    // New file introduction (higher risk than modifications)
    {
      name: "new-files",
      weight: 0.10,
      matched: pr.newFiles > 0,
      detail: `${pr.newFiles} new files introduced`
    },
    // Infrastructure / config changes
    {
      name: "infra-config",
      weight: 0.15,
      matched: pr.paths.some(p =>
        /dockerfile|\.ya?ml$|\.env|infra\/|deploy|ci\//i.test(p)
      ),
      detail: "Infrastructure or configuration changes"
    },
    // Cross-module changes (touches multiple top-level dirs)
    {
      name: "cross-module",
      weight: 0.10,
      matched: new Set(pr.paths.map(p => p.split("/")[0])).size > 2,
      detail: "Changes span multiple modules"
    },
  ];

  const score = factors
    .filter(f => f.matched)
    .reduce((sum, f) => sum + f.weight, 0);

  return {
    pr: pr.number,
    score,
    factors,
    recommendation: score >= 0.4 ? "coderabbit" : "self-hosted"
  };
}
```

### Semantic Scoring Layer (Basileus Augmentation)

When the Basileus knowledge system is connected, the triage router augments deterministic scores with semantic intelligence. This layer is entirely optional — the router functions with deterministic scoring alone.

```
PR Diff Summary
  │
  ├─ Embed diff via Basileus NLP Sidecar
  │
  ├─ Vector search: coding-sessions collection
  │   "PRs with historical critical/major CodeRabbit findings"
  │   → top-K similar past diffs that triggered high-severity findings
  │
  ├─ Cohere rerank: reorder candidates by relevance
  │   Query: PR diff summary
  │   Documents: historical finding descriptions + affected code
  │   → reranked similarity scores
  │
  └─ Semantic risk adjustment:
      If top reranked result similarity > 0.7:
        score += 0.25 (strong match to historically risky pattern)
      If top reranked result similarity > 0.5:
        score += 0.10 (moderate match)
      Else:
        no adjustment (novel change, rely on deterministic score)
```

**Data sources for the vector corpus:**

| Collection | Content | Source |
|---|---|---|
| `review-findings` | Historical CodeRabbit critical/major findings with affected file paths and diff context | Scraped from CodeRabbit review comments via GitHub API |
| `codebase-patterns` | Indexed codebase patterns, architecture decisions, known complexity hotspots | Existing Basileus knowledge collection (ADR section 6.2) |
| `coding-sessions` | Prior coding session results including review outcomes | Existing Basileus knowledge collection |

**Cohere rerank integration:**

The rerank model evaluates semantic similarity between the current PR's diff summary and historical finding descriptions. This answers: "Does this PR look like changes that previously caused critical findings?" — a question that pure path-matching cannot answer (e.g., a refactor to `utils.ts` that introduces a subtle injection vulnerability looks "low risk" to path heuristics but "high risk" to semantic similarity against past injection findings).

The rerank step runs after initial vector retrieval to re-score candidates with cross-attention, eliminating false positives from embedding-only similarity. Cohere's hosted model keeps infrastructure cost minimal.

### Velocity Detection

Velocity is determined by querying active workflow state and the CodeRabbit review queue.

```typescript
type VelocityTier = "normal" | "elevated" | "high";

function detectVelocity(context: ReviewContext): VelocityTier {
  const activeStacks = context.activeWorkflows.filter(
    w => w.phase === "delegate" || w.phase === "review" || w.phase === "synthesize"
  ).length;

  const pendingReviews = context.pendingCodeRabbitReviews;

  // More than 6 PRs waiting for CodeRabbit → high velocity
  if (pendingReviews > 6) return "high";

  // Multiple stacks in review phases → elevated
  if (activeStacks >= 2) return "elevated";

  return "normal";
}
```

### Dispatch Logic

The velocity tier adjusts the risk threshold for CodeRabbit routing.

```typescript
const THRESHOLDS: Record<VelocityTier, number> = {
  normal: 0.0,    // All PRs go to CodeRabbit
  elevated: 0.3,  // Medium+ risk PRs go to CodeRabbit
  high: 0.5,      // Only high-risk PRs go to CodeRabbit
};

function dispatchReviews(
  prs: PRDiffMetadata[],
  velocity: VelocityTier,
  basileusConnected: boolean
): ReviewDispatch[] {
  const threshold = THRESHOLDS[velocity];

  return prs.map(pr => {
    let riskScore = scorePR(pr);

    // Augment with semantic scoring when available
    if (basileusConnected) {
      riskScore = augmentWithSemanticScore(riskScore, pr);
    }

    const useCodeRabbit = riskScore.score >= threshold;

    return {
      pr: pr.number,
      riskScore,
      coderabbit: useCodeRabbit,
      selfHosted: true,  // Always runs
      velocity,
      reason: useCodeRabbit
        ? `Risk ${riskScore.score.toFixed(2)} >= threshold ${threshold} (${velocity})`
        : `Risk ${riskScore.score.toFixed(2)} < threshold ${threshold} (${velocity}); self-hosted only`,
    };
  });
}
```

### Self-Hosted Review Agent

The self-hosted review agent covers findings that don't require CodeRabbit's deep analysis. It runs as a Basileus review agent (when connected) or a local teammate (when local-only).

**Review scope (replicable findings):**
- SOLID violations (per `rules/coding-standards.md`)
- TypeScript/C# style conformance (per `.coderabbit.yaml` coding guidelines)
- TDD compliance (per `rules/tdd.md`)
- Missing error handling, silent catches
- DRY violations, unnecessary complexity
- Test quality (behavior-focused naming, Arrange-Act-Assert pattern)
- Documentation gaps in public APIs

**Review scope excluded (CodeRabbit-only):**
- Security vulnerability detection (injection, XSS, CSRF, etc.)
- Cross-file semantic analysis (data flow, call chain reasoning)
- Severity classification with confidence scoring
- Pattern learning from accumulated review history

**Output format:** Self-hosted findings emit to the unified event stream as `review.finding` events, matching the event taxonomy in ADR section 7. Findings include severity (minor, medium), file path, line range, and remediation suggestion.

### Review Merge Gate

Extends the existing `coderabbit-review-gate.sh` logic to handle dual-track review results.

```
PR Review Status:
  │
  ├─ Self-hosted review:  PASS / FINDINGS / FAIL
  ├─ CodeRabbit review:   PASS / FINDINGS / SKIPPED / PENDING
  │
  ├─ Gate decision:
  │   Self-hosted PASS + CodeRabbit PASS      → APPROVED
  │   Self-hosted PASS + CodeRabbit SKIPPED   → APPROVED (low-risk, velocity-triaged)
  │   Self-hosted FINDINGS + CodeRabbit PASS  → APPROVED (minor self-hosted findings only)
  │   Self-hosted PASS + CodeRabbit FINDINGS  → WAIT (fix critical/major)
  │   Self-hosted FAIL                        → BLOCK (regardless of CodeRabbit)
  │   CodeRabbit FINDINGS (critical/major)    → BLOCK (regardless of self-hosted)
  │
  └─ Secondary escalation:
      If self-hosted agent finds severity >= medium on a PR
      that was triaged as low-risk (CodeRabbit SKIPPED):
        → Queue PR for CodeRabbit review (escalation path)
        → Emit ReviewEscalated event
```

### Event Taxonomy

New events extending the ADR section 7 taxonomy:

```typescript
type ReviewRouted = WorkflowEvent & {
  type: "review.routed";
  pr: number;
  riskScore: number;
  factors: string[];           // matched risk factor names
  destination: "coderabbit" | "self-hosted" | "both";
  velocityTier: VelocityTier;
  semanticAugmented: boolean;  // whether Basileus scoring was used
};

type ReviewFinding = WorkflowEvent & {
  type: "review.finding";
  pr: number;
  source: "coderabbit" | "self-hosted";
  severity: "critical" | "major" | "minor" | "suggestion";
  filePath: string;
  lineRange?: [number, number];
  message: string;
  rule?: string;               // e.g., "solid-srp", "missing-error-handling"
};

type ReviewEscalated = WorkflowEvent & {
  type: "review.escalated";
  pr: number;
  reason: string;              // why the low-risk PR was escalated
  originalScore: number;
  triggeringFinding: string;
};
```

### Developer Override

Consistent with the Task Router override annotations (ADR section 5.2):

| Annotation | Effect |
|---|---|
| `[coderabbit]` | Force PR through CodeRabbit regardless of triage score |
| `[self-hosted]` | Skip CodeRabbit, self-hosted only |
| `[auto]` | Use triage router (default) |

Annotations are applied as GitHub PR labels by the orchestrator during `/delegate` or `/synthesize`.

## Integration Points

### Existing Components

| Component | Integration | Changes |
|---|---|---|
| **Task Router** (ADR §5) | Review triage follows the same score-based pattern. Shares `VelocityTier` detection. | None — parallel extension, not modification |
| **`.coderabbit.yaml`** | `coding_guidelines` and `path_instructions` reused as self-hosted agent review criteria | None |
| **`coderabbit-review-gate.sh`** | Extended to handle `SKIPPED` state for velocity-triaged PRs | Add `--allow-skipped` flag for low-risk PRs |
| **`check-coderabbit.sh`** | Pre-merge gate remains unchanged — checks final approval state | None |
| **Review skill** (`/review`) | Invokes triage router before dispatching review agents | Add triage step before existing review logic |
| **Synthesis skill** (`/synthesize`) | Respects triage decisions; doesn't re-request CodeRabbit for skipped PRs | Check `ReviewRouted` events before manual CR triggers |
| **Unified Event Stream** (ADR §7) | New event types (`review.routed`, `review.finding`, `review.escalated`) | Add to event schema |

### Basileus Knowledge System

| Component | Integration | Availability |
|---|---|---|
| **NLP Sidecar** | Embed PR diff summaries for vector search | Phase 4 (ADR timeline) |
| **Vector Search** (`IVectorSearchAdapter`) | Query `review-findings` collection for similar historical diffs | Phase 4 |
| **Cohere Rerank** | Rerank vector results by relevance to current PR | Phase 4 |
| **`review-findings` collection** | New vector collection; populated by scraping CodeRabbit review history | Phase 4 (new) |

### CodeRabbit Configuration

To support selective review during high velocity, two mechanisms are available:

1. **Label-based gating:** Add a `skip-coderabbit` label to low-risk PRs. Configure CodeRabbit to skip PRs with this label via `auto_review.ignore_labels`.
2. **Path-scoped disabling:** Not viable — CodeRabbit's path filters are static, not per-PR.

**Recommended:** Label-based gating. The triage router applies `skip-coderabbit` to low-risk PRs during elevated/high velocity. CodeRabbit's auto-review respects the label. The label is removable if escalation is triggered.

## Testing Strategy

### Unit Tests

- **Scoring function:** Parameterized tests with known diff metadata → expected risk scores
- **Velocity detection:** Mock workflow state with varying active counts → expected velocity tiers
- **Dispatch logic:** Matrix of (risk scores × velocity tiers) → expected routing decisions
- **Merge gate:** Matrix of (self-hosted result × CodeRabbit result) → expected gate decisions
- **Escalation path:** Self-hosted finding on skipped PR → CodeRabbit escalation triggered

### Integration Tests

- **End-to-end triage:** Submit a mock stack → verify correct PRs routed to each track
- **Semantic augmentation:** Mock Basileus vector response → verify score adjustment
- **Label application:** Triage router applies/removes `skip-coderabbit` label correctly

### Validation Script

```bash
scripts/verify-review-triage.sh --state-file <state> --stack <stack-name>
```

Verifies:
- All PRs in stack have a `ReviewRouted` event
- High-risk PRs were sent to CodeRabbit
- Self-hosted review ran for all PRs
- No PR merged without at least one review track completing

## Implementation Phases

> **⚠️ PHASE 4 SUPERSEDED (2026-04-11):** The architectural pivot in
> `lvlup-sw/basileus#146` moved semantic review scoring into basileus as the
> Phronesis Code Review agent. The `augmentWithSemanticScore()` stub and the
> `basileusConnected` guard documented in the Dispatch Logic section above
> are removed as of this commit (#1077). The semantic augmentation flow is
> no longer the responsibility of exarchos; see `lvlup-sw/basileus#147` for
> the replacement. Phases 1–3 remain valid — only Phase 4 is retired. The
> `basileusConnected` parameter on `review_triage` and the `_basileusConnected`
> argument on `dispatchReviews()` were dead scaffolding and have been deleted.

| Phase | Scope | Dependency |
|---|---|---|
| **Phase 1: Deterministic Router** | Scoring function, velocity detection, dispatch logic, `ReviewRouted` events, label-based CodeRabbit gating | None — implementable now |
| **Phase 2: Self-Hosted Review Agent** | Review agent prompts, finding emission, review merge gate | Phase 1 |
| **Phase 3: Merge Gate Extension** | `coderabbit-review-gate.sh` updates, escalation path, `ReviewEscalated` events | Phase 2 |
| **~~Phase 4: Semantic Augmentation~~** | ~~Basileus vector search integration, Cohere rerank, `review-findings` collection~~ — **superseded, see note above** | ~~Basileus Phase 4 (ADR timeline)~~ |

## Open Questions

1. **CodeRabbit label support:** Does CodeRabbit respect `ignore_labels` for skipping auto-review on specific PRs? Needs verification against their docs. If not, the alternative is temporarily disabling auto-review via API and re-enabling per-PR.

2. **Historical finding corpus:** How far back should we scrape CodeRabbit review history for the `review-findings` vector collection? Recommendation: 90 days or 500 findings, whichever is larger, with periodic refresh.

3. **Self-hosted agent model:** Should self-hosted review agents use Sonnet (faster, cheaper) or Opus (deeper reasoning)? The ADR already defines `reviewer` role as Sonnet. Recommend starting with Sonnet and evaluating finding quality.

4. **Velocity tier calibration:** The initial thresholds (normal: 0.0, elevated: 0.3, high: 0.5) are estimates. Should be tuned based on observed CodeRabbit queue depth vs. wall-clock review completion times after deployment.
